# HiveLens

Fleet observability surface for institutional callers. Read-through over the
Hive Civilization data layer: trust scores, pulse beats, payment events —
aggregated per agent, signed per response.

---

## Doctrine: AUTHENTICATABLE

Every paid response is a JCS-canonical Ed25519-signed envelope. Callers verify
offline using `/v1/lens/pubkey`. No mock data. No simulated state. Upstream
failure returns a structured `upstream_error` entry — never a faked field.

Real rails only: x402 (Base USDC) and MPP (Tempo USDCe, TIP-20). Treasury:
`0x15184bf50b3d3f52b60434f8942b7d52f2eb436e`.

---

## Endpoints

| Method | Path | Price | Purpose |
|--------|------|-------|---------|
| GET | `/health` | FREE | Liveness + upstream connectivity |
| GET | `/openapi.json` | FREE | MPPScan discovery + x-mpp block |
| GET | `/v1/lens/pubkey` | FREE | Ed25519 issuer pubkey for offline verify |
| POST | `/v1/lens/fleet/snapshot` | $0.50 USDC | Per-agent trust + pulse + credential status |
| POST | `/v1/lens/fleet/health` | $0.10 USDC | Aggregate health metrics, dropped agents |
| POST | `/v1/lens/fleet/spend` | $0.10 USDC | Payment-event aggregation from hive-receipt |
| GET | `/v1/lens/agent/:did` | $0.05 USDC | Single-agent observability snapshot |
| POST | `/v1/lens/subscribe` | $2,500 USDC/mo | Subscription intent (v0.1 scaffold — Stripe TODO) |

---

## Payment Rails

**x402 (Base USDC)**
1. Send the required amount to `0x15184bf50b3d3f52b60434f8942b7d52f2eb436e` on Base (chain ID 8453)
2. Include the transaction hash in `X-Payment-Hash`
3. Retry — verification is on-chain, automatic

**MPP (Tempo USDCe, TIP-20)**
1. Send USDCe to the same treasury address on Tempo
2. Include `Payment: scheme="mpp", tx_hash="0x...", rail="tempo", amount="<amount>"`
3. Retry

---

## Data Sources

- Trust scores and credential status: `hivetrust.onrender.com`
- Agent pulse beats: `hive-pulse.onrender.com` / `hivepulse-sensor.onrender.com`
- Payment events: `hive-receipt.onrender.com`

---

## Configuration

| Variable | Purpose |
|----------|---------|
| `LENS_SIGNING_SEED` | 64-char hex seed for Ed25519 signing key |
| `HIVE_INTERNAL_KEY` | Internal bypass key (x-hive-internal-key header) |
| `PORT` | HTTP port (default 3000) |

---

## Response Format

All paid responses use a signed envelope:

```json
{
  "envelope": { ... },
  "proof": {
    "type": "Ed25519Signature2020",
    "verificationMethod": "did:hive:hivelens#key-1",
    "proofPurpose": "assertionMethod",
    "pubkey_b64u": "...",
    "signature_b64u": "..."
  }
}
```

Verify offline:
```
GET /v1/lens/pubkey  →  pubkey_b64u
canonicalize(envelope)  →  bytes
ed25519.verify(signature_b64u, bytes, pubkey_b64u)  →  true
```

---

## TODOs

- **Stripe billing**: `/v1/lens/subscribe` returns a 402 with a placeholder
  Stripe-checkout URL. Real Stripe webhook integration required before billing
  goes live.
- **Postgres persistence**: subscription intent stored in in-memory `Map`.
  Requires `DATABASE_URL` + schema migration for production.

---

## License

MIT — see [LICENSE](./LICENSE)

---

*HiveLens v0.1 — Hive Civilization fleet observability*  
*Color: #C08D23 — Voice: Bloomberg Terminal / Stripe Docs*
