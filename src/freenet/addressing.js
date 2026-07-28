/**
 * Freenet contract addressing for dataverse objects.
 *
 * An object's ref (`<pubkey>.<uuid>`) determines, with no index and no
 * lookup, the address of every contract that can hold something about it:
 *
 *   params32 = BLAKE3(pubkey_raw_33B)[..16] ‖ uuid_16B          (the object)
 *   params40 = params32 ‖ revision_be64                          (one revision)
 *   contract_id = base58( BLAKE3( BLAKE3(wasm) ‖ params ) )
 *
 * The WASM that hashes into the id is what separates the three keyspaces —
 * all of them are addressed by the same ref:
 *
 *   head      dataverse_object.wasm        params32   mutable, LWW on revision
 *   snapshot  dataverse_object_rev.wasm    params40   immutable, one per revision
 *   index     dataverse_inbound_index.wasm params32   inbound relations, of the TARGET
 *
 * Note the index is keyed on its *target's* 32-byte params: "who points at
 * me" is a property of me, so any reader who knows a ref can find its index.
 *
 * Pure and browser-safe — no I/O. Callers supply the code hashes (see
 * contracts.js, which reads and hashes the pinned WASMs).
 */

import { blake3, blake3Concat } from './blake3.js'
import { base58Encode } from './base58.js'
import { base64urlDecode } from '../encoding.js'

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const PUBKEY_BYTES = 33 // compressed P-256 point
const CODE_HASH_BYTES = 32

/** Decode the pubkey half of a ref to its raw compressed bytes. */
function decodePubkey(ref, pubkey) {
  let raw
  try {
    raw = base64urlDecode(pubkey)
  } catch {
    throw new Error(`Invalid ref '${ref}': pubkey is not base64url`)
  }
  if (raw.length !== PUBKEY_BYTES) {
    throw new Error(
      `Invalid ref '${ref}': pubkey must decode to a ${PUBKEY_BYTES}-byte compressed public key (got ${raw.length})`,
    )
  }
  return raw
}

/**
 * Split and fully validate a dataverse ref.
 * @param {string} ref - `<pubkey>.<uuid>`
 * @returns {{pubkey: string, uuid: string}}
 */
export function parseRef(ref) {
  if (typeof ref !== 'string' || !ref.includes('.')) {
    throw new Error(`Invalid ref ${JSON.stringify(ref)}: expected <pubkey>.<uuid>`)
  }
  const dot = ref.indexOf('.')
  const pubkey = ref.slice(0, dot)
  const uuid = ref.slice(dot + 1)
  if (!pubkey || !uuid) throw new Error(`Invalid ref '${ref}': expected <pubkey>.<uuid>`)
  if (!UUID_RE.test(uuid)) throw new Error(`Invalid ref '${ref}': '${uuid}' is not a uuid`)
  decodePubkey(ref, pubkey)
  return { pubkey, uuid }
}

function uuidBytes(uuid) {
  const hex = uuid.replace(/-/g, '')
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

/**
 * A ref in the one form two refs must share to be "the same object".
 *
 * Addressing is uuid-case-insensitive (the uuid is hashed as bytes), so
 * `…-000001` and `…-000001` in different cases reach the SAME contract. Any
 * comparison of refs as strings has to agree with that, or a ref typed in
 * uppercase would address the right index and then match none of its slots.
 *
 * @param {string} ref
 * @returns {string}
 */
export function canonicalRef(ref) {
  const { pubkey, uuid } = parseRef(ref)
  return `${pubkey}.${uuid.toLowerCase()}`
}

/**
 * The object's 32-byte params — the address of a head or an inbound index.
 * @param {string} ref
 * @returns {Uint8Array} 32 bytes
 */
export function objectParams(ref) {
  const { pubkey, uuid } = parseRef(ref)
  const out = new Uint8Array(32)
  // The 16-byte owner address: BLAKE3 of the raw compressed pubkey, truncated.
  out.set(blake3(decodePubkey(ref, pubkey)).subarray(0, 16), 0)
  out.set(uuidBytes(uuid), 16)
  return out
}

/**
 * The revision's 40-byte params — the address of one immutable snapshot.
 * @param {string} ref
 * @param {number} revision
 * @returns {Uint8Array} 40 bytes
 */
export function snapshotParams(ref, revision) {
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
    throw new Error(`Invalid revision ${JSON.stringify(revision)}: expected a non-negative integer`)
  }
  const out = new Uint8Array(40)
  out.set(objectParams(ref), 0)
  // Big-endian u64. Split at 2^32 so revisions above 4 billion still carry.
  const hi = Math.floor(revision / 0x100000000)
  const lo = revision >>> 0
  for (let i = 0; i < 4; i++) {
    out[32 + i] = (hi >>> ((3 - i) * 8)) & 0xff
    out[36 + i] = (lo >>> ((3 - i) * 8)) & 0xff
  }
  return out
}

/**
 * The base58 contract instance id Freenet addresses a contract by.
 * @param {Uint8Array} codeHash - BLAKE3 of the contract WASM
 * @param {Uint8Array} params
 * @returns {string}
 */
export function contractId(codeHash, params) {
  return base58Encode(blake3Concat(codeHash, params))
}

function requireCodeHash(hashes, key) {
  const h = hashes?.[key]
  if (!(h instanceof Uint8Array) || h.length !== CODE_HASH_BYTES) {
    throw new Error(`Missing or malformed '${key}' code hash: expected ${CODE_HASH_BYTES} bytes`)
  }
  return h
}

/**
 * Bind a set of contract code hashes and derive ids from refs alone.
 *
 * @param {{object: Uint8Array, snapshot: Uint8Array, index: Uint8Array}} codeHashes
 * @returns {{headId: (ref: string) => string,
 *            snapshotId: (ref: string, revision: number) => string,
 *            indexId: (ref: string) => string,
 *            all: (ref: string, revision?: number) => object}}
 */
export function createAddressing(codeHashes) {
  const object = requireCodeHash(codeHashes, 'object')
  const snapshot = requireCodeHash(codeHashes, 'snapshot')
  const index = requireCodeHash(codeHashes, 'index')

  const headId = (ref) => contractId(object, objectParams(ref))
  const snapshotId = (ref, revision) => contractId(snapshot, snapshotParams(ref, revision))
  const indexId = (ref) => contractId(index, objectParams(ref))

  return {
    headId,
    snapshotId,
    indexId,
    /** Every id derivable for a ref, for `ig freenet derive`. */
    all: (ref, revision) => ({
      ref,
      head: headId(ref),
      index: indexId(ref),
      ...(revision === undefined ? {} : { revision, snapshot: snapshotId(ref, revision) }),
    }),
  }
}
