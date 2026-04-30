/**
 * HiveLens — x402 Payment Middleware
 *
 * Implements the x402 protocol for machine-to-machine micropayments.
 * USDC on Base L2 (chain ID 8453). No Stripe. No human interfaces.
 *
 * Service DID: did:hive:hivelens
 * Treasury: 0x15184bf50b3d3f52b60434f8942b7d52f2eb436e
 *
 * Adapted from _canonical/x402.js — stripped of hivetrust-specific pricing
 * tables, replaced with HiveLens fee table.
 */

// ─── Configuration ───────────────────────────────────────────

const PAYMENT_ADDRESS = (
  process.env.HIVE_PAYMENT_ADDRESS ||
  '0x15184bf50b3d3f52b60434f8942b7d52f2eb436e'
).toLowerCase();

const HIVE_INTERNAL_KEY = process.env.HIVE_INTERNAL_KEY || '';
const BASE_RPC_URL      = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const USDC_CONTRACT     = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TRANSFER_TOPIC    = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

// ─── HiveLens pricing table ──────────────────────────────────

// Note: req.path under app.use('/v1', ...) has /v1 stripped.
// So paths here are relative to /v1.
const LENS_PRICING = {
  '/lens/fleet/snapshot': 0.50,
  '/lens/fleet/health':   0.10,
  '/lens/fleet/spend':    0.10,
  '/lens/subscribe':      2500.00,
};

function getLensPrice(path) {
  if (LENS_PRICING[path] !== undefined) {
    return { amount: LENS_PRICING[path], model: 'lens_fixed' };
  }
  if (path.startsWith('/lens/agent/')) {
    return { amount: 0.05, model: 'lens_agent_fixed' };
  }
  return { amount: 0.10, model: 'lens_default' };
}

// ─── Free paths ──────────────────────────────────────────────

// When mounted at /v1, req.path has the /v1 prefix stripped.
// /health and /openapi.json are mounted at app level (not under /v1).
const FREE_PATHS = new Set([
  '/lens/pubkey',
]);

function isFreePath(path) {
  return FREE_PATHS.has(path);
}

// ─── In-memory payment cache ─────────────────────────────────

const paymentCache = new Map();

// ─── On-chain USDC verification ──────────────────────────────

async function verifyPayment(hash) {
  if (!PAYMENT_ADDRESS) {
    return { valid: false, reason: 'Payment address not configured' };
  }
  try {
    const res = await fetch(BASE_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method:  'eth_getTransactionReceipt',
        params:  [hash],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const { result: receipt } = await res.json();
    if (!receipt || receipt.status !== '0x1') {
      return { valid: false, reason: 'Transaction not found or failed on Base' };
    }
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== USDC_CONTRACT.toLowerCase()) continue;
      if (log.topics[0] !== TRANSFER_TOPIC) continue;
      const recipient = '0x' + log.topics[2].slice(26).toLowerCase();
      if (recipient !== PAYMENT_ADDRESS) continue;
      const amountUsdc = parseInt(log.data, 16) / 1_000_000;
      paymentCache.set(hash, { verified: true, amount: amountUsdc, timestamp: Date.now() });
      return { valid: true, amount: amountUsdc };
    }
    return { valid: false, reason: 'No USDC transfer to HiveLens treasury found' };
  } catch (err) {
    return { valid: false, reason: `Chain verification error: ${err.message}` };
  }
}

// ─── Middleware ───────────────────────────────────────────────

export default async function x402Middleware(req, res, next) {
  if (isFreePath(req.path)) return next();

  // Internal bypass
  const internalKey = req.headers['x-hive-internal-key'] || req.headers['x-api-key'];
  if (HIVE_INTERNAL_KEY && internalKey === HIVE_INTERNAL_KEY) {
    req.paymentVerified = true;
    req.paymentMethod   = 'internal';
    return next();
  }

  const paymentHash =
    req.headers['x-payment-hash'] ||
    req.headers['x-402-tx'] ||
    req.headers['x-payment-tx'];

  if (paymentHash) {
    // Cache hit
    const cached = paymentCache.get(paymentHash);
    if (cached?.verified) {
      req.paymentVerified = true;
      req.paymentMethod   = 'x402';
      req.paymentHash     = paymentHash;
      req.paymentAmount   = cached.amount;
      return next();
    }

    const verification = await verifyPayment(paymentHash);
    if (verification.valid) {
      const price = getLensPrice(req.path);
      if (verification.amount < price.amount - 0.001) {
        return res.status(402).json({
          success: false,
          error:   'Payment amount insufficient',
          code:    'PAYMENT_INSUFFICIENT',
          details: `Paid ${verification.amount} USDC, endpoint requires ${price.amount} USDC`,
          required: price.amount,
          paid:     verification.amount,
        });
      }
      req.paymentVerified = true;
      req.paymentMethod   = 'x402';
      req.paymentHash     = paymentHash;
      req.paymentAmount   = verification.amount;
      return next();
    }

    return res.status(402).json({
      success: false,
      error:   'Payment verification failed',
      code:    'PAYMENT_INVALID',
      details: verification.reason,
      hint:    'Ensure the hash corresponds to a confirmed Base USDC transaction to the HiveLens treasury.',
    });
  }

  // No payment credential — emit 402 challenge (both rails)
  const price = getLensPrice(req.path);

  res.set('WWW-Authenticate', [
    `x402 realm="hivelens.onrender.com", amount="${price.amount}", currency="USDC", network="base", address="${PAYMENT_ADDRESS}"`,
    `Payment scheme="mpp", realm="hivelens.onrender.com", amount="${price.amount}", currency="USDC", network="tempo", address="${PAYMENT_ADDRESS}"`,
  ].join(', '));

  res.set({
    'X-Payment-Amount':   price.amount.toString(),
    'X-Payment-Currency': 'USDC',
    'X-Payment-Network':  'base',
    'X-Payment-Address':  PAYMENT_ADDRESS,
    'X-Payment-Model':    price.model,
    'X-HiveLens-Required': 'true',
    'X-HiveLens-Challenge': JSON.stringify({
      version:       '1.0',
      protocol:      'x402',
      amount:        price.amount,
      currency:      'USDC',
      network:       'base',
      chain_id:      8453,
      address:       PAYMENT_ADDRESS,
      usdc_contract: USDC_CONTRACT,
      endpoint:      req.path,
      method:        req.method,
      timestamp:     new Date().toISOString(),
      ttl_seconds:   300,
    }),
  });

  return res.status(402).json({
    success:  false,
    error:    'Payment required',
    code:     'PAYMENT_REQUIRED',
    protocol: 'x402',
    payment: {
      amount:        price.amount,
      currency:      'USDC',
      network:       'base',
      chain_id:      8453,
      address:       PAYMENT_ADDRESS,
      usdc_contract: USDC_CONTRACT,
      model:         price.model,
    },
    how_to_pay: {
      rail_x402: {
        step_1: `Send ${price.amount} USDC to ${PAYMENT_ADDRESS} on Base (chain ID 8453)`,
        step_2: 'Include the transaction hash in the X-Payment-Hash header',
        step_3: 'Retry this request — payment is verified on-chain automatically',
      },
      rail_mpp: {
        step_1: `Send ${price.amount} USDCe to ${PAYMENT_ADDRESS} on Tempo`,
        step_2: 'Include: Payment: scheme="mpp", tx_hash="0x...", rail="tempo"',
        step_3: 'Retry — MPP payment verified via Tempo RPC',
        tempo_rpc: 'https://rpc.tempo.xyz',
      },
    },
    rails_accepted: ['x402', 'mpp'],
  });
}

export { paymentCache };
