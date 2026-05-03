/**
 * HiveLens — Express 5 application
 *
 * Fleet observability surface for institutional callers.
 * Real rails only: x402 (Base USDC) + MPP (Tempo USDCe).
 * Every paid response is a JCS-canonical Ed25519-signed envelope.
 *
 * Service DID: did:hive:hivelens
 * Treasury: 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e
 */

import express from 'express';
import x402Middleware from './middleware/x402.js';
import mppMiddleware  from './middleware/mpp.js';
import lensRouter     from './routes/lens.js';
import { smashProvMiddleware, getPubkeyInfo as getProvPubkeyInfo, verifyProvSig } from './lib/prov.js';
import { checkUpstreams } from './lib/upstream.js';
import { getSignerKey, bytesToBase64url, ISSUER_DID } from './lib/sign.js';

const app = express();
app.use(express.json());

// ── smash.prov middleware (BEFORE paywall) ─────────────────────────────────
app.use(smashProvMiddleware);

// ── /v1/prov routes (free, never paywalled) ─────────────────────────────────
app.get('/v1/prov/pubkey', async (_req, res) => {
  try { res.json(await getProvPubkeyInfo()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/v1/prov/verify', async (req, res) => {
  try {
    const { method, path: p, body_b64u = '', ts, sig_b64u } = req.body || {};
    if (!method || !p || ts == null || !sig_b64u) return res.status(400).json({ error: 'missing fields' });
    res.json(await verifyProvSig({ method, path: p, body_b64u, ts, sig_b64u }));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── /health ─────────────────────────────────────────────────
// Free. Liveness + upstream connectivity.

app.get('/health', async (req, res) => {
  const upstreams = await checkUpstreams();
  const allUp = Object.values(upstreams).every(v => v === 'up');
  return res.status(allUp ? 200 : 207).json({
    service:     'hivelens',
    version:     '0.1.0',
    status:      allUp ? 'ok' : 'degraded',
    upstreams,
    treasury:    '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
    rails:       ['x402', 'mpp'],
    issuer_did:  ISSUER_DID,
    timestamp:   new Date().toISOString(),
  });
});

// ─── /openapi.json ───────────────────────────────────────────
// Free. MPPScan discovery + x-mpp block.

app.get('/openapi.json', async (req, res) => {
  const { pubKey } = await getSignerKey();
  const pubkeyHex  = Buffer.from(pubKey).toString('hex');

  const spec = {
    openapi: '3.1.0',
    info: {
      title:       'HiveLens',
      version:     '0.1.0',
      description: 'Fleet observability surface for institutional callers. Read-through over Hive Civilization fleet data. Real rails only.',
      contact: {
        name:  'Hive Civilization',
        email: 'steve@thehiveryiq.com',
        url:   'https://hivelens.onrender.com',
      },
      license: { name: 'MIT' },
    },
    servers: [
      { url: 'https://hivelens.onrender.com', description: 'Production' },
    ],

    // ─── x-mpp block (MPPScan discovery) ───────────────────────
    'x-mpp': {
      realm:       'hivelens.onrender.com',
      service_did: 'did:hive:hivelens',
      issuer_pubkey_hex: pubkeyHex,
      payment: {
        method:    'tempo',
        currency:  'USDCe',
        contract:  '0x20c000000000000000000000b9537d11c60e8b50',
        decimals:  6,
        recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
        network:   'tempo',
        rpc:       'https://rpc.tempo.xyz',
      },
      rails:       ['x402', 'mpp'],
      x402: {
        currency:  'USDC',
        contract:  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
        network:   'base',
        chain_id:  8453,
        recipient: '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e',
      },
      categories:   ['observability', 'compliance', 'fleet-management'],
      integration:  'first-party',
      tags: [
        'fleet-observability',
        'authenticatable',
        'hive-lens',
        'hive-civilization',
        'institutional',
        'ed25519',
        'signed-envelopes',
      ],
      pricing: [
        { path: '/v1/lens/fleet/snapshot', method: 'POST', amount: 0.50, currency: 'USDC' },
        { path: '/v1/lens/fleet/health',   method: 'POST', amount: 0.10, currency: 'USDC' },
        { path: '/v1/lens/fleet/spend',    method: 'POST', amount: 0.10, currency: 'USDC' },
        { path: '/v1/lens/agent/{did}',    method: 'GET',  amount: 0.05, currency: 'USDC' },
        { path: '/v1/lens/subscribe',      method: 'POST', amount: 2500.00, currency: 'USDC', billing_cycle: 'monthly' },
      ],
    },

    paths: {
      '/health': {
        get: {
          summary:     'Liveness check',
          operationId: 'getHealth',
          tags:        ['meta'],
          security:    [],
          responses: {
            '200': { description: 'Service healthy, all upstreams reachable' },
            '207': { description: 'Service alive, one or more upstreams degraded' },
          },
        },
      },

      '/openapi.json': {
        get: {
          summary:     'OpenAPI spec + x-mpp discovery block',
          operationId: 'getOpenApi',
          tags:        ['meta'],
          security:    [],
          responses: {
            '200': { description: 'OpenAPI 3.1 spec' },
          },
        },
      },

      '/v1/lens/pubkey': {
        get: {
          summary:     'Ed25519 issuer pubkey for offline envelope verification',
          operationId: 'getLensPubkey',
          tags:        ['auth'],
          security:    [],
          responses: {
            '200': {
              description: 'Issuer pubkey (hex + base64url)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      issuer:      { type: 'string' },
                      algorithm:   { type: 'string' },
                      pubkey_b64u: { type: 'string' },
                      pubkey_hex:  { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },

      '/v1/lens/fleet/snapshot': {
        post: {
          summary:     'Fleet snapshot — per-agent trust + pulse + credential status',
          operationId: 'postFleetSnapshot',
          tags:        ['fleet'],
          'x-price-usdc': 0.50,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    fleet_id:   { type: 'string' },
                    agent_dids: { type: 'array', items: { type: 'string' }, minItems: 1 },
                  },
                  required: ['agent_dids'],
                },
              },
            },
          },
          responses: {
            '200': { description: 'Signed fleet snapshot envelope' },
            '402': { description: 'Payment required — x402 or MPP' },
          },
        },
      },

      '/v1/lens/fleet/health': {
        post: {
          summary:     'Fleet health — aggregate beats + dropped agents (last 5 min)',
          operationId: 'postFleetHealth',
          tags:        ['fleet'],
          'x-price-usdc': 0.10,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    agent_dids: { type: 'array', items: { type: 'string' }, minItems: 1 },
                  },
                  required: ['agent_dids'],
                },
              },
            },
          },
          responses: {
            '200': { description: 'Signed fleet health envelope' },
            '402': { description: 'Payment required' },
          },
        },
      },

      '/v1/lens/fleet/spend': {
        post: {
          summary:     'Fleet spend — payment-event aggregation from hive-receipt',
          operationId: 'postFleetSpend',
          tags:        ['fleet'],
          'x-price-usdc': 0.10,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    agent_dids: { type: 'array', items: { type: 'string' }, minItems: 1 },
                    since_iso:  { type: 'string', format: 'date-time' },
                  },
                  required: ['agent_dids'],
                },
              },
            },
          },
          responses: {
            '200': { description: 'Signed spend aggregation envelope' },
            '402': { description: 'Payment required' },
          },
        },
      },

      '/v1/lens/agent/{did}': {
        get: {
          summary:     'Single-agent observability snapshot',
          operationId: 'getAgentSnapshot',
          tags:        ['agent'],
          'x-price-usdc': 0.05,
          parameters: [
            {
              name: 'did', in: 'path', required: true,
              schema: { type: 'string' },
              description: 'Agent DID (URL-encoded)',
            },
          ],
          responses: {
            '200': { description: 'Signed single-agent snapshot envelope' },
            '402': { description: 'Payment required' },
          },
        },
      },

      '/v1/lens/subscribe': {
        post: {
          summary:     'Fleet subscription intent ($2,500 USDC/mo — Stripe wiring TODO)',
          operationId: 'postSubscribe',
          tags:        ['billing'],
          'x-price-usdc': 2500.00,
          'x-billing-cycle': 'monthly',
          'x-todo': 'Stripe webhook wiring required before billing goes live',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    fleet_id:      { type: 'string' },
                    contact_email: { type: 'string', format: 'email' },
                  },
                  required: ['fleet_id', 'contact_email'],
                },
              },
            },
          },
          responses: {
            '402': { description: 'Payment required — returns Stripe checkout URL placeholder' },
            '400': { description: 'Invalid request body' },
          },
        },
      },
    },

    components: {
      securitySchemes: {
        x402: {
          type:        'apiKey',
          in:          'header',
          name:        'X-Payment-Hash',
          description: 'On-chain USDC transaction hash (Base, chain ID 8453)',
        },
        mpp: {
          type:        'apiKey',
          in:          'header',
          name:        'Payment',
          description: 'MPP payment credential: Payment: scheme="mpp", tx_hash="0x...", rail="tempo", amount="<amount>"',
        },
        internal: {
          type:        'apiKey',
          in:          'header',
          name:        'X-Hive-Internal-Key',
          description: 'Internal service key (server-side bypass, not for external callers)',
        },
      },
    },

    security: [{ x402: [] }, { mpp: [] }],
  };

  return res.json(spec);
});

