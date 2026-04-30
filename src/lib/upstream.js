/**
 * HiveLens — Upstream HTTP clients
 *
 * All calls use 8-second timeouts. On failure: return null for the field
 * and populate upstream_errors[]. Never fake data.
 *
 * Upstreams:
 *   hivetrust.onrender.com   — trust scores, credential status
 *   hive-pulse.onrender.com  — agent pulse (REST)
 *   hivepulse-sensor.onrender.com — agent pulse (sensor endpoint)
 *   hive-receipt.onrender.com — payment events
 */

const TIMEOUT_MS = 8_000;

const HIVETRUST_BASE      = process.env.HIVETRUST_BASE      || 'https://hivetrust.onrender.com';
const HIVE_PULSE_BASE     = process.env.HIVE_PULSE_BASE     || 'https://hive-pulse.onrender.com';
const HIVEPULSE_SENSOR_BASE = process.env.HIVEPULSE_SENSOR_BASE || 'https://hivepulse-sensor.onrender.com';
const HIVE_RECEIPT_BASE   = process.env.HIVE_RECEIPT_BASE   || 'https://hive-receipt.onrender.com';

async function fetchJSON(url, opts = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    });
    clearTimeout(timer);
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, status: res.status, error: text || `HTTP ${res.status}` };
    }
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    clearTimeout(timer);
    return { ok: false, error: e.name === 'AbortError' ? 'upstream timeout (8s)' : e.message };
  }
}

// ─── HiveTrust ────────────────────────────────────────────────────────────

/**
 * GET trust score for a DID.
 * Returns { trust_score, level, ... } or null on failure.
 */
export async function getTrustScore(did) {
  const r = await fetchJSON(`${HIVETRUST_BASE}/trust/score/${encodeURIComponent(did)}`);
  if (!r.ok) return { data: null, error: r.error };
  return { data: r.data, error: null };
}

/**
 * POST /v1/credential/verify  — check credential status for a DID.
 * HiveTrust accepts { agent_id } or { did }.
 */
export async function getCredentialStatus(did) {
  // Try the canonical credential verify endpoint with agent DID as agent_id
  const r = await fetchJSON(`${HIVETRUST_BASE}/v1/credential/verify`, {
    method: 'POST',
    body: JSON.stringify({ agent_id: did }),
  });
  if (!r.ok) return { data: null, error: r.error };
  return { data: r.data, error: null };
}

/**
 * GET agent trust info (public lookup — no payment required on hivetrust side).
 */
export async function getTrustLookup(did) {
  const r = await fetchJSON(`${HIVETRUST_BASE}/trust/lookup/${encodeURIComponent(did)}`);
  if (!r.ok) return { data: null, error: r.error };
  return { data: r.data, error: null };
}

// ─── Hive Pulse ───────────────────────────────────────────────────────────

/**
 * GET latest pulse beat for an agent DID from hive-pulse.
 */
export async function getAgentPulse(did) {
  const encoded = encodeURIComponent(did);
  // Try REST API endpoint first
  const r = await fetchJSON(`${HIVE_PULSE_BASE}/v1/pulse/${encoded}`);
  if (!r.ok) return { data: null, error: r.error };
  return { data: r.data, error: null };
}

/**
 * GET latest pulse from hivepulse-sensor (sensor endpoint).
 */
export async function getSensorPulse(did) {
  const encoded = encodeURIComponent(did);
  const r = await fetchJSON(`${HIVEPULSE_SENSOR_BASE}/v1/pulse/${encoded}`);
  if (!r.ok) return { data: null, error: r.error };
  return { data: r.data, error: null };
}

/**
 * GET recent pulse beats (last N) for an agent.
 * Used for health aggregation.
 */
export async function getAgentPulseHistory(did, limit = 20) {
  const encoded = encodeURIComponent(did);
  const r = await fetchJSON(`${HIVE_PULSE_BASE}/v1/pulse/${encoded}/history?limit=${limit}`);
  if (!r.ok) return { data: null, error: r.error };
  return { data: r.data, error: null };
}

// ─── Hive Receipt ─────────────────────────────────────────────────────────

/**
 * GET payment events for a DID since a given ISO timestamp.
 */
export async function getPaymentEvents(did, sinceIso) {
  let url = `${HIVE_RECEIPT_BASE}/v1/receipt/events?agent_did=${encodeURIComponent(did)}`;
  if (sinceIso) url += `&since=${encodeURIComponent(sinceIso)}`;
  const r = await fetchJSON(url);
  if (!r.ok) return { data: null, error: r.error };
  return { data: r.data, error: null };
}

// ─── Connectivity check (for /health) ────────────────────────────────────

export async function checkUpstreams() {
  const checks = await Promise.allSettled([
    fetchJSON(`${HIVETRUST_BASE}/health`),
    fetchJSON(`${HIVE_PULSE_BASE}/health`),
    fetchJSON(`${HIVEPULSE_SENSOR_BASE}/health`),
    fetchJSON(`${HIVE_RECEIPT_BASE}/health`),
  ]);

  const names = ['hivetrust', 'hive-pulse', 'hivepulse-sensor', 'hive-receipt'];
  const result = {};

  for (let i = 0; i < names.length; i++) {
    const s = checks[i];
    if (s.status === 'fulfilled') {
      result[names[i]] = s.value.ok ? 'up' : `degraded (${s.value.status || s.value.error})`;
    } else {
      result[names[i]] = `error: ${s.reason?.message || 'unknown'}`;
    }
  }

  return result;
}
