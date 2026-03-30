/**
 * Identity management: key derivation, PEM import, signer creation.
 */

import { base64urlEncode, base64urlDecode, p1363ToDer } from './crypto.js'

const subtle = globalThis.crypto.subtle

// ─── P-256 curve constants (for PBKDF2 derivation) ───────────────

const P256_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFFn
const P256_A = P256_P - 3n
const P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n
const P256_GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296n
const P256_GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5n

function modP(a) { return ((a % P256_P) + P256_P) % P256_P }

function modInv(a, m) {
  let old_r = ((a % m) + m) % m, r = m
  let old_s = 1n, s = 0n
  while (r !== 0n) {
    const q = old_r / r
    ;[old_r, r] = [r, old_r - q * r]
    ;[old_s, s] = [s, old_s - q * s]
  }
  return ((old_s % m) + m) % m
}

function ecAdd(x1, y1, x2, y2) {
  if (x1 === null) return [x2, y2]
  if (x2 === null) return [x1, y1]
  let lam
  if (x1 === x2 && y1 === y2) {
    if (y1 === 0n) return [null, null]
    lam = modP((3n * x1 * x1 + P256_A) * modInv(2n * y1, P256_P))
  } else if (x1 === x2) {
    return [null, null]
  } else {
    lam = modP((y2 - y1) * modInv(((x2 - x1) % P256_P + P256_P) % P256_P, P256_P))
  }
  const x3 = modP(lam * lam - x1 - x2)
  const y3 = modP(lam * (x1 - x3) - y1)
  return [x3, y3]
}

function ecMul(k, x, y) {
  let rx = null, ry = null
  let qx = x, qy = y
  while (k > 0n) {
    if (k & 1n) [rx, ry] = ecAdd(rx, ry, qx, qy)
    ;[qx, qy] = ecAdd(qx, qy, qx, qy)
    k >>= 1n
  }
  return [rx, ry]
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

function compressPoint(x, y) {
  const compressed = new Uint8Array(33)
  compressed[0] = (y & 1n) ? 0x03 : 0x02
  compressed.set(bigIntToBytes(x, 32), 1)
  return compressed
}

function bytesToBase64(bytes) {
  let b = ''
  for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i])
  return btoa(b)
}

// ─── PBKDF2 key derivation ──────────────────────────────────────

/**
 * Derive a deterministic ECDSA P-256 keypair from username + password.
 * Uses PBKDF2 (600k iterations, SHA-256) to derive a seed, then reduces
 * modulo curve order to get the private scalar.
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ pubkey: string, privateKey: CryptoKey }>}
 */
export async function deriveKeypair(username, password) {
  const enc = new TextEncoder()

  // Derive salt from username (matches dataverse-write.js)
  const saltHash = await subtle.digest('SHA-256', enc.encode('dataverse001:' + username))
  const salt = new Uint8Array(saltHash)

  // PBKDF2 → 256-bit seed
  const baseKey = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const seedBuf = await subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    baseKey, 256
  )

  // Reduce seed mod (N-1) + 1 to get valid private scalar
  const seed = new Uint8Array(seedBuf)
  const d = bytesToBigInt(seed) % (P256_N - 1n) + 1n
  const dBytes = bigIntToBytes(d, 32)

  // Compute public point via EC scalar multiplication
  const [pubX, pubY] = ecMul(d, P256_GX, P256_GY)
  const compressed = compressPoint(pubX, pubY)
  const pubkey = base64urlEncode(compressed)

  // Import into Web Crypto
  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: base64urlEncode(dBytes),
    x: base64urlEncode(bigIntToBytes(pubX, 32)),
    y: base64urlEncode(bigIntToBytes(pubY, 32))
  }
  const privateKey = await subtle.importKey(
    'jwk', jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  )

  return { pubkey, privateKey }
}

// ─── PEM import ──────────────────────────────────────────────────

/**
 * Import an EC private key from PEM format (PKCS#8 or SEC1).
 * @param {string} pemText
 * @returns {Promise<{ pubkey: string, privateKey: CryptoKey }>}
 */
export async function importPEM(pemText) {
  const lines = pemText.trim().split('\n')
  const isSEC1 = lines[0].indexOf('EC PRIVATE KEY') !== -1

  // Extract base64 body
  let b64 = ''
  for (const line of lines) {
    if (line.trim().startsWith('-----')) continue
    b64 += line.trim()
  }

  // Decode base64 (standard, not base64url)
  const bin = atob(b64)
  const der = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i)

  if (!isSEC1) {
    // PKCS#8: import extractable to get JWK coordinates
    const key = await subtle.importKey(
      'pkcs8', der.buffer,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true, ['sign']
    )
    const jwk = await subtle.exportKey('jwk', key)
    const xBytes = base64urlDecode(jwk.x)
    const yBytes = base64urlDecode(jwk.y)
    const pubX = bytesToBigInt(xBytes)
    const pubY = bytesToBigInt(yBytes)
    const compressed = compressPoint(pubX, pubY)
    const pubkey = base64urlEncode(compressed)

    // Re-import non-extractable
    delete jwk.key_ops
    delete jwk.ext
    const privateKey = await subtle.importKey(
      'jwk', jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false, ['sign']
    )
    return { pubkey, privateKey }
  }

  // SEC1: manual ASN.1 parse
  let pos = 0
  function readTag() {
    const tag = der[pos++]
    let len = der[pos++]
    if (len & 0x80) {
      const numBytes = len & 0x7f
      len = 0
      for (let j = 0; j < numBytes; j++) len = (len << 8) | der[pos++]
    }
    return { tag, len, start: pos }
  }

  readTag() // outer SEQUENCE
  const ver = readTag() // INTEGER version
  pos += ver.len
  const privOctet = readTag() // OCTET STRING
  const dScalar = der.slice(privOctet.start, privOctet.start + privOctet.len)
  const d = bytesToBigInt(dScalar)
  const dBytes = bigIntToBytes(d, 32)
  const [pubX, pubY] = ecMul(d, P256_GX, P256_GY)
  const compressed = compressPoint(pubX, pubY)
  const pubkey = base64urlEncode(compressed)

  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: base64urlEncode(dBytes),
    x: base64urlEncode(bigIntToBytes(pubX, 32)),
    y: base64urlEncode(bigIntToBytes(pubY, 32))
  }
  const privateKey = await subtle.importKey(
    'jwk', jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false, ['sign']
  )
  return { pubkey, privateKey }
}

// ─── Signer creation ─────────────────────────────────────────────

/**
 * Wrap a keypair into the Signer interface.
 * @param {{ pubkey: string, privateKey: CryptoKey }} keypair
 * @returns {import('./types.js').Signer}
 */
export function createSigner(keypair) {
  return {
    pubkey: keypair.pubkey,
    async sign(data) {
      const sigBuf = await subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keypair.privateKey,
        data
      )
      const der = p1363ToDer(new Uint8Array(sigBuf))
      return bytesToBase64(der)
    }
  }
}

/** Well-known UUID for identity objects */
export const IDENTITY_UUID = '00000000-0000-0000-0000-000000000001'

/** Root node ref */
export const ROOT_REF = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.00000000-0000-0000-0000-000000000000'

/** IDENTITY type def ref */
export const IDENTITY_TYPE_DEF = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.ec1abe1f-faad-45cd-9c18-7a48f6895035'
