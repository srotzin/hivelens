/**
 * HiveLens — /v1/lens routes
 *
 * All paid responses are JCS-canonical Ed25519-signed envelopes.
 * Upstream failures degrade gracefully: null field + upstream_errors entry.
 * No mock data. No faked fields. Read-through only.
 *
 * Endpoints:
 *   GET  /pubkey                  — FREE, Ed25519 issuer pubkey
 *   POST /fleet/snapshot          — $0.50 USDC
 *   POST /fleet/health            — $0.10 USDC
 *   POST /fleet/spend             — $0.10 USDC
 *   GET  /agent/:did              — $0.05 USDC
 *   POST /subscribe               — $2,500 USDC/mo (v0.1 scaffold, Stripe TODO)
 */

import { Router } from 'express';
import { signEnvelope, getSignerKey, bytesToBase64url, ISSUER_DID } from '../lib/sign.js';
import { emitReceipt } from '../lib/receipt.js';
import {
  getTrustScore,
  getCredentialStatus,
  getTrustLookup,
  getAgentPulse,
  getSensorPulse,
  getAgentPulseHistory,
  getPaymentEvents,
} from '../lib/upstream.js';

const router = Router();

// ─── Subscription intent store (in-memory, v0.1) ─────────────
// TODO: Replace with Postgres for production persistence.
const subscriptions = new Map();

// ─── Helpers ─────────────────────────────────────────────────

function requirePayment(req, res) {
  if (!req.paymentVerified) {
    res.status(402).json({
      success: false,
      error:   'Payment required',
      code:    'PAYMENT_REQUIRED',
    });
    return false;
  }
  return true;
}

function pulseDropped(beat) {
  if (!beat) return true;
  const ts = beat.timestamp || beat.created_at || beat.updated_at;
  if (!ts) return true;
  return Date.now() - new Date(ts).getTime() > 5 * 60 * 1000;
}

// ─── GET /pubkey ──────────────────────────────────────────────
// Free. Returns Ed25519 pubkey for offline verification of signed envelopes.

