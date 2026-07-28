/**
 * The US-3.1 ordered publish flow, against a fake node.
 *
 * The ORDER is the point of this flow, not an implementation detail: a poke
 * makes the target's index fetch the source's snapshot, so poking before the
 * snapshot is confirmed present stalls every poke for the host's ~240 s fetch
 * budget and then fails (spike finding). The GET-back gate at step 2 is what
 * buys that back, and it must abort before ANY poke is sent.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { publishObject } from '../src/freenet/publish.js'
import { createAddressing } from '../src/freenet/addressing.js'

const fromHex = (hex) => Uint8Array.from(hex.match(/../g).map(h => parseInt(h, 16)))

const ADDRESSING = createAddressing({
  object: fromHex('6631a15614c55e96d5297c459461bbb63ec47fd7a4fa6050e2cf104815ed3ff0'),
  snapshot: fromHex('f2e5cf0d8f7ddd588fd2edd782e224bb146593ec0910b8d1dd0635e161c92c44'),
  index: fromHex('27d3ea150dd78b093b0afcc2b62b43147690a2da1b0e9f5e3ea71c8b4a6c6568'),
})

const CONTRACTS = {
  paths: { object: '/w/object.wasm', snapshot: '/w/rev.wasm', index: '/w/index.wasm' },
}

const PK = 'ApWJVWXvVKIIMnH6CP6u8HUyU2gLvyYGnwRlgrWAUwcP'
const OTHER_PK = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ'
const SELF = `${PK}.00000000-0000-0000-0000-000000000001`
const ROOT = `${OTHER_PK}.00000000-0000-0000-0000-000000000000`
const AUTHOR = `${OTHER_PK}.346bef5e-94ff-4f7a-bcf6-d78ae1e1541c`

function envelope({ revision = 3, relations, signature = 'SIG-A' } = {}) {
  return {
    item: {
      pubkey: PK,
      id: '00000000-0000-0000-0000-000000000001',
      revision,
      in: 'dataverse001',
      relations: relations ?? {
        root: [{ ref: ROOT }],
        author: [{ ref: SELF }],
      },
    },
    signature,
  }
}

/**
 * A fake node recording every call in order.
 * `present` is the set of contract ids the node already holds.
 */
function fakeNode({ present = new Map(), fail = {} } = {}) {
  const calls = []
  return {
    calls,
    present,
    async get(id) {
      calls.push({ op: 'get', id })
      if (fail.get?.(id)) throw fail.get(id)
      return present.has(id)
        ? { found: true, state: present.get(id), timedOut: false, detail: '' }
        : { found: false, state: null, timedOut: false, detail: 'not found' }
    },
    async probe(id) {
      calls.push({ op: 'probe', id })
      return present.has(id)
        ? { found: true, state: present.get(id), timedOut: false, detail: '' }
        : { found: false, state: null, timedOut: false, detail: 'not found' }
    },
    async publish({ wasmPath, params, state }) {
      calls.push({ op: 'publish', wasmPath, paramsLen: params.length, state })
      if (fail.publish?.(wasmPath, state)) throw fail.publish(wasmPath, state)
      return { ok: true, output: '' }
    },
    async update(id, payload) {
      calls.push({ op: 'update', id, payload })
      if (fail.update?.(id)) throw fail.update(id)
      return { ok: true, output: '' }
    },
  }
}

/** A node that has already seen this envelope's snapshot and head. */
function nodeWithSnapshot(env, extra = []) {
  const present = new Map()
  const ref = `${env.item.pubkey}.${env.item.id}`
  present.set(ADDRESSING.snapshotId(ref, env.item.revision ?? 0), env)
  present.set(ADDRESSING.headId(ref), env)
  for (const id of extra) present.set(id, { v: 1, slots: {} })
  return fakeNode({ present })
}

const run = (env, node) => publishObject({
  envelope: env, node, addressing: ADDRESSING, contracts: CONTRACTS, log: () => {},
})

// ─── ordering ────────────────────────────────────────────────────

