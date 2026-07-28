/**
 * The US-3.1 ordered publish flow.
 *
 *   1. PUT the revision snapshot (ref, rev)             [immutable]
 *   2. confirm the snapshot GETs back                   [gate — abort here]
 *   3. PUT/update the head                              [mutable, LWW]
 *   4. poke the inbound index of every distinct target in item.relations
 *
 * The order is load-bearing. A poke makes the target's index `requires()` the
 * SOURCE's snapshot; poking before that snapshot is confirmed present stalls
 * each poke for the host's ~240 s fetch budget and then fails (spike finding).
 * Step 2 is cheap insurance against paying that per target.
 *
 * Pokes are independent: one failure does not stop the rest. The caller gets a
 * per-target report and decides the exit code. Partial success is normal and
 * the whole flow is idempotent — snapshot re-PUT is a no-op, head merge is
 * LWW, pokes are LWW — so re-running converges.
 */

import { objectParams, snapshotParams, parseRef } from './addressing.js'
import { relationTargets, envelopeRef, envelopeRevision } from './relations.js'

/** The initial state of an index nobody has poked yet (D2 wire format). */
const EMPTY_INDEX = { v: 1, slots: {} }

const pokePayload = (sourceRef, revision) => ({ v: 1, poke: { source_ref: sourceRef, revision } })

/**
 * Ensure the target's index contract exists, then poke it.
 *
 * DEV-2: probe local presence with a tightly bounded GET before publishing.
 * A locally hosted contract answers in well under a second, so the probe
 * separates "already here" from "would go to the network" without waiting out
 * the fetch budget. Skipping the re-publish on a hit matters — a publish
 * round-trips ring placement, which fails spuriously when the index's
 * neighbourhood is unreachable, killing a poke that would have succeeded
 * (observed live 2026-06-12). A miss, including a slow-node false negative,
 * falls back to the idempotent empty publish.
 */
async function pokeTarget({ target, sourceRef, revision, node, addressing, contracts, log }) {
  parseRef(target) // fail early, with a message naming the bad ref
  const indexId = addressing.indexId(target)

  const probe = await node.probe(indexId)
  const created = !probe.found
  if (created) {
    log(`   index not on node — creating empty: ${indexId}`)
    await node.publish({
      wasmPath: contracts.paths.index,
      params: objectParams(target),
      state: EMPTY_INDEX,
    })
  }

  await node.update(indexId, pokePayload(sourceRef, revision))
  return { indexId, created }
}

/**
 * Relation targets of the head we are about to replace, so targets dropped in
 * this revision can still be poked (US-2.4).
 *
 * Only a head STRICTLY OLDER than ours is a predecessor. An equal-or-newer
 * head is either our own re-publish or someone else's state; diffing against
 * it would poke targets we never dropped.
 *
 * @returns {Promise<string[]>}
 */
async function previousTargets({ headId, revision, node, log }) {
  let previous
  try {
    previous = await node.probe(headId)
  } catch (err) {
    // An unreachable node is about to fail the head PUT anyway; don't fail
    // here, where the only cost is losing tombstones.
    log(`   (could not read the previous head: ${err.message.split('\n')[0]})`)
    return []
  }
  if (!previous.found) return []

  let previousRevision
  try {
    previousRevision = envelopeRevision(previous.state)
  } catch {
    return []
  }
  if (previousRevision >= revision) return []
  return relationTargets(previous.state)
}

/**
 * @param {object} opts
 * @param {object} opts.envelope - the signed object to publish
 * @param {object} opts.node - fdev node client
 * @param {object} opts.addressing - from createAddressing()
 * @param {object} opts.contracts - from loadContracts()
 * @param {(msg: string) => void} [opts.log] - progress output (stderr)
 * @returns {Promise<object>} per-target report
 */
