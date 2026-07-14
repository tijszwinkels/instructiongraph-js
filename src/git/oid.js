/**
 * Git object id (oid) computation — the content hash that names every git
 * object and, via uuid_v5, its address in the graph.
 *
 * oid = hash( "<otype> <size>\0" + payload )
 *
 * The hash is the repository's object_format: sha1 (40 hex) or sha256 (64 hex).
 * Pure and browser-safe: uses Web Crypto (`crypto.subtle.digest`) only.
 */

/** @typedef {'sha1'|'sha256'} ObjectFormat */

const SUBTLE_ALG = { sha1: 'SHA-1', sha256: 'SHA-256' }

/** @param {ObjectFormat} format @returns {string} Web Crypto digest name */
function subtleAlg(format) {
  const alg = SUBTLE_ALG[format]
  if (!alg) throw new Error(`Unsupported object_format: ${format}`)
  return alg
}

/** Number of hex chars in an oid for a given format. */
export function oidHexLength(format) {
  if (format === 'sha256') return 64
  if (format === 'sha1') return 40
  throw new Error(`Unsupported object_format: ${format}`)
}

const enc = new TextEncoder()

/** Lowercase hex of a byte array. */
export function toHex(bytes) {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0')
  return s
}

/** Parse a hex oid into raw bytes (used for git's binary tree entries). */
export function oidToBytes(hex) {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

/**
 * Compute a git object id over the domain-separated payload.
 * @param {string} otype - commit|tree|blob|tag
 * @param {Uint8Array} payload - object payload WITHOUT the "<otype> <size>\0" header
 * @param {ObjectFormat} [format='sha1']
 * @returns {Promise<string>} lowercase hex oid
 */
export async function computeOid(otype, payload, format = 'sha1') {
  const header = enc.encode(`${otype} ${payload.length}\0`)
  const buf = new Uint8Array(header.length + payload.length)
  buf.set(header, 0)
  buf.set(payload, header.length)
  const digest = await globalThis.crypto.subtle.digest(subtleAlg(format), buf)
  return toHex(new Uint8Array(digest))
}

/** SHA-256 over the payload bytes alone (content-index key, not the oid). */
export async function sha256Hex(payload) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', payload)
  return toHex(new Uint8Array(digest))
}