test('runs snapshot PUT → GET-back → head PUT → pokes, in that order', async () => {
  const env = envelope()
  const node = nodeWithSnapshot(env)
  const report = await run(env, node)

  const ops = node.calls.map(c => c.op)
  assert.equal(ops[0], 'publish', 'snapshot PUT first')
  assert.equal(node.calls[0].wasmPath, CONTRACTS.paths.snapshot)
  assert.equal(node.calls[0].paramsLen, 40)
  assert.equal(ops[1], 'get', 'GET-back gate second')
  assert.equal(node.calls[1].id, ADDRESSING.snapshotId(SELF, 3))
  assert.equal(ops[2], 'publish', 'head PUT third')
  assert.equal(node.calls[2].wasmPath, CONTRACTS.paths.object)
  assert.equal(node.calls[2].paramsLen, 32)
  // Everything after the head belongs to the poke phase.
  assert.ok(node.calls.slice(3).some(c => c.op === 'update'))
  assert.equal(report.failed, 0)
})

test('aborts before ANY poke when the snapshot does not GET back', async () => {
  const env = envelope()
  const node = fakeNode() // holds nothing — GET-back misses
  await assert.rejects(() => run(env, node), (err) => {
    assert.match(err.message, /snapshot/i)
    assert.match(err.message, /poke/i, 'explains why we stop here')
    return true
  })
  assert.equal(node.calls.filter(c => c.op === 'update').length, 0, 'no poke was sent')
  assert.equal(node.calls.filter(c => c.op === 'publish').length, 1, 'head was never published')
})

test('aborts when the network snapshot carries a different signature', async () => {
  const env = envelope()
  const node = nodeWithSnapshot(env)
  node.present.set(ADDRESSING.snapshotId(SELF, 3), { ...env, signature: 'SIG-SOMEONE-ELSE' })
  await assert.rejects(() => run(env, node), (err) => {
    assert.match(err.message, /signature|different signed object/i)
    return true
  })
  assert.equal(node.calls.filter(c => c.op === 'update').length, 0)
})

test('an unsigned envelope is refused before the node is touched', async () => {
  const node = fakeNode()
  const unsigned = envelope()
  delete unsigned.signature
  await assert.rejects(() => run(unsigned, node), /signature/i)
  assert.equal(node.calls.length, 0)
})

// ─── pokes ───────────────────────────────────────────────────────

test('pokes every distinct relation target exactly once, self-poke included', async () => {
  const env = envelope({
    relations: {
      root: [{ ref: ROOT }],
      author: [{ ref: SELF }],       // self-poke
      mentions: [{ ref: ROOT }],     // duplicate target, one poke
      provenance: [{ ref: AUTHOR }],
    },
  })
  const node = nodeWithSnapshot(env)
  const report = await run(env, node)

  const poked = node.calls.filter(c => c.op === 'update').map(c => c.id)
  assert.equal(poked.length, 3)
  assert.deepEqual(
    new Set(poked),
    new Set([ROOT, SELF, AUTHOR].map(r => ADDRESSING.indexId(r))),
  )
  assert.equal(report.pokes.length, 3)
  assert.equal(report.failed, 0)
})

test('the poke payload is exactly one source at its revision', async () => {
  const env = envelope({ relations: { root: [{ ref: ROOT }] } })
  const node = nodeWithSnapshot(env)
  await run(env, node)
  const poke = node.calls.find(c => c.op === 'update')
  assert.deepEqual(poke.payload, { v: 1, poke: { source_ref: SELF, revision: 3 } })
})

test('an object with no relations publishes cleanly and pokes nothing', async () => {
  const env = envelope({ relations: {} })
  const node = nodeWithSnapshot(env)
  const report = await run(env, node)
  assert.equal(report.pokes.length, 0)
  assert.equal(report.failed, 0)
  assert.equal(node.calls.filter(c => c.op === 'update').length, 0)
})

test('a missing revision is treated as revision 0', async () => {
  const env = envelope({ revision: undefined, relations: {} })
  delete env.item.revision
  const node = fakeNode()
  node.present.set(ADDRESSING.snapshotId(SELF, 0), env)
  const report = await run(env, node)
  assert.equal(report.revision, 0)
  assert.equal(report.snapshotId, ADDRESSING.snapshotId(SELF, 0))
})

// ─── DEV-2 index-existence handling ──────────────────────────────

