/**
 * ECDSA P-256 crypto operations using Web Crypto API.
 * Handles signature format bridging (P1363 ↔ DER) for interop with OpenSSL/hub.
 */

import { canonicalJSON } from './canonical.js'

const subtle = globalThis.crypto.subtle

// ─── Encoding helpers ────────────────────────────────────────────

/** @param {Uint8Array} bytes @returns {string} base64url (no padding) */
export function base64urlEncode(bytes) {
  let b = ''
  for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i])
  return btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** @param {string} s @returns {Uint8Array} */
export function base64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** @param {Uint8Array} bytes @returns {string} standard base64 */
function bytesToBase64(bytes) {
  let b = ''
  for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i])
  return btoa(b)
}

/** @param {string} s standard base64 @returns {Uint8Array} */
function base64Decode(s) {
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

// ─── Signature format conversion ─────────────────────────────────

/**
 * Convert IEEE P1363 signature (r‖s, 64 bytes) to DER format.
 * Web Crypto produces P1363; OpenSSL/hub expect DER.
 * @param {Uint8Array} sig - 64-byte P1363 signature
 * @returns {Uint8Array} DER-encoded signature
 */
export function p1363ToDer(sig) {
  const r = sig.slice(0, 32)
  const s = sig.slice(32, 64)

  function encInt(bytes) {
    // Strip leading zeros but keep at least one byte
    let i = 0
    while (i < bytes.length - 1 && bytes[i] === 0) i++
    const trimmed = bytes.slice(i)
    // If high bit set, prepend 0x00 for positive integer
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
 * @param {Uint8Array} der
 * @returns {Uint8Array} 64-byte P1363 signature
 */
function derToP1363(der) {
  // 0x30 <len> 0x02 <rlen> <r...> 0x02 <slen> <s...>
  let pos = 2 // skip SEQUENCE tag + length
  if (der[0] !== 0x30) throw new Error('Invalid DER: expected SEQUENCE')

  pos++ // skip 0x02
  const rLen = der[pos++]
  const rBytes = der.slice(pos, pos + rLen)
  pos += rLen

  pos++ // skip 0x02
  const sLen = der[pos++]
  const sBytes = der.slice(pos, pos + sLen)

  // Pad/trim to 32 bytes each
  function padTo32(bytes) {
    if (bytes.length === 32) return bytes
    if (bytes.length > 32) return bytes.slice(bytes.length - 32) // strip leading zero
    const padded = new Uint8Array(32)
    padded.set(bytes, 32 - bytes.length)
    return padded
  }

  const result = new Uint8Array(64)
  result.set(padTo32(rBytes), 0)
  result.set(padTo32(sBytes), 32)
  return result
}

// ─── Pubkey compression ──────────────────────────────────────────

/**
 * Compress an EC P-256 public key from JWK x,y coordinates.
 * @param {string} xB64url - x coordinate, base64url
 * @param {string} yB64url - y coordinate, base64url
 * @returns {string} compressed pubkey, base64url (44 chars)
 */
function compressFromJwk(xB64url, yB64url) {
  const xBytes = base64urlDecode(xB64url)
  const yBytes = base64urlDecode(yB64url)
  // Compression: 0x02 if y is even, 0x03 if odd
  const prefix = (yBytes[yBytes.length - 1] & 1) ? 0x03 : 0x02
  const compressed = new Uint8Array(33)
  compressed[0] = prefix
  compressed.set(xBytes, 1)
  return base64urlEncode(compressed)
}

/**
 * Decompress a P-256 compressed point to JWK x,y.
 * Uses the curve equation y² = x³ + ax + b (mod p) to recover y.
 * @param {string} compressedB64url
 * @returns {{ x: string, y: string }} base64url coordinates
 */
function decompressToJwk(compressedB64url) {
  const bytes = base64urlDecode(compressedB64url)
  if (bytes.length !== 33) throw new Error(`Invalid compressed pubkey length: ${bytes.length}`)
  const prefix = bytes[0]
  if (prefix !== 0x02 && prefix !== 0x03) throw new Error(`Invalid compression prefix: 0x${prefix.toString(16)}`)

  const xBytes = bytes.slice(1)

  // P-256 parameters
  const p = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFFn
  const a = p - 3n
  const b = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604Bn

  const x = bytesToBigInt(xBytes)
  const rhs = (modPow(x, 3n, p) + a * x % p + b) % p
  // Tonelli-Shanks not needed for p ≡ 3 mod 4: y = rhs^((p+1)/4)
  let y = modPow(((rhs % p) + p) % p, (p + 1n) / 4n, p)

  const isOdd = !!(prefix & 1)
  const yIsOdd = !!(y & 1n)
  if (isOdd !== yIsOdd) y = p - y

  return {
    x: base64urlEncode(bigIntToBytes(x, 32)),
    y: base64urlEncode(bigIntToBytes(y, 32)),
  }
}

function bytesToBigInt(bytes) {
  let h = '0x'
  for (let i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, '0')
  return BigInt(h)
}

function bigIntToBytes(n, len) {
  const hex = n.toString(16).padStart(len * 2, '0')
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  return bytes
}

function modPow(base, exp, mod) {
  let result = 1n
  base = ((base % mod) + mod) % mod
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod
    exp >>= 1n
    base = (base * base) % mod
  }
  return result
}

// ─── Key generation ──────────────────────────────────────────────

/**
 * Generate a new ECDSA P-256 keypair.
 * @returns {Promise<{ pubkey: string, privateKey: CryptoKey }>}
 */
export async function generateKeypair() {
  const kp = await subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true, // extractable to get JWK for compression
    ['sign']
  )
  const jwk = await subtle.exportKey('jwk', kp.privateKey)
  const pubkey = compressFromJwk(jwk.x, jwk.y)

  // Re-import as non-extractable for signing
  delete jwk.key_ops
  delete jwk.ext
  const privateKey = await subtle.importKey(
    'jwk', jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
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
  } catch (e) {
    // Any crypto error → invalid signature
    return false
  }
}
