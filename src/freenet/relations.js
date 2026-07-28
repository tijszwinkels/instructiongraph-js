/**
 * Reading relations out of a signed envelope.
 *
 * Both directions of the inbound index depend on agreeing exactly what an
 * envelope claims: the publisher derives "whose index do I poke", and the
 * verifier derives "what should that index's slot say about me". If those two
 * readings ever diverge, every slot verifies as a door-2 artifact — so they
 * share this module rather than each doing their own walk.
 */

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
 * The relation names under which an envelope points at one target — sorted
 * and unique, which is exactly the shape a verified index slot carries (D2).
 *
 * @param {object} envelope
 * @param {string} target
 * @returns {string[]}
 */
export function relationNamesTargeting(envelope, target) {
  const relations = envelope?.item?.relations
  const names = new Set()
  if (relations && typeof relations === 'object') {
    for (const [name, entries] of Object.entries(relations)) {
      if (!Array.isArray(entries)) continue
      if (entries.some(e => e && e.ref === target)) names.add(name)
    }
  }
  return [...names].sort()
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