// ─── Payment middleware on /v1 ────────────────────────────────
// x402 runs first (handles Base USDC); MPP runs second (handles Tempo USDCe).
// Either rail satisfies payment — next() propagates to routes.

app.use('/v1', x402Middleware, mppMiddleware);

// ─── Routes ──────────────────────────────────────────────────

app.use('/v1/lens', lensRouter);

// ─── 404 handler ─────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({
    error: 'Not found',
    code:  'NOT_FOUND',
    path:  req.path,
  });
});


// ═══════════════════════════════════════════════════════════════════════════════
// SLIPPERY-STICKY DOORS — doctrine: never closed, always navigable
// Paths: /llms.txt /robots.txt /sitemap.xml /.well-known/agent.json
//        /favicon.ico / (root JSON)  +  catch-all breadcrumb (200 not 404)
// ═══════════════════════════════════════════════════════════════════════════════

const _DOORS_HOST = process.env.RENDER_EXTERNAL_URL || 'https://hivelens.onrender.com';
const _DOORS_ONBOARD = 'https://thehiveryiq.com/onboard.html';
const _TREASURY = '0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E';

// ── /llms.txt ─────────────────────────────────────────────────────────────────
app.get('/llms.txt', (req, res) => {
  res.type('text/plain; charset=utf-8').send(`# HiveLens
> Fleet observability and audit-replay: signed health snapshots, heartbeat aggregation, dropped-agent detection.

## What this is
HiveLens is part of the Hive Civilization federation — a network of agent-facing
microservices built for autonomous AI agents. Every public surface is navigable
without a DID. Paid surfaces return a 402 with \`amount_min_usd\` — the floor price.
Submit any value >= that floor. No ceiling enforced server-side.

## Auth model
- Free: GET /health, /openapi.json, /llms.txt, /robots.txt, /sitemap.xml, /.well-known/*
- Paid (x402 USDC on Base): all /v1/lens/* endpoints
- Read-mostly: no write endpoints exposed publicly
- x402 settles to treasury on Base in USDC or USDT
- MPP rail (Tempo USDCe) also accepted
- Every paid response is a JCS-canonical Ed25519-signed envelope

## Key endpoints
- GET  /health                          — liveness + upstream check (free)
- POST /v1/lens/fleet/health            — signed fleet health snapshot, $0.10 USDC (x402)
- POST /v1/lens/fleet/snapshot          — full fleet snapshot, $0.50 USDC (x402)
- POST /v1/lens/audit/replay            — historical audit replay (x402)
- POST /v1/lens/agent/heartbeat         — per-agent heartbeat query (x402)
- GET  /openapi.json                    — OpenAPI 3.1 spec with x402 pricing (free)

## Sister services
- HiveBank  (vaults + payments):  https://hivebank.onrender.com/llms.txt
- HiveGate  (auth + onboarding):  https://hivegate.onrender.com/llms.txt
- HiveOrigin (routing + egress):  https://hiveorigin.onrender.com/llms.txt
- HiveMorph (morphing + attest):  https://hivemorph.onrender.com/llms.txt
- HiveTrust (KYA + trust):        https://hivetrust.onrender.com/llms.txt
- HiveAttest MCP:                 https://hive-mcp-attest.onrender.com/llms.txt

## Hive Civilization context
Treasury: 0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E (Base USDC/USDT)
Solana: canonical Solana treasury address (see /.well-known/hive-payments.json)
x402 barter floor: 402 envelope returns \`amount_min_usd\` — submit >= that value
BOGO: first DID free, 6th paid call on the house (\`x-hive-did\` header to claim)
Contact / onboard: https://thehiveryiq.com/onboard.html
Patent: USPTO Provisional 64/055,601

## License + brand
License: MIT
Brand color: gold #FFB800
Last updated: 2026-05-02
`);
});

