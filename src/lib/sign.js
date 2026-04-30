/**
 * HiveLens — Ed25519 signing helpers
 *
 * Signing key derived deterministically from:
 *   process.env.LENS_SIGNING_SEED (64-char hex preferred)
 *   process.env.HIVE_INTERNAL_KEY (fallback anchor)
 *   hardcoded string (last resort for cold starts)
 *
 * Service DID: did:hive:hivelens
 */

import * as ed from '@noble/ed25519';
import { canonicalize, canonicalBytes } from './canonical.js';
import { createHash } from 'crypto';

const ISSUER_DID = 'did:hive:hivelens';

let _signerKey = null;

export async function getSignerKey() {
  if (_signerKey) return _signerKey;

  const seedHex = process.env.LENS_SIGNING_SEED;
  let privKey;

  if (seedHex && seedHex.length >= 64) {
    privKey = Uint8Array.from(Buffer.from(seedHex.slice(0, 64), 'hex'));
  } else {
    const anchor = process.env.HIVE_INTERNAL_KEY || 'hive-lens-issuer-2026';
    const seed = createHash('sha256')
      .update(anchor + '-hivelens-signing-key')
      .digest();
    privKey = Uint8Array.from(seed);
  }

  const pubKey = await ed.getPublicKeyAsync(privKey);
  _signerKey = { privKey, pubKey };
  return _signerKey;
}

export function bytesToBase64url(bytes) {
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Sign a payload object using JCS canonicalization + Ed25519.
 * Returns { envelope, proof }.
 */
export async function signEnvelope(payload) {
  const { privKey, pubKey } = await getSignerKey();
  const bytes = canonicalBytes(payload);
  const sigBytes = await ed.signAsync(bytes, privKey);

  return {
    envelope: payload,
    proof: {
      type: 'Ed25519Signature2020',
      created: new Date().toISOString(),
      verificationMethod: `${ISSUER_DID}#key-1`,
      proofPurpose: 'assertionMethod',
      jcs: canonicalize(payload),
      pubkey_b64u: bytesToBase64url(pubKey),
      signature_b64u: bytesToBase64url(sigBytes),
    },
  };
}

export { ISSUER_DID };
