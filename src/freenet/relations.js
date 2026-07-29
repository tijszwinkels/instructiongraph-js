/**
 * Reading relations out of a signed envelope.
 *
 * Both directions of the inbound index depend on agreeing exactly what an
 * envelope claims: the publisher derives "whose index do I poke", and the
 * verifier derives "what should that index's slot say about me". If those two
 * readings ever diverge, every slot verifies as a door-2 artifact — so they
 * share this module rather than each doing their own walk.
 */

import { objectParams } from './addressing.js'

/**
 * The identity the index contract uses for a ref.
 *
 * The contract does NOT compare ref strings — it compares derived bytes:
 *
 *   owner_addr_from_pubkey(pubkey) == target_addr && uuid == target_uuid
 *
 * which is exactly the 32-byte object params. Mirroring that (rather than
 * inventing our own canonical string) means our reading of "same object"
 * cannot drift from the contract's — including uuid case, which the contract
 * folds away by parsing the uuid to bytes.
 *
 * Unparseable refs key on themselves. The contract skips them entirely
 * (validate_ref(...).ok()), and since a verification target is always
 * parseable, a self-keyed junk ref can never match one — same outcome, while
 * still surviving to be reported by the publish flow.
 */
export function relationKey(ref) {
  try {
    return [...objectParams(ref)].map(b => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return `raw:${ref}`
  }
}

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
  // Keyed canonically: two spellings of one ref (uuid case) address the SAME
  // index contract, so poking both is a wasted round-trip on a flow whose
  // entire cost is round-trips. Malformed refs key on themselves and survive
  // to be reported, rather than being silently dropped here.
  const targets = new Map()
  if (relations && typeof relations === 'object') {
    for (const entries of Object.values(relations)) {
      if (!Array.isArray(entries)) continue
      for (const entry of entries) {
        if (!entry || typeof entry.ref !== 'string' || !entry.ref) continue
        const key = relationKey(entry.ref)
        if (!targets.has(key)) targets.set(key, entry.ref)
      }
    }
  }
  return [...targets.values()].sort()
}

/**
 * D2 slot bounds. These are the contract's own deterministic filters — every
 * peer must drop exactly the same entries for the merged state to converge —
 * so a verifier that does not apply them computes an expectation the contract
 * could never have written, and reports honest slots as door-2 artifacts.
 */
const MAX_RELATION_NAME_CHARS = 128
const MAX_RELATIONS_PER_SLOT = 64

/**
 * The relation names under which an envelope points at one target — sorted,
 * unique, and filtered exactly as the index contract filters them, which is
 * the shape a verified index slot carries (D2).
 *
 * @param {object} envelope
 * @param {string} target - compared by derived bytes; see relationKey
 * @returns {string[]}
 */
export function relationNamesTargeting(envelope, target) {
  const relations = envelope?.item?.relations
  const wanted = relationKey(target)
  const names = new Set()
  if (relations && typeof relations === 'object') {
    for (const [name, entries] of Object.entries(relations)) {
      if (!Array.isArray(entries)) continue
      if (!name || codePoints(name) > MAX_RELATION_NAME_CHARS) continue
      if (entries.some(e => e && typeof e.ref === 'string' && relationKey(e.ref) === wanted)) {
        names.add(name)
      }
    }
  }
  return [...names].sort().slice(0, MAX_RELATIONS_PER_SLOT)
}

/**
 * Length in Unicode code points — what Rust's `chars().count()` counts.
 *
 * JS `.length` counts UTF-16 code units, so a name of 100 emoji measures 200
 * there. Using it would drop a name the contract kept, and the slot would
 * then read as a door-2 artifact for no reason but the encoding.
 */
const codePoints = (s) => [...s].length

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
