/**
 * P-256 elliptic curve arithmetic.
 *
 * Needed because Web Crypto doesn't expose:
 * - Scalar multiplication (computing pubkey from private scalar)
 * - Point compression/decompression
 */

import { base64urlEncode, base64urlDecode, bytesToBigInt, bigIntToBytes } from './encoding.js'

// ─── P-256 curve constants ───────────────────────────────────────

export const P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFFn
export const A = P - 3n
export const B = 0x5AC635D8AA3A93E7B3EBBD55769886BC651D06B0CC53B0F63BCE3C3E27D2604Bn
export const N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n
export const GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296n
export const GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5n

// ─── Modular arithmetic ──────────────────────────────────────────

function modP(a) { return ((a % P) + P) % P }

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

export function modPow(base, exp, mod) {
  let result = 1n
  base = ((base % mod) + mod) % mod
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod
    exp >>= 1n
    base = (base * base) % mod
  }
  return result
}

// ─── Point operations ────────────────────────────────────────────

export function ecAdd(x1, y1, x2, y2) {
  if (x1 === null) return [x2, y2]
  if (x2 === null) return [x1, y1]
  let lam
  if (x1 === x2 && y1 === y2) {
    if (y1 === 0n) return [null, null]
    lam = modP((3n * x1 * x1 + A) * modInv(2n * y1, P))
  } else if (x1 === x2) {
    return [null, null]
  } else {
    lam = modP((y2 - y1) * modInv(((x2 - x1) % P + P) % P, P))
  }
  const x3 = modP(lam * lam - x1 - x2)
  const y3 = modP(lam * (x1 - x3) - y1)
  return [x3, y3]
}

export function ecMul(k, x, y) {
  let rx = null, ry = null
  let qx = x, qy = y
  while (k > 0n) {
    if (k & 1n) [rx, ry] = ecAdd(rx, ry, qx, qy)
    ;[qx, qy] = ecAdd(qx, qy, qx, qy)
    k >>= 1n
  }
  return [rx, ry]
}

// ─── Point compression ──────────────────────────────────────────

/** Compress an EC point to 33-byte format. */
export function compressPoint(x, y) {
  const compressed = new Uint8Array(33)
  compressed[0] = (y & 1n) ? 0x03 : 0x02
  compressed.set(bigIntToBytes(x, 32), 1)
  return compressed
}

/** Compress JWK x,y (base64url) → compressed pubkey (base64url, 44 chars). */
export function compressFromJwk(xB64url, yB64url) {
  const xBytes = base64urlDecode(xB64url)
  const yBytes = base64urlDecode(yB64url)
  const prefix = (yBytes[yBytes.length - 1] & 1) ? 0x03 : 0x02
  const compressed = new Uint8Array(33)
  compressed[0] = prefix
  compressed.set(xBytes, 1)
  return base64urlEncode(compressed)
}

/** Decompress a compressed pubkey (base64url) → JWK x,y (base64url). */
export function decompressToJwk(compressedB64url) {
  const bytes = base64urlDecode(compressedB64url)
  if (bytes.length !== 33) throw new Error(`Invalid compressed pubkey length: ${bytes.length}`)
  const prefix = bytes[0]
  if (prefix !== 0x02 && prefix !== 0x03) throw new Error(`Invalid compression prefix: 0x${prefix.toString(16)}`)

  const x = bytesToBigInt(bytes.slice(1))
  const rhs = (modPow(x, 3n, P) + A * x % P + B) % P
  let y = modPow(((rhs % P) + P) % P, (P + 1n) / 4n, P)

  if (!!(prefix & 1) !== !!(y & 1n)) y = P - y

  return {
    x: base64urlEncode(bigIntToBytes(x, 32)),
    y: base64urlEncode(bigIntToBytes(y, 32)),
  }
}
