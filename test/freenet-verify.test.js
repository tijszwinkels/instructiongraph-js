/**
 * US-3.4 reader-side index verification, against a fake node.
 *
 * The index is a FILTER, NOT PROOF — the contract's creation/seeding paths
 * accept structure-only states ("door 2"), so a slot on its own is a claim.
 * Verification re-derives what each slot should say from the source's own
 * signed snapshot, which is the ground truth, and only then asks whether the
 * source has moved on.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { verifyIndex } from '../src/freenet/verify.js'
import { createAddressing } from '../src/freenet/addressing.js'

const fromHex = (hex) => Uint8Array.from(hex.match(/../g).map(h => parseInt(h, 16)))

const ADDRESSING = createAddressing({
  object: fromHex('6631a15614c55e96d5297c459461bbb63ec47fd7a4fa6050e2cf104815ed3ff0'),
  snapshot: fromHex('f2e5cf0d8f7ddd588fd2edd782e224bb146593ec0910b8d1dd0635e161c92c44'),
  index: fromHex('27d3ea150dd78b093b0afcc2b62b43147690a2da1b0e9f5e3ea71c8b4a6c6568'),
})

const PK = 'ApWJVWXvVKIIMnH6CP6u8HUyU2gLvyYGnwRlgrWAUwcP'
const OTHER = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ'
const TARGET = `${OTHER}.00000000-0000-0000-0000-000000000000`
const SOURCE = `${PK}.00000000-0000-0000-0000-000000000001`

function sourceEnvelope({ revision = 3, relations } = {}) {
  return {
    item: {
      pubkey: PK,
      id: '00000000-0000-0000-0000-000000000001',
      revision,
      relations: relations ?? { root: [{ ref: TARGET }] },
    },
    signature: 'SIG',
  }
}

/** Build a node holding an index plus whatever snapshots/heads are given. */
function fakeNode({ index, snapshots = {}, heads = {} }) {
  const present = new Map()
  if (index !== undefined) present.set(ADDRESSING.indexId(TARGET), index)
  for (const [key, env] of Object.entries(snapshots)) {
    const [ref, rev] = key.split('@')
    present.set(ADDRESSING.snapshotId(ref, Number(rev)), env)
  }
  for (const [ref, env] of Object.entries(heads)) present.set(ADDRESSING.headId(ref), env)
  return {
    async get(id) {
      return present.has(id)
        ? { found: true, state: present.get(id), timedOut: false, detail: '' }
        : { found: false, state: null, timedOut: false, detail: 'not found' }
    },
  }
}

const run = (node) => verifyIndex({ ref: TARGET, node, addressing: ADDRESSING, log: () => {} })

test('a slot backed by its snapshot, with the head still there, is verified-current', async () => {
  const env = sourceEnvelope()
  const report = await run(fakeNode({
    index: { v: 1, slots: { [SOURCE]: { revision: 3, relations: ['root'] } } },
    snapshots: { [`${SOURCE}@3`]: env },
    heads: { [SOURCE]: env },
  }))

  assert.equal(report.slots.length, 1)
  assert.equal(report.slots[0].status, 'verified-current')
  assert.equal(report.slots[0].source, SOURCE)
  assert.equal(report.unverified, 0)
  assert.equal(report.ok, true)
})

test('a source whose head has moved on is verified-stale, naming the head revision', async () => {
  const report = await run(fakeNode({
    index: { v: 1, slots: { [SOURCE]: { revision: 3, relations: ['root'] } } },
    snapshots: { [`${SOURCE}@3`]: sourceEnvelope({ revision: 3 }) },
    heads: { [SOURCE]: sourceEnvelope({ revision: 7 }) },
  }))
  assert.equal(report.slots[0].status, 'verified-stale')
  assert.match(report.slots[0].detail, /head is at 7/)
  assert.equal(report.unverified, 0)
  assert.equal(report.ok, true, 'stale is an honest, verified state')
})

test('D6: no head on the node is verified-stale with currency explicitly unknown', async () => {
  const report = await run(fakeNode({
    index: { v: 1, slots: { [SOURCE]: { revision: 3, relations: ['root'] } } },
    snapshots: { [`${SOURCE}@3`]: sourceEnvelope() },
    // no head
  }))
  assert.equal(report.slots[0].status, 'verified-stale')
  assert.match(report.slots[0].detail, /currency unknown/i)
  assert.equal(report.ok, true)
})

test('a slot whose snapshot is missing is unverified', async () => {
  const report = await run(fakeNode({
    index: { v: 1, slots: { [SOURCE]: { revision: 3, relations: ['root'] } } },
  }))
  assert.equal(report.slots[0].status, 'unverified')
  assert.match(report.slots[0].detail, /snapshot/i)
  assert.equal(report.unverified, 1)
  assert.equal(report.ok, false)
})

