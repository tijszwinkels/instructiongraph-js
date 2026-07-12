/**
 * Git object codec: git payload bytes ↔ instructionGraph object `content`.
 *
 * The raw payload is authoritative (stored in `content.data` base64, or
 * `content.text` when it is lossless UTF-8). Parsed mirrors (commit/tree/tag)
 * are derived conveniences for graph browsing and MUST NOT be trusted over the
 * payload — some git objects (gpgsig headers, non-UTF8 names) do not round-trip
 * through parsing. Never recompute an oid from a mirror.
 *
 * Pure and browser-safe.
 */

import { bytesToBase64, base64Decode } from '../encoding.js'
import { computeOid, sha256Hex, oidHexLength, toHex } from './oid.js'

const utf8 = new TextEncoder()
const utf8Strict = new TextDecoder('utf-8', { fatal: true })
const utf8Lossy = new TextDecoder('utf-8') // for non-authoritative mirrors

/** Ensure we have a Uint8Array view (accept Buffer/ArrayBuffer/Uint8Array). */
function asBytes(x) {
  if (x instanceof Uint8Array) return x
  if (x instanceof ArrayBuffer) return new Uint8Array(x)
  throw new TypeError('payload must be a Uint8Array')
}

/**
 * Decide whether a payload can be stored losslessly as a UTF-8 `text` field.
 * Trees are always binary. Anything with a NUL byte stays binary for consumer
 * safety even if technically valid UTF-8.
 */
function isLosslessText(otype, payload) {
  if (otype === 'tree') return false
  if (payload.includes(0x00)) return false
  try {
    const s = utf8Strict.decode(payload)
    const reencoded = utf8.encode(s)
    if (reencoded.length !== payload.length) return false
    for (let i = 0; i < reencoded.length; i++) if (reencoded[i] !== payload[i]) return false
    return true
  } catch {
    return false
  }
}

/**
 * Build the `content` block of an ig git object from a raw git payload.
 * @param {string} otype commit|tree|blob|tag
 * @param {Uint8Array} payloadIn payload WITHOUT the git header
 * @param {import('./oid.js').ObjectFormat} [format='sha1']
 * @returns {Promise<object>} content: { oid, otype, size, sha256, data|text, mirror? }
 */
export async function payloadToContent(otype, payloadIn, format = 'sha1') {
  const payload = asBytes(payloadIn)
  const content = {
    oid: await computeOid(otype, payload, format),
    otype,
    size: payload.length,
    sha256: await sha256Hex(payload),
  }

  if (isLosslessText(otype, payload)) content.text = utf8Strict.decode(payload)
  else content.data = bytesToBase64(payload)

  // Derived mirrors (best effort; raw payload remains authoritative)
  try {
    if (otype === 'commit') content.commit = parseCommit(payload)
    else if (otype === 'tree') content.entries = parseTree(payload, format)
    else if (otype === 'tag') content.tag = parseTag(payload)
  } catch { /* malformed for parsing — payload still authoritative */ }

  return content
}

/**
 * Reconstruct the authoritative git payload from an ig git object `content`.
 * Uses data/text only — never the mirror.
 * @param {object} content
 * @returns {Uint8Array}
 */
export function contentToPayload(content) {
  if (typeof content.data === 'string') return base64Decode(content.data)
  if (typeof content.text === 'string') return utf8.encode(content.text)
  throw new Error('git object content has neither data nor text')
}

// ─── Mirror parsers (derived, non-authoritative) ──────────────────

/** Index of the header/message separator (an empty line: "\n\n"). */
function headerBodySplit(bytes) {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] === 0x0a && bytes[i + 1] === 0x0a) return i
  }
  return -1
}

/**
 * Parse commit headers + message. Multi-line headers (gpgsig) are folded via
 * leading-space continuation lines and ignored in the mirror.
 * @returns {{tree:string, parents:string[], author:string, committer:string, message:string}}
 */
export function parseCommit(payloadIn) {
  const payload = asBytes(payloadIn)
  const split = headerBodySplit(payload)
  const headerBytes = split === -1 ? payload : payload.subarray(0, split)
  const message = split === -1 ? '' : utf8Lossy.decode(payload.subarray(split + 2))

  const headerText = utf8Lossy.decode(headerBytes)
  const out = { tree: '', parents: [], author: '', committer: '', message }
  for (const line of headerText.split('\n')) {
    if (line.startsWith(' ')) continue // continuation of a folded header (e.g. gpgsig)
    const sp = line.indexOf(' ')
    if (sp === -1) continue
    const key = line.slice(0, sp)
    const value = line.slice(sp + 1)
    if (key === 'tree') out.tree = value
    else if (key === 'parent') out.parents.push(value)
    else if (key === 'author') out.author = value
    else if (key === 'committer') out.committer = value
  }
  return out
}

/**
 * Parse a binary git tree payload into entries.
 * Entry := "<mode> <name>\0<raw oid bytes>", modes: 100644/100755/40000/120000/160000.
 * Dir mode (40000) is normalized to 6 digits (040000) in the mirror.
 * @param {Uint8Array} payloadIn
 * @param {import('./oid.js').ObjectFormat} [format='sha1']
 * @returns {{mode:string,name:string,oid:string}[]}
 */
export function parseTree(payloadIn, format = 'sha1') {
  const payload = asBytes(payloadIn)
  const oidLen = oidHexLength(format) / 2
  const entries = []
  let i = 0
  while (i < payload.length) {
    // mode: ascii digits until space
    let sp = i
    while (sp < payload.length && payload[sp] !== 0x20) sp++
    if (sp >= payload.length) throw new Error('malformed tree: no space after mode')
    let mode = utf8Lossy.decode(payload.subarray(i, sp))
    if (mode.length < 6) mode = mode.padStart(6, '0')
    // name: bytes until NUL
    let nul = sp + 1
    while (nul < payload.length && payload[nul] !== 0x00) nul++
    if (nul >= payload.length) throw new Error('malformed tree: no NUL after name')
    const name = utf8Lossy.decode(payload.subarray(sp + 1, nul))
    // oid: raw bytes
    const oidStart = nul + 1
    if (oidStart + oidLen > payload.length) throw new Error('malformed tree: truncated oid')
    const oid = toHex(payload.subarray(oidStart, oidStart + oidLen))
    entries.push({ mode, name, oid })
    i = oidStart + oidLen
  }
  return entries
}

/**
 * Parse an annotated tag payload.
 * git's `type` header becomes `target_type` to avoid confusion.
 * @returns {{object:string, target_type:string, tag:string, tagger:string, message:string}}
 */
export function parseTag(payloadIn) {
  const payload = asBytes(payloadIn)
  const split = headerBodySplit(payload)
  const headerBytes = split === -1 ? payload : payload.subarray(0, split)
  const message = split === -1 ? '' : utf8Lossy.decode(payload.subarray(split + 2))

  const out = { object: '', target_type: '', tag: '', tagger: '', message }
  for (const line of utf8Lossy.decode(headerBytes).split('\n')) {
    const sp = line.indexOf(' ')
    if (sp === -1) continue
    const key = line.slice(0, sp)
    const value = line.slice(sp + 1)
    if (key === 'object') out.object = value
    else if (key === 'type') out.target_type = value
    else if (key === 'tag') out.tag = value
    else if (key === 'tagger') out.tagger = value
  }
  return out
}
