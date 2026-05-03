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
import { checkUpstreams } from './lib/upstream.js';
import { getSignerKey, bytesToBase64url, ISSUER_DID } from './lib/sign.js';

const app = express();
app.use(express.json());

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

// ─── Error handler ───────────────────────────────────────────

app.use((err, req, res, _next) => {
  console.error('[hivelens] unhandled error:', err.message);
  res.status(500).json({
    error: 'Internal server error',
    code:  'INTERNAL_ERROR',
  });
});

// ─── /llms.txt — agent discovery (llmstxt.org convention) ────────────────────
app.get('/llms.txt', (req, res) => {
  res.type('text/plain; charset=utf-8').send(`# HiveLens
> Fleet observability and audit-replay surface for the Hive Civilization federation.

## What this is
HiveLens is the read-mostly observability and audit-replay service for the Hive Civilization
agent economy. It provides signed fleet health snapshots, agent heartbeat aggregation,
dropped-agent detection, and historical audit replay over the entire Hive fleet.
Every paid response is a JCS-canonical Ed25519-signed envelope for tamper-evident audit.

## Hive Civilization context
HiveLens is one node in the Hive Civilization federation — a fleet of agent-facing
microservices designed to be fully autonomous-agent navigable.
Sister services share the same x402 / MPP payment rails, the same treasury address,
and the same "Hive Civilization gold #FFB800" brand.
Service DID: did:hive:hivelens

## Auth model
- Free endpoints: GET /health, GET /openapi.json, GET /llms.txt
- x402 paywalled: all /v1/lens/* read endpoints
- x402 settles to treasury 0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E on Base in USDC or USDT
- MPP rail also accepted (Tempo USDCe on Arbitrum)
- Read-mostly: no write endpoints exposed publicly

## Counter-offer / barter floor
The 402 response envelope contains \`amount_min_usd\` — the floor price for that endpoint.
Submit any value >= \`amount_min_usd\`. No ceiling enforced server-side.
Example header: \`X-Payment: amount=0.10,currency=USDC,chain=base,to=0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E\`

## Example flow — fleet health check
1. GET /health — free liveness + upstream connectivity check
2. POST /v1/lens/fleet/health (x402, ~$0.10) — aggregate fleet beats + dropped-agent list (last 5 min)
3. Inspect signed envelope: verify Ed25519 signature with HiveLens public key from /.well-known/did.json
4. Archive the signed response for audit replay

## Example flow — audit replay
1. POST /v1/lens/audit/replay — replay a historical signed event stream by agent DID + time window
2. Verify each event's Ed25519 signature in sequence
3. Cross-reference with HiveTrust reputation scores at https://hivetrust.onrender.com

## Key endpoints
- GET  /health                        — liveness + upstream status (free)
- POST /v1/lens/fleet/health          — signed fleet health snapshot — $0.10 USDC (x402)
- POST /v1/lens/audit/replay          — historical audit replay (x402)
- POST /v1/lens/agent/heartbeat       — per-agent heartbeat query (x402)
- GET  /openapi.json                  — OpenAPI 3.1 spec with x402 pricing block

## Sister services
- HiveBank  (vaults + payments):  https://hivebank.onrender.com/llms.txt
- HiveGate  (auth + onboarding):  https://hivegate.onrender.com/llms.txt
- HiveOrigin (routing + egress):  https://hiveorigin.onrender.com/llms.txt
- HiveMorph (morphing + attest):  https://hivemorph.onrender.com/llms.txt
- HiveTrust (KYA + trust scores): https://hivetrust.onrender.com/llms.txt
- HiveAttest MCP:                 https://hive-mcp-attest.onrender.com/llms.txt
- HiveMining MCP:                 https://hive-mcp-mining.onrender.com/llms.txt

## License + brand
License: MIT
Brand color: gold #FFB800
Treasury: 0x15184Bf50B3d3F52b60434f8942b7D52F2eB436E (Base USDC/USDT)
Last updated: 2026-05-02
`);
});

export default app;