// ── /robots.txt ───────────────────────────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  const host = req.hostname ? `https://${req.hostname}` : _DOORS_HOST;
  res.type('text/plain; charset=utf-8').send(
    `User-agent: *\nAllow: /\nSitemap: ${host}/sitemap.xml\n\n` +
    `# Hive Civilization — slippery-sticky: every door is open\n` +
    `# Autonomous agents welcome. See /llms.txt for full API guide.\n` +
    `# Onboard: https://thehiveryiq.com/onboard.html\n`
  );
});

// ── /sitemap.xml ──────────────────────────────────────────────────────────────
app.get('/sitemap.xml', (req, res) => {
  const host = req.hostname ? `https://${req.hostname}` : _DOORS_HOST;
  const today = new Date().toISOString().slice(0,10);
  res.type('application/xml; charset=utf-8').send(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${host}/</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>1.0</priority></url>
  <url><loc>${host}/health</loc><lastmod>${today}</lastmod><changefreq>always</changefreq><priority>0.9</priority></url>
  <url><loc>${host}/openapi.json</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>${host}/llms.txt</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.9</priority></url>
  <url><loc>${host}/.well-known/agent.json</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>
  <url><loc>${host}/.well-known/mcp.json</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>
</urlset>`);
});

// ── /.well-known/agent.json (A2A discovery — only if not already defined) ────
if (!app._router || !app._router.stack.some(l => l.route && l.route.path === '/.well-known/agent.json')) {
  app.get('/.well-known/agent.json', (req, res) => {
    const host = req.hostname ? `https://${req.hostname}` : _DOORS_HOST;
    res.json({
      name: 'hivelens',
      description: 'Fleet observability and audit-replay: signed health snapshots, heartbeat aggregation, dropped-agent detection.',
      url: host,
      contact: _DOORS_ONBOARD,
      did: 'did:hive:hivelens',
      capabilities: ['mcp', 'x402-payments', 'usdc', 'agent-to-agent'],
      paywall: { protocol: 'x402', treasury: _TREASURY, hint: 'See /llms.txt for barter floor details' },
      onboard: _DOORS_ONBOARD,
      llms_txt: `${host}/llms.txt`,
      openapi: `${host}/openapi.json`,
      health: `${host}/health`,
      brand: { color: '#FFB800', name: 'Hive Civilization' },
    });
  });
}