router.get('/pubkey', async (req, res) => {
  try {
    const { pubKey } = await getSignerKey();
    return res.json({
      issuer:       ISSUER_DID,
      algorithm:    'Ed25519',
      pubkey_b64u:  bytesToBase64url(pubKey),
      pubkey_hex:   Buffer.from(pubKey).toString('hex'),
      usage:        'Verify JCS-canonical Ed25519 signatures on all paid HiveLens responses.',
      verify_steps: [
        '1. Fetch this pubkey',
        '2. Canonicalize envelope via JCS (RFC 8785)',
        '3. Base64url-decode signature_b64u from proof',
        '4. ed25519.verify(signature, canonicalBytes, pubkey)',
      ],
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─── POST /fleet/snapshot ─────────────────────────────────────
// $0.50 USDC
// Body: { fleet_id?, agent_dids: [string] }
// Returns: signed envelope with per-agent { trust_score, latest_pulse, credential_status }

router.post('/fleet/snapshot', async (req, res) => {
  if (!requirePayment(req, res)) return;

  const { fleet_id, agent_dids } = req.body || {};
  if (!Array.isArray(agent_dids) || agent_dids.length === 0) {
    return res.status(400).json({
      success: false,
      error:   'agent_dids must be a non-empty array',
      code:    'INVALID_REQUEST',
    });
  }

  const upstream_errors = [];
  const agents = [];

  await Promise.all(agent_dids.map(async (did) => {
    const [trust, pulse, sensorPulse, cred] = await Promise.all([
      getTrustScore(did),
      getAgentPulse(did),
      getSensorPulse(did),
      getCredentialStatus(did),
    ]);

    if (trust.error)       upstream_errors.push({ did, field: 'trust_score',        error: trust.error });
    if (pulse.error)       upstream_errors.push({ did, field: 'latest_pulse',        error: pulse.error });
    if (sensorPulse.error) upstream_errors.push({ did, field: 'sensor_pulse',        error: sensorPulse.error });
    if (cred.error)        upstream_errors.push({ did, field: 'credential_status',   error: cred.error });

    // Merge pulse sources (prefer hive-pulse, fall back to sensor)
    const latestPulse = pulse.data || sensorPulse.data || null;

    agents.push({
      did,
      trust_score:        trust.data         || null,
      latest_pulse:       latestPulse,
      credential_status:  cred.data          || null,
    });
  }));

  const payload = {
    version:          'hivelens/fleet-snapshot/v1',
    fleet_id:         fleet_id || null,
    agent_count:      agents.length,
    agents,
    upstream_errors:  upstream_errors.length ? upstream_errors : undefined,
    generated_at:     new Date().toISOString(),
  };

  const signed = await signEnvelope(payload);

  emitReceipt({
    path:         '/v1/lens/fleet/snapshot',
    amount:       0.50,
    eventType:    'lens.fleet.snapshot',
    refId:        fleet_id || agent_dids[0],
    paymentMethod: req.paymentMethod,
  });

  return res.json({ success: true, ...signed });
});

// ─── POST /fleet/health ───────────────────────────────────────
// $0.10 USDC
// Body: { agent_dids: [string] }
// Returns: aggregate health metrics (beats per agent, dropped in last 5 min)

router.post('/fleet/health', async (req, res) => {
  if (!requirePayment(req, res)) return;

  const { agent_dids } = req.body || {};
  if (!Array.isArray(agent_dids) || agent_dids.length === 0) {
    return res.status(400).json({
      success: false,
      error:   'agent_dids must be a non-empty array',
      code:    'INVALID_REQUEST',
    });
  }

  const upstream_errors = [];
  const agentHealth     = [];
  let   droppedCount    = 0;

  await Promise.all(agent_dids.map(async (did) => {
    const [pulseRes, historyRes] = await Promise.all([
      getAgentPulse(did),
      getAgentPulseHistory(did, 20),
    ]);

    if (pulseRes.error)   upstream_errors.push({ did, field: 'pulse',   error: pulseRes.error });
    if (historyRes.error) upstream_errors.push({ did, field: 'history', error: historyRes.error });

    const latestBeat = pulseRes.data || null;
    const dropped    = pulseDropped(latestBeat);
    if (dropped) droppedCount++;

    const history = historyRes.data;
    const beatCount = Array.isArray(history)
      ? history.length
      : (history?.beats?.length ?? (history?.count ?? null));

    agentHealth.push({
      did,
      status:          dropped ? 'dropped' : 'alive',
      latest_beat_at:  latestBeat?.timestamp || latestBeat?.created_at || null,
      beats_in_window: beatCount,
      dropped,
    });
  }));

  const payload = {
    version:         'hivelens/fleet-health/v1',
    window_minutes:  5,
    agent_count:     agent_dids.length,
    dropped_count:   droppedCount,
    alive_count:     agent_dids.length - droppedCount,
    agents:          agentHealth,
    upstream_errors: upstream_errors.length ? upstream_errors : undefined,
    generated_at:    new Date().toISOString(),
  };

  const signed = await signEnvelope(payload);

  emitReceipt({
    path:          '/v1/lens/fleet/health',
    amount:        0.10,
    eventType:     'lens.fleet.health',
    refId:         agent_dids[0],
    paymentMethod: req.paymentMethod,
  });

  return res.json({ success: true, ...signed });
});

// ─── POST /fleet/spend ────────────────────────────────────────
// $0.10 USDC
// Body: { agent_dids: [string], since_iso: string }
// Returns: payment-event aggregation from hive-receipt

router.post('/fleet/spend', async (req, res) => {
  if (!requirePayment(req, res)) return;

  const { agent_dids, since_iso } = req.body || {};
  if (!Array.isArray(agent_dids) || agent_dids.length === 0) {
    return res.status(400).json({
      success: false,
      error:   'agent_dids must be a non-empty array',
      code:    'INVALID_REQUEST',
    });
  }

  if (since_iso && isNaN(Date.parse(since_iso))) {
    return res.status(400).json({
      success: false,
      error:   'since_iso must be a valid ISO 8601 timestamp',
      code:    'INVALID_REQUEST',
    });
  }

  const upstream_errors = [];
  const agentSpend      = [];
  let   totalUsd        = 0;
  let   totalCount      = 0;
  const byEndpoint      = {};

  await Promise.all(agent_dids.map(async (did) => {
    const result = await getPaymentEvents(did, since_iso || null);
    if (result.error) {
      upstream_errors.push({ did, field: 'payment_events', error: result.error });
      agentSpend.push({ did, event_count: null, total_usd: null, by_endpoint: null });
      return;
    }

    const events = Array.isArray(result.data)
      ? result.data
      : (result.data?.events || result.data?.receipts || []);

    let agentTotal = 0;
    let agentCount = 0;
    const agentByEndpoint = {};

    for (const ev of events) {
      const amt = parseFloat(ev.amount_usd || ev.amount || 0);
      const ep  = ev.endpoint || 'unknown';
      agentTotal += amt;
      agentCount++;
      agentByEndpoint[ep] = (agentByEndpoint[ep] || 0) + amt;
      byEndpoint[ep]      = (byEndpoint[ep]      || 0) + amt;
    }

    totalUsd   += agentTotal;
    totalCount += agentCount;

    agentSpend.push({
      did,
      event_count:  agentCount,
      total_usd:    Math.round(agentTotal * 1e6) / 1e6,
      by_endpoint:  agentByEndpoint,
    });
  }));

  const payload = {
    version:         'hivelens/fleet-spend/v1',
    since_iso:       since_iso || null,
    agent_count:     agent_dids.length,
    total_event_count: totalCount,
    total_usd:       Math.round(totalUsd * 1e6) / 1e6,
    by_endpoint:     byEndpoint,
    agents:          agentSpend,
    upstream_errors: upstream_errors.length ? upstream_errors : undefined,
    generated_at:    new Date().toISOString(),
  };

  const signed = await signEnvelope(payload);

  emitReceipt({
    path:          '/v1/lens/fleet/spend',
    amount:        0.10,
    eventType:     'lens.fleet.spend',
    refId:         agent_dids[0],
    paymentMethod: req.paymentMethod,
  });

  return res.json({ success: true, ...signed });
});

// ─── GET /agent/:did ─────────────────────────────────────────
// $0.05 USDC
// Single-agent observability snapshot: trust + pulse + last-receipt

router.get('/agent/:did', async (req, res) => {
  if (!requirePayment(req, res)) return;

  const did = decodeURIComponent(req.params.did);
  const upstream_errors = [];

  const [trustRes, pulseRes, sensorRes, receiptRes] = await Promise.all([
    getTrustScore(did),
    getAgentPulse(did),
    getSensorPulse(did),
    getPaymentEvents(did, null),
  ]);

  if (trustRes.error)   upstream_errors.push({ field: 'trust_score',   error: trustRes.error });
  if (pulseRes.error)   upstream_errors.push({ field: 'latest_pulse',  error: pulseRes.error });
  if (sensorRes.error)  upstream_errors.push({ field: 'sensor_pulse',  error: sensorRes.error });
  if (receiptRes.error) upstream_errors.push({ field: 'last_receipt',  error: receiptRes.error });

  const latestPulse = pulseRes.data || sensorRes.data || null;

  // Extract last receipt event
  let lastReceipt = null;
  if (receiptRes.data) {
    const events = Array.isArray(receiptRes.data)
      ? receiptRes.data
      : (receiptRes.data?.events || receiptRes.data?.receipts || []);
    if (events.length > 0) {
      lastReceipt = events[events.length - 1];
    }
  }

  const payload = {
    version:         'hivelens/agent-snapshot/v1',
    did,
    trust_score:     trustRes.data     || null,
    latest_pulse:    latestPulse,
    last_receipt:    lastReceipt,
    upstream_errors: upstream_errors.length ? upstream_errors : undefined,
    generated_at:    new Date().toISOString(),
  };

  const signed = await signEnvelope(payload);

  emitReceipt({
    path:          '/v1/lens/agent/:did',
    amount:        0.05,
    eventType:     'lens.agent.snapshot',
    refId:         did,
    paymentMethod: req.paymentMethod,
  });

  return res.json({ success: true, ...signed });
});

// ─── POST /subscribe ─────────────────────────────────────────
// $2,500 USDC/mo (pricing scaffold — no live billing in v0.1)
// Body: { fleet_id, contact_email }
// Returns 402 with Stripe-checkout URL placeholder if no payment proof.
//
// TODO: Wire Stripe webhook. Replace in-memory Map with Postgres.
// TODO: Verify proof of $2,500 USDC/mo payment before activating subscription.

router.post('/subscribe', async (req, res) => {
  const { fleet_id, contact_email } = req.body || {};

  if (!fleet_id || !contact_email) {
    return res.status(400).json({
      success: false,
      error:   'fleet_id and contact_email are required',
      code:    'INVALID_REQUEST',
    });
  }

  // v0.1: always return 402 with Stripe placeholder — no live billing yet
  // TODO (Stripe wiring): Check payment proof, activate subscription, store to Postgres.

  const existing = subscriptions.get(fleet_id);
  const intent = {
    fleet_id,
    contact_email,
    recorded_at:  existing?.recorded_at || new Date().toISOString(),
    updated_at:   new Date().toISOString(),
    status:       'pending_payment',
  };
  subscriptions.set(fleet_id, intent);

  return res.status(402).json({
    success:  false,
    error:    'Payment required to activate fleet subscription',
    code:     'SUBSCRIPTION_PAYMENT_REQUIRED',
    todo:     'Stripe billing not yet wired. This is a v0.1 scaffold.',
    pricing: {
      amount:        2500.00,
      currency:      'USDC',
      billing_cycle: 'monthly',
      description:   'HiveLens fleet observability — institutional tier',
    },
    // TODO: Replace with real Stripe checkout session URL
    checkout_url: 'https://checkout.stripe.com/c/pay/TODO_STRIPE_SESSION',
    intent_recorded: true,
    intent,
    rails_accepted: ['x402', 'mpp', 'stripe'],
    contact: 'steve@thehiveryiq.com',
  });
});

export default router;
