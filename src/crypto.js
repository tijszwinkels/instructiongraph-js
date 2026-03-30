/**
 * ECDSA P-256 crypto operations using Web Crypto API.
 * Handles signature format bridging (P1363 ↔ DER) for interop with OpenSSL/hub.
 */

import { canonicalJSON } from './canonical.js'
import { base64urlEncode, bytesToBase64, base64Decode } from './encoding.js'
import { compressFromJwk, decompressToJwk } from './ec.js'

const subtle = globalThis.crypto.subtle

// Re-export encoding helpers that are part of the public API
export { base64urlEncode, base64urlDecode } from './encoding.js'

// ─── Signature format conversion ─────────────────────────────────

/**
 * Convert IEEE P1363 signature (r‖s, 64 bytes) to DER format.
 * Web Crypto produces P1363; OpenSSL/hub expect DER.
 */
export function p1363ToDer(sig) {
  const r = sig.slice(0, 32)
  const s = sig.slice(32, 64)

  function encInt(bytes) {
    let i = 0
    while (i < bytes.length - 1 && bytes[i] === 0) i++
    const trimmed = bytes.slice(i)
    if (trimmed[0] & 0x80) {
      const padded = new Uint8Array(trimmed.length + 1)
      padded.set(trimmed, 1)
      return padded
    }
    return trimmed
  }

  const rDer = encInt(r)
  const sDer = encInt(s)
  const inner = new Uint8Array(2 + rDer.length + 2 + sDer.length)
  let o = 0
  inner[o++] = 0x02; inner[o++] = rDer.length; inner.set(rDer, o); o += rDer.length
  inner[o++] = 0x02; inner[o++] = sDer.length; inner.set(sDer, o)

  const der = new Uint8Array(2 + inner.length)
  der[0] = 0x30
  der[1] = inner.length
  der.set(inner, 2)
  return der
}

/**
 * Convert DER-encoded signature to IEEE P1363 (r‖s, 64 bytes).
 */
function derToP1363(der) {
  let pos = 2
  if (der[0] !== 0x30) throw new Error('Invalid DER: expected SEQUENCE')

  pos++ // skip 0x02
  const rLen = der[pos++]
  const rBytes = der.slice(pos, pos + rLen)
  pos += rLen

  pos++ // skip 0x02
  const sLen = der[pos++]
  const sBytes = der.slice(pos, pos + sLen)

  function padTo32(bytes) {
    if (bytes.length === 32) return bytes
    if (bytes.length > 32) return bytes.slice(bytes.length - 32)
    const padded = new Uint8Array(32)
    padded.set(bytes, 32 - bytes.length)
    return padded
  }

  const result = new Uint8Array(64)
  result.set(padTo32(rBytes), 0)
  result.set(padTo32(sBytes), 32)
  return result
}

// ─── Key generation ──────────────────────────────────────────────

/**
 * Generate a new ECDSA P-256 keypair.
 * @param {object} [opts]
 * @param {boolean} [opts.extractable=false] - set true if you need to export the private key (e.g. to PEM)
 * @returns {Promise<{ pubkey: string, privateKey: CryptoKey }>}
 */
export async function generateKeypair({ extractable = false } = {}) {
  const kp = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign']
  )
  const jwk = await subtle.exportKey('jwk', kp.privateKey)
  const pubkey = compressFromJwk(jwk.x, jwk.y)

  delete jwk.key_ops
  delete jwk.ext
  const privateKey = await subtle.importKey(
    'jwk', jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    extractable,
    ['sign']
  )
  return { pubkey, privateKey }
}

/**
 * Export the compressed pubkey from a CryptoKey.
 * @param {CryptoKey} privateKey - must be extractable
 * @returns {Promise<string>} compressed pubkey, base64url
 */
export async function exportCompressedPubkey(privateKey) {
  const jwk = await subtle.exportKey('jwk', privateKey)
  return compressFromJwk(jwk.x, jwk.y)
}

// ─── Sign ────────────────────────────────────────────────────────

/**
 * Sign an item with ECDSA P-256. Returns base64 DER signature.
 * @param {CryptoKey} privateKey
 * @param {object} item
 * @returns {Promise<string>} base64 DER signature
 */
export async function sign(privateKey, item) {
  const canonical = canonicalJSON(item)
  const encoded = new TextEncoder().encode(canonical)
  const sigBuf = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    privateKey,
    encoded
  )
  const der = p1363ToDer(new Uint8Array(sigBuf))
  return bytesToBase64(der)
}

// ─── Verify ──────────────────────────────────────────────────────

/**
 * Verify an ECDSA P-256 signature. Accepts base64 DER signatures.
 * @param {string} pubkeyB64url - compressed pubkey (44 chars)
 * @param {string} signatureB64 - base64 DER signature
 * @param {object} item
 * @returns {Promise<boolean>}
 */
export async function verify(pubkeyB64url, signatureB64, item) {
  try {
    const { x, y } = decompressToJwk(pubkeyB64url)
    const publicKey = await subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x, y },
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify']
    )

    const derSig = base64Decode(signatureB64)
    const p1363Sig = derToP1363(derSig)

    const canonical = canonicalJSON(item)
    const encoded = new TextEncoder().encode(canonical)

    return await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      publicKey,
      p1363Sig,
      encoded
    )
  } catch {
    return false
  }
}
