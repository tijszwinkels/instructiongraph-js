/**
 * Reading relations out of a signed envelope.
 *
 * Both directions of the inbound index depend on agreeing exactly what an
 * envelope claims: the publisher derives "whose index do I poke", and the
 * verifier derives "what should that index's slot say about me". If those two
 * readings ever diverge, every slot verifies as a door-2 artifact — so they
 * share this module rather than each doing their own walk.
 */

import { canonicalRef } from './addressing.js'

/**
 * Every distinct target ref in `item.relations`, sorted.
 *
 * Mirrors the reference flow's
 *   [.item.relations // {} | .[][]? | .ref | select(type == "string")] | unique
 * — non-array relation values and entries without a string `ref` are ignored
 * rather than fatal, because an envelope is signed data we do not control.
 *
 * @param {object} envelope
 * @returns {string[]}
 */
export function relationTargets(envelope) {
  const relations = envelope?.item?.relations
  const targets = new Set()
  if (relations && typeof relations === 'object') {
    for (const entries of Object.values(relations)) {
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (entry && typeof entry.ref === 'string' && entry.ref) targets.add(entry.ref)
      }
    }
  }
  return [...targets].sort()
}

/**
 * D2 slot bounds. These are the contract's own deterministic filters — every
 * peer must drop exactly the same entries for the merged state to converge —
 * so a verifier that does not apply them computes an expectation the contract
 * could never have written, and reports honest slots as door-2 artifacts.
 */
const MAX_RELATION_NAME = 128
const MAX_RELATIONS_PER_SLOT = 64

/**
 * The relation names under which an envelope points at one target — sorted,
 * unique, and filtered exactly as the index contract filters them, which is
 * the shape a verified index slot carries (D2).
 *
 * @param {object} envelope
 * @param {string} target - compared canonically; see canonicalRef
 * @returns {string[]}
 */
export function relationNamesTargeting(envelope, target) {
  const relations = envelope?.item?.relations
  const wanted = canonicalOrNull(target)
  const names = new Set()
  if (relations && typeof relations === 'object') {
    for (const [name, entries] of Object.entries(relations)) {
      if (!Array.isArray(entries)) continue
      if (!name || name.length > MAX_RELATION_NAME) continue
      if (entries.some(e => e && typeof e.ref === 'string' && canonicalOrNull(e.ref) === wanted)) {
        names.add(name)
      }
    }
  }
  return [...names].sort().slice(0, MAX_RELATIONS_PER_SLOT)
}

/** Canonical form of a ref, or the raw string when it cannot be parsed. */
function canonicalOrNull(ref) {
  try {
    return canonicalRef(ref)
  } catch {
    return ref
  }
}

/** An envelope's ref. */
export function envelopeRef(envelope) {
  const item = envelope?.item
  if (!item?.pubkey || !item?.id) {
    throw new Error('Envelope is missing item.pubkey / item.id — not an instructionGraph object')
  }
  return `${item.pubkey}.${item.id}`
}

/** An envelope's revision; absent means 0, matching the contracts' LWW base. */
export function envelopeRevision(envelope) {
  const rev = envelope?.item?.revision
  if (rev === undefined || rev === null) return 0
  if (!Number.isSafeInteger(rev) || rev < 0) {
    throw new Error(`Envelope has an invalid item.revision: ${JSON.stringify(rev)}`)
  }
  return rev
}