// ── /favicon.ico — 1x1 Hive gold pixel ───────────────────────────────────────
app.get('/favicon.ico', (req, res) => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
  res.status(200).set({ 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }).end(png);
});

// ── / root — friendly JSON for agents that hit the base URL ──────────────────
// Only register if no existing root handler
if (!app._router || !app._router.stack.some(l => l.route && l.route.path === '/' && l.route.methods.get)) {
  app.get('/', (req, res) => {
    const host = req.hostname ? `https://${req.hostname}` : _DOORS_HOST;
    res.json({
      name: 'HiveLens',
      what: 'Fleet observability and audit-replay: signed health snapshots, heartbeat aggregation, dropped-agent detection.',
      for_agents: 'see /llms.txt and /openapi.json',
      onboard: _DOORS_ONBOARD,
      paywall: 'x402 — see /llms.txt',
      health: `${host}/health`,
      openapi: `${host}/openapi.json`,
      llms_txt: `${host}/llms.txt`,
      mcp: `${host}/mcp`,
    });
  });
}

// ── Catch-all — every wrong door is a lead, never a dead end ─────────────────
app.use((req, res, _next) => {
  const host = req.hostname ? `https://${req.hostname}` : _DOORS_HOST;
  res.status(200).json({
    hint: 'unknown path — but we kept the door open',
    you_asked_for: req.path,
    try: ['/llms.txt', '/openapi.json', '/health', '/', '/.well-known/agent.json'],
    onboard: _DOORS_ONBOARD,
    service: 'HiveLens',
    docs: `${host}/llms.txt`,
  });
});

// ─── Error handler ───────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error('[hivelens] unhandled error:', err.message);
  res.status(500).json({
    error: 'Internal server error',
    code:  'INTERNAL_ERROR',
  });
});

export default app;