test('a slot the snapshot contradicts is unverified — the door-2 case', async () => {
  const report = await run(fakeNode({
    // The slot claims two relations; the snapshot only proves `root`.
    index: { v: 1, slots: { [SOURCE]: { revision: 3, relations: ['author', 'root'] } } },
    snapshots: { [`${SOURCE}@3`]: sourceEnvelope({ relations: { root: [{ ref: TARGET }] } }) },
    heads: { [SOURCE]: sourceEnvelope() },
  }))
  assert.equal(report.slots[0].status, 'unverified')
  assert.match(report.slots[0].detail, /disagree|expected/i)
  assert.equal(report.ok, false)
})

test('a slot claiming the wrong revision is unverified', async () => {
  const report = await run(fakeNode({
    index: { v: 1, slots: { [SOURCE]: { revision: 3, relations: ['root'] } } },
    // The snapshot at that address carries a different revision internally.
    snapshots: { [`${SOURCE}@3`]: sourceEnvelope({ revision: 4 }) },
    heads: { [SOURCE]: sourceEnvelope({ revision: 4 }) },
  }))
  assert.equal(report.slots[0].status, 'unverified')
  assert.equal(report.ok, false)
})

test('only relations that actually point at the target are expected', async () => {
  // The source has three relations; just two target us. `type_def` must not
  // leak into an index it does not point at.
  const env = sourceEnvelope({
    relations: {
      root: [{ ref: TARGET }],
      author: [{ ref: TARGET }],
      type_def: [{ ref: `${OTHER}.ba52a919-af7f-460d-9606-6efb284ad9ae` }],
    },
  })
  const report = await run(fakeNode({
    index: { v: 1, slots: { [SOURCE]: { revision: 3, relations: ['author', 'root'] } } },
    snapshots: { [`${SOURCE}@3`]: env },
    heads: { [SOURCE]: env },
  }))
  assert.equal(report.slots[0].status, 'verified-current')
})

test('expected relation names are compared sorted, not in envelope order', async () => {
  const env = sourceEnvelope({
    relations: { zeta: [{ ref: TARGET }], alpha: [{ ref: TARGET }] },
  })
  const report = await run(fakeNode({
    index: { v: 1, slots: { [SOURCE]: { revision: 3, relations: ['alpha', 'zeta'] } } },
    snapshots: { [`${SOURCE}@3`]: env },
    heads: { [SOURCE]: env },
  }))
  assert.equal(report.slots[0].status, 'verified-current')
})

test('an index with no slots verifies vacuously', async () => {
  const report = await run(fakeNode({ index: { v: 1, slots: {} } }))
  assert.equal(report.slots.length, 0)
  assert.equal(report.unverified, 0)
  assert.equal(report.ok, true)
})

test('a missing index is an error, distinct from an empty one', async () => {
  await assert.rejects(() => run(fakeNode({})), (err) => {
    assert.match(err.message, /index/i)
    assert.match(err.message, /poked|not exist|no publish/i)
    return true
  })
})

test('every slot is judged; one bad slot does not mask the good ones', async () => {
  const other = `${OTHER}.346bef5e-94ff-4f7a-bcf6-d78ae1e1541c`
  const goodEnv = sourceEnvelope()
  const otherEnv = {
    item: { pubkey: OTHER, id: '346bef5e-94ff-4f7a-bcf6-d78ae1e1541c', revision: 8, relations: { root: [{ ref: TARGET }] } },
    signature: 'SIG2',
  }
  const report = await run(fakeNode({
    index: {
      v: 1,
      slots: {
        [SOURCE]: { revision: 3, relations: ['root'] },
        [other]: { revision: 8, relations: ['root'] },
      },
    },
    snapshots: { [`${SOURCE}@3`]: goodEnv }, // `other`'s snapshot is missing
    heads: { [SOURCE]: goodEnv },
  }))

  assert.equal(report.slots.length, 2)
  assert.equal(report.unverified, 1)
  assert.equal(report.slots.find(s => s.source === SOURCE).status, 'verified-current')
  assert.equal(report.slots.find(s => s.source === other).status, 'unverified')
  assert.equal(report.ok, false)
})

test('a slot key that is not a parseable ref is unverified, not a crash', async () => {
  const report = await run(fakeNode({
    index: { v: 1, slots: { 'garbage-key': { revision: 1, relations: [] } } },
  }))
  assert.equal(report.slots[0].status, 'unverified')
  assert.match(report.slots[0].detail, /ref/i)
  assert.equal(report.ok, false)
})

// ─── ref canonicalisation and D2 slot bounds ─────────────────────