test('DEV-2: a probe hit skips the index publish entirely', async () => {
  const env = envelope({ relations: { root: [{ ref: ROOT }] } })
  const node = nodeWithSnapshot(env, [ADDRESSING.indexId(ROOT)])
  const report = await run(env, node)

  assert.ok(node.calls.some(c => c.op === 'probe' && c.id === ADDRESSING.indexId(ROOT)))
  // A re-publish round-trips ring placement and fails spuriously when the
  // index's neighbourhood is unreachable — so a local hit must not re-publish.
  assert.equal(
    node.calls.filter(c => c.op === 'publish' && c.wasmPath === CONTRACTS.paths.index).length,
    0,
  )
  assert.equal(report.pokes[0].created, false)
})

test('DEV-2: a probe miss publishes the empty index, then pokes', async () => {
  const env = envelope({ relations: { root: [{ ref: ROOT }] } })
  const node = nodeWithSnapshot(env)
  const report = await run(env, node)

  const idx = node.calls.findIndex(c => c.op === 'publish' && c.wasmPath === CONTRACTS.paths.index)
  const upd = node.calls.findIndex(c => c.op === 'update')
  assert.ok(idx !== -1, 'empty index was created')
  assert.deepEqual(node.calls[idx].state, { v: 1, slots: {} })
  assert.equal(node.calls[idx].paramsLen, 32, "index uses the TARGET's 32-byte params")
  assert.ok(idx < upd, 'creation precedes the poke')
  assert.equal(report.pokes[0].created, true)
})

// ─── partial failure ─────────────────────────────────────────────

test('one failed poke does not stop the rest, and is reported per target', async () => {
  const env = envelope({
    relations: { root: [{ ref: ROOT }], author: [{ ref: SELF }], p: [{ ref: AUTHOR }] },
  })
  const node = nodeWithSnapshot(env)
  const badId = ADDRESSING.indexId(SELF)
  const failing = fakeNode({ present: node.present, fail: { update: (id) => (id === badId ? new Error('UPDATE rejected: InvalidUpdateWithInfo') : null) } })

  const report = await publishObject({
    envelope: env, node: failing, addressing: ADDRESSING, contracts: CONTRACTS, log: () => {},
  })

  assert.equal(report.pokes.length, 3)
  assert.equal(report.failed, 1)
  const failed = report.pokes.find(p => !p.ok)
  assert.equal(failed.target, SELF)
  assert.match(failed.error, /InvalidUpdateWithInfo/)
  assert.equal(report.pokes.filter(p => p.ok).length, 2, 'the other two still went out')
})

test('a malformed relation target is a reported poke failure, not a crash', async () => {
  const env = envelope({ relations: { broken: [{ ref: 'not-a-ref' }], root: [{ ref: ROOT }] } })
  const node = nodeWithSnapshot(env)
  const report = await run(env, node)

  assert.equal(report.failed, 1)
  const bad = report.pokes.find(p => p.target === 'not-a-ref')
  assert.equal(bad.ok, false)
  assert.match(bad.error, /ref/i)
  assert.ok(report.pokes.find(p => p.target === ROOT).ok, 'the valid target was still poked')
})

test('a failed head PUT aborts before poking', async () => {
  const env = envelope()
  const node = fakeNode({
    present: nodeWithSnapshot(env).present,
    fail: { publish: (wasmPath) => (wasmPath === CONTRACTS.paths.object ? new Error('PUT timed out') : null) },
  })
  await assert.rejects(() => run(env, node), /PUT timed out/)
  assert.equal(node.calls.filter(c => c.op === 'update').length, 0)
})

test('relation entries without a usable ref are ignored, not poked', async () => {
  const env = envelope({
    relations: {
      root: [{ ref: ROOT }],
      junk: [{ url: 'https://example.com' }, {}, { ref: 42 }],
      empty: [],
    },
  })
  const node = nodeWithSnapshot(env)
  const report = await run(env, node)
  assert.equal(report.pokes.length, 1)
  assert.equal(report.pokes[0].target, ROOT)
})

test('re-running makes the identical set of node calls — the flow is idempotent', async () => {
  const env = envelope({ relations: { root: [{ ref: ROOT }] } })
  const first = nodeWithSnapshot(env)
  await run(env, first)

  // Second run against a node that now also holds the index.
  const second = nodeWithSnapshot(env, [ADDRESSING.indexId(ROOT)])
  const report = await run(env, second)

  assert.equal(report.failed, 0)
  assert.deepEqual(
    second.calls.filter(c => c.op === 'update').map(c => c.payload),
    first.calls.filter(c => c.op === 'update').map(c => c.payload),
    'the same poke is re-sent; the contract merges it LWW',
  )
})
