/**
 * HiveLens — Spectral receipt emitter
 *
 * Non-blocking. Every paid call emits a receipt to hive-receipt.onrender.com.
 * Failure is silently swallowed — never interrupts the fee path.
 *
 * Pattern copied from _canonical/credential.js emitReceipt().
 */

const RECEIPT_ENDPOINT = process.env.RECEIPT_HOST
  ? `${process.env.RECEIPT_HOST}/v1/receipt/sign`
  : 'https://hive-receipt.onrender.com/v1/receipt/sign';

const ISSUER_DID = 'did:hive:hivelens';
const SERVICE    = 'hivelens';

/**
 * Emit a Spectral receipt (fire-and-forget).
 *
 * @param {object} opts
 * @param {string} opts.path        - API path e.g. '/v1/lens/fleet/snapshot'
 * @param {number} opts.amount      - USDC amount
 * @param {string} opts.eventType   - e.g. 'lens.fleet.snapshot'
 * @param {string} [opts.refId]     - optional correlation ID
 * @param {string} [opts.paymentMethod] - 'x402' | 'mpp' | 'internal'
 */
export function emitReceipt({ path, amount, eventType, refId, paymentMethod }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);

  fetch(RECEIPT_ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    signal:  controller.signal,
    body: JSON.stringify({
      issuer_did:     ISSUER_DID,
      event_type:     eventType,
      amount_usd:     amount,
      currency:       'USDC',
      endpoint:       path,
      ref_id:         refId   || null,
      service:        SERVICE,
      payment_method: paymentMethod || 'x402',
      timestamp:      new Date().toISOString(),
    }),
  })
    .catch(() => {})
    .finally(() => clearTimeout(timer));
}