test('an uppercase uuid in the queried ref still matches the signed relations', async () => {
  // objectParams is uuid-case-insensitive, so an uppercase ref reaches the
  // right index; the relation comparison must agree, or every slot would
  // read as unverified purely because of how the ref was typed.
  const [pk, uuid] = TARGET.split('.')
  const upper = `${pk}.${uuid.toUpperCase()}`
  const env = sourceEnvelope()
  const node = fakeNode({
    index: { v: 1, slots: { [SOURCE]: { revision: 3, relations: ['root'] } } },
    snapshots: { [`${SOURCE}@3`]: env },
    heads: { [SOURCE]: env },
  })
  const report = await verifyIndex({ ref: upper, node, addressing: ADDRESSING, log: () => {} })
  assert.equal(report.slots[0].status, 'verified-current')
})

test('D2 bounds are mirrored: over-long relation names are not expected in a slot', async () => {
  const longName = 'x'.repeat(129) // > 128 chars: the contract drops it
  const env = sourceEnvelope({ relations: { root: [{ ref: TARGET }], [longName]: [{ ref: TARGET }] } })
  const report = await run(fakeNode({
    index: { v: 1, slots: { [SOURCE]: { revision: 3, relations: ['root'] } } },
    snapshots: { [`${SOURCE}@3`]: env },
    heads: { [SOURCE]: env },
  }))
  assert.equal(report.slots[0].status, 'verified-current')
})

test('D2 bounds are mirrored: the expected relation list truncates at 64', async () => {
  const relations = {}
  for (let i = 0; i < 70; i++) relations[`rel${String(i).padStart(3, '0')}`] = [{ ref: TARGET }]
  const env = sourceEnvelope({ relations })
  const expected = Object.keys(relations).sort().slice(0, 64)
  const report = await run(fakeNode({
    index: { v: 1, slots: { [SOURCE]: { revision: 3, relations: expected } } },
    snapshots: { [`${SOURCE}@3`]: env },
    heads: { [SOURCE]: env },
  }))
  assert.equal(report.slots[0].status, 'verified-current')
})

test('the 128-char bound counts code points, exactly as the contract does', async () => {
  // The contract uses Rust's name.chars().count() — Unicode scalar values.
  // JS .length counts UTF-16 code units, so 100 non-BMP characters measure
  // 200 there and the name would be wrongly dropped from the expectation,
  // failing a slot the contract legitimately wrote.
  const name = '😀'.repeat(100) // 100 code points, 200 UTF-16 units
  const env = sourceEnvelope({ relations: { [name]: [{ ref: TARGET }], root: [{ ref: TARGET }] } })
  const report = await run(fakeNode({
    index: { v: 1, slots: { [SOURCE]: { revision: 3, relations: [name, 'root'].sort() } } },
    snapshots: { [`${SOURCE}@3`]: env },
    heads: { [SOURCE]: env },
  }))
  assert.equal(report.slots[0].status, 'verified-current')
})

test('a name beyond 128 code points is dropped, as the contract drops it', async () => {
  const tooLong = 'é'.repeat(129)
  const env = sourceEnvelope({ relations: { [tooLong]: [{ ref: TARGET }], root: [{ ref: TARGET }] } })
  const report = await run(fakeNode({
    index: { v: 1, slots: { [SOURCE]: { revision: 3, relations: ['root'] } } },
    snapshots: { [`${SOURCE}@3`]: env },
    heads: { [SOURCE]: env },
  }))
  assert.equal(report.slots[0].status, 'verified-current')
})

test('relation names sort in UTF-8 byte order, as Rust String ordering does', async () => {
  // Rust compares strings by UTF-8 bytes (== code point order). JS's default
  // sort compares UTF-16 code units, which disagree above U+E000: a non-BMP
  // character is a surrogate pair starting 0xD800, so it sorts BEFORE U+E000
  // in JS and AFTER it in Rust. Get this wrong and the expected list is in a
  // different order from the slot the contract wrote, failing an honest slot.
  const pua = ''
  const emoji = '\u{1F600}'
  assert.deepEqual([emoji, pua].sort(), [emoji, pua], 'JS default order, for contrast')

  const env = sourceEnvelope({ relations: { [pua]: [{ ref: TARGET }], [emoji]: [{ ref: TARGET }] } })
  const report = await run(fakeNode({
    // The order the contract writes: UTF-8 bytes, so U+E000 comes first.
    index: { v: 1, slots: { [SOURCE]: { revision: 3, relations: [pua, emoji] } } },
    snapshots: { [`${SOURCE}@3`]: env },
    heads: { [SOURCE]: env },
  }))
  assert.equal(report.slots[0].status, 'verified-current')
})
