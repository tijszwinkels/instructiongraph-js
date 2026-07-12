/**
 * Deterministic addressing for git objects and refs in a repository.
 *
 * Namespace = the GIT_REPOSITORY object's `id` (a uuid). Every child is at a
 * computable uuid_v5 address (RFC 4122 §4.3, SHA-1), signed by the repo owner:
 *   - git object (any kind): id = uuid_v5(repo_id, "obj:" + oid)
 *   - GIT_REF:               id = uuid_v5(repo_id, "ref:" + refname)
 *   - ref = "<owner pubkey>.<id>"
 *
 * Any agent can therefore locate any object/ref of a repository with no index.
 * Pure and browser-safe (Web Crypto).
 */

import { makeRef } from '../object.js'
import { toHex } from './oid.js'

const enc = new TextEncoder()

/** 16 bytes of a uuid string (hyphens ignored). */
function uuidToBytes(uuid) {
  const hex = uuid.replace(/-/g, '')
  if (hex.length !== 32 || /[^0-9a-fA-F]/.test(hex)) throw new Error(`Invalid uuid: ${uuid}`)
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16)
  return out
}

/** Format 16 bytes as a canonical lowercase uuid string. */
function bytesToUuid(bytes) {
  const h = toHex(bytes)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * uuid_v5 (name-based, SHA-1). RFC 4122 §4.3.
 * @param {string} namespaceUuid - the namespace uuid (e.g. the repo id)
 * @param {string} name - the name within the namespace
 * @returns {Promise<string>} version-5 uuid
 */
export async function uuidv5(namespaceUuid, name) {
  const ns = uuidToBytes(namespaceUuid)
  const nameBytes = enc.encode(name)
  const buf = new Uint8Array(ns.length + nameBytes.length)
  buf.set(ns, 0)
  buf.set(nameBytes, ns.length)

  const digest = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-1', buf))
  const out = digest.slice(0, 16)
  out[6] = (out[6] & 0x0f) | 0x50 // version 5
  out[8] = (out[8] & 0x3f) | 0x80 // RFC 4122 variant
  return bytesToUuid(out)
}

/** Address (uuid) of a git object by its oid within a repository. */
export function objId(repoId, oid) {
  return uuidv5(repoId, 'obj:' + oid)
}

/** Address (uuid) of a GIT_REF by its refname within a repository. */
export function refId(repoId, refname) {
  return uuidv5(repoId, 'ref:' + refname)
}

/** Full ref ("<owner>.<id>") of a git object within a repository. */
export async function objRef(ownerPubkey, repoId, oid) {
  return makeRef(ownerPubkey, await objId(repoId, oid))
}

/** Full ref ("<owner>.<id>") of a GIT_REF within a repository. */
export async function refRef(ownerPubkey, repoId, refname) {
  return makeRef(ownerPubkey, await refId(repoId, refname))
}