export async function publishObject({ envelope, node, addressing, contracts, log = () => {} }) {
  const ref = envelopeRef(envelope)
  const revision = envelopeRevision(envelope)
  const signature = envelope?.signature
  if (!signature) {
    throw new Error(
      `Envelope for ${ref} has no signature — refusing to publish.\n` +
      '  Only signed objects can be verified by the contract; sign it with `ig sign` first.',
    )
  }
  parseRef(ref)

  const snapshotId = addressing.snapshotId(ref, revision)
  const headId = addressing.headId(ref)

  // ── 1. snapshot PUT ────────────────────────────────────────────
  log(`── 1/4 snapshot PUT   ${snapshotId}  (rev ${revision})`)
  await node.publish({
    wasmPath: contracts.paths.snapshot,
    params: snapshotParams(ref, revision),
    state: envelope,
  })

  // ── 2. GET-back gate ───────────────────────────────────────────
  // Compare by SIGNATURE, not bytes: the signature is over the canonical
  // item, so two different serializations of the same signed object are the
  // same object and must not read as a conflict.
  log('── 2/4 snapshot GET-back confirm')
  const back = await node.get(snapshotId)
  if (!back.found) {
    throw new Error(
      `Snapshot did not GET back (${snapshotId}) — aborting before any poke.\n` +
      `  ${back.detail}\n` +
      '  A poke now would stall for the node\'s fetch budget on every target and then fail.',
    )
  }
  if (back.state?.signature !== signature) {
    throw new Error(
      `Snapshot ${snapshotId} holds a DIFFERENT signed object — aborting before any poke.\n` +
      `  Revision ${revision} is an immutable slot; it is already taken by another envelope.\n` +
      '  Publish a new revision, or investigate owner equivocation.',
    )
  }
  log('   confirmed: the node holds our signature')

  // ── 2b. read the previous head, before we overwrite it ─────────
  // US-2.4: when a revision DROPS a relation, the target's index only learns
  // about it if we poke that target too — the index fetches our new snapshot,
  // finds no relation to itself, and writes {revision: N+1, relations: []}.
  // Without this the removal never propagates and the index stays wrong.
  //
  // Bounded like the DEV-2 probe, and for the same reason: on a first publish
  // there is no previous head, and an unbounded miss would block for the
  // node's fetch budget. A miss simply means no tombstones — the head we
  // cannot read is one we cannot diff against.
  const droppedTargets = await previousTargets({ headId, revision, node, log })

  // ── 3. head PUT ────────────────────────────────────────────────
  log(`── 3/4 head PUT       ${headId}`)
  await node.publish({
    wasmPath: contracts.paths.object,
    params: objectParams(ref),
    state: envelope,
  })
  const headBack = await node.get(headId)
  const headState = headBack.found && headBack.state?.signature === signature
    ? { confirmed: true, detail: 'the node holds the same signed object' }
    : {
        confirmed: false,
        detail: headBack.found
          ? `the node kept revision ${headBack.state?.item?.revision ?? '?'}; LWW discarded ours (${revision}). ` +
            'Bump item.revision past it, re-sign, re-publish.'
          : `could not read the head back: ${headBack.detail}`,
      }
  log(`   head: ${headState.confirmed ? 'confirmed' : `⚠ ${headState.detail}`}`)

  // ── 4. pokes ───────────────────────────────────────────────────
  const current = relationTargets(envelope)
  const currentSet = new Set(current)
  const tombstones = droppedTargets.filter(t => !currentSet.has(t))
  const targets = [...current, ...tombstones].sort()
  log(
    `── 4/4 poking ${targets.length} distinct relation target(s)` +
    (tombstones.length ? `, ${tombstones.length} of them dropped since revision ${revision}` : ''),
  )

  const pokes = []
  for (const target of targets) {
    const tombstone = !currentSet.has(target)
    try {
      const { indexId, created } = await pokeTarget({
        target, sourceRef: ref, revision, node, addressing, contracts, log,
      })
      pokes.push({ target, indexId, created, tombstone, ok: true, error: null })
      log(`   ✓ ${target}${tombstone ? '  (relation dropped — tombstoning)' : ''}`)
    } catch (err) {
      pokes.push({ target, indexId: null, created: false, tombstone, ok: false, error: err.message })
      log(`   ✗ ${target}  (${err.message.split('\n')[0]})`)
    }
  }

  const failed = pokes.filter(p => !p.ok).length
  return {
    ref,
    revision,
    snapshotId,
    headId,
    headState,
    pokes,
    failed,
    // Success means the object is actually live: the head is confirmed AND
    // every index was told about it. A confirmed-nothing head with happy
    // pokes is not a success, however green the poke report looks.
    ok: failed === 0 && headState.confirmed,
  }
}
