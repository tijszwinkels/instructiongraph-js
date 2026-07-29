/**
 * US-3.4 reader-side verification of an inbound index.
 *
 * The index is a FILTER, NOT PROOF: the contract's creation and seeding paths
 * accept structure-only states ("door 2"), so any single slot is a claim until
 * checked. This gives a reader certainty without trusting the index, by
 * re-deriving each slot from the source's own signed snapshot — the ground
 * truth — and only then asking whether the source has moved on since.
 *
 *   verified-current  slot matches its snapshot AND the source's head is
 *                     still at that revision
 *   verified-stale    slot matches its snapshot, but the head has moved past
 *                     it — or the head is not on the node, in which case
 *                     currency is unknowable and the detail says so (D6)
 *   unverified        snapshot missing, or its content disagrees with the
 *                     slot (a door-2 artifact, or a stale WASM build)
 *
 * `ok` is true iff no slot is unverified. Stale is an honest, verified state.
 */

import { relationNamesTargeting, envelopeRevision } from './relations.js'
import { parseRef } from './addressing.js'

const sameNames = (a, b) => a.length === b.length && a.every((v, i) => v === b[i])

/**
 * Check one slot against the snapshot it claims to summarize.
 * Returns a status object; never throws for a bad slot — a broken slot is a
 * finding, not a crash.
 */
async function verifySlot({ source, slot, target, node, addressing }) {
  try {
    parseRef(source)
  } catch (err) {
    return { source, slot, status: 'unverified', detail: `slot key is not a usable ref — ${err.message}` }
  }

  const slotRevision = slot?.revision
  if (!Number.isSafeInteger(slotRevision) || slotRevision < 0) {
    return { source, slot, status: 'unverified', detail: `slot has an invalid revision: ${JSON.stringify(slotRevision)}` }
  }

  // 1. The snapshot is the ground truth for this slot.
  const snapshotId = addressing.snapshotId(source, slotRevision)
  const snap = await node.get(snapshotId)
  if (!snap.found) {
    return {
      source, slot, snapshotId, status: 'unverified',
      detail: `snapshot for revision ${slotRevision} is not on the node (${snapshotId})` +
        (snap.timedOut ? ' — the GET timed out, so this may be a slow fetch rather than an absence' : ''),
    }
  }

  // 2. Recompute what the slot SHOULD say: the snapshot's own revision, and
  //    the sorted relation names under which it points at us. Only these two
  //    fields are compared — they are the whole of a slot (D2), and the state
  //    schema is deny_unknown_fields, so there is nothing else to disagree on.
  const expectedRelations = relationNamesTargeting(snap.state, target)
  const snapshotRevision = envelopeRevision(snap.state)
  const claimed = Array.isArray(slot.relations) ? slot.relations : null

  if (snapshotRevision !== slotRevision) {
    return {
      source, slot, snapshotId, status: 'unverified',
      detail: `snapshot disagrees with the slot: it carries revision ${snapshotRevision}, the slot claims ${slotRevision}`,
    }
  }
  if (!claimed || !sameNames(claimed, expectedRelations)) {
    return {
      source, slot, snapshotId, status: 'unverified',
      detail: `snapshot disagrees with the slot: expected relations [${expectedRelations.join(', ')}], ` +
        `slot claims [${(claimed ?? []).join(', ')}] — a door-2 artifact, or a stale WASM build`,
    }
  }

  // 3. Currency: is the source's head still at this revision?
  const headId = addressing.headId(source)
  const head = await node.get(headId)
  if (!head.found) {
    return {
      source, slot, snapshotId, headId, status: 'verified-stale',
      detail: 'head not on node — currency unknown',
    }
  }
  const headRevision = envelopeRevision(head.state)
  return headRevision === slotRevision
    ? { source, slot, snapshotId, headId, status: 'verified-current', detail: '' }
    : { source, slot, snapshotId, headId, status: 'verified-stale', detail: `head is at ${headRevision}` }
}

/**
 * One slot's human-readable line. Lives here, next to the statuses it
 * renders, so there is a single formatter — the caller chooses the stream,
 * never the wording.
 *
 * @param {object} result - an entry of the report's `slots`
 * @returns {string}
 */
export function formatSlot(result) {
  return `${result.status.padEnd(17)} ${result.source} @ ${result.slot?.revision}` +
    (result.detail ? `  (${result.detail})` : '')
}

/**
 * @param {object} opts
 * @param {string} opts.ref - the index target
 * @param {object} opts.node
 * @param {object} opts.addressing
 * @param {(msg: string) => void} [opts.log] - headline progress
 * @param {(result: object) => void} [opts.onSlot] - called as each slot
 *   resolves, so a caller can stream results while the rest are still being
 *   fetched. Verification does NOT print slots itself: whether a slot line is
 *   payload (stdout) or progress (stderr) is the caller's decision, and
 *   deciding here is what made it get printed twice.
 * @returns {Promise<{ref, indexId, slots: object[], unverified: number, ok: boolean}>}
 */
export async function verifyIndex({ ref, node, addressing, log = () => {}, onSlot = () => {} }) {
  parseRef(ref)
  const indexId = addressing.indexId(ref)

  const index = await node.get(indexId)
  if (!index.found) {
    throw new Error(
      `No inbound index on the node for ${ref} (${indexId}).\n` +
      `  ${index.detail}\n` +
      '  No publish flow has poked this target yet — this is different from an index with no slots.',
    )
  }

  const slotMap = index.state?.slots ?? {}
  const entries = Object.entries(slotMap)
  log(`── verifying ${entries.length} slot(s) of the inbound index of ${ref}`)

  const slots = []
  for (const [source, slot] of entries) {
    const result = await verifySlot({ source, slot, target: ref, node, addressing })
    slots.push(result)
    onSlot(result)
  }

  const unverified = slots.filter(s => s.status === 'unverified').length
  return { ref, indexId, slots, unverified, ok: unverified === 0 }
}
