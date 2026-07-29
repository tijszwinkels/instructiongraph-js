/**
 * Freenet contract addressing.
 *
 * Golden vectors are LIVE-VERIFIED ids — the contracts these params address
 * were actually published to a Freenet node during the inbound-index spike
 * (2026-06-11, spikes/inbound-index/NOTES.md), and the same ids are what
 * `fdev execute get-contract-id` derives. So these assertions pin our
 * derivation to the real keyspace, not to our own arithmetic.
 *
 * The three code hashes are BLAKE3 of the pinned contract WASMs; they are
 * inlined here so the unit tests need no build artifacts on disk. The e2e
 * test re-derives them from the actual .wasm files and asserts they match.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  createAddressing, parseRef, objectParams, snapshotParams, contractId,
} from '../src/freenet/addressing.js'

const toHex = (bytes) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')
const fromHex = (hex) => Uint8Array.from(hex.match(/../g).map(h => parseInt(h, 16)))

const CODE_HASHES = {
  object: fromHex('6631a15614c55e96d5297c459461bbb63ec47fd7a4fa6050e2cf104815ed3ff0'),
  snapshot: fromHex('f2e5cf0d8f7ddd588fd2edd782e224bb146593ec0910b8d1dd0635e161c92c44'),
  index: fromHex('27d3ea150dd78b093b0afcc2b62b43147690a2da1b0e9f5e3ea71c8b4a6c6568'),
}

const TIJS = 'ApWJVWXvVKIIMnH6CP6u8HUyU2gLvyYGnwRlgrWAUwcP.00000000-0000-0000-0000-000000000001'
const ROOT = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.00000000-0000-0000-0000-000000000000'

const addressing = () => createAddressing(CODE_HASHES)

test('parseRef splits <pubkey>.<uuid> and rejects malformed refs', () => {
  assert.deepEqual(parseRef(TIJS), {
    pubkey: 'ApWJVWXvVKIIMnH6CP6u8HUyU2gLvyYGnwRlgrWAUwcP',
    uuid: '00000000-0000-0000-0000-000000000001',
  })
  for (const bad of ['', 'nodot', 'ApWJ.', '.uuid', 'ApWJVWXvVKIIMnH6CP6u8HUyU2gLvyYGnwRlgrWAUwcP.not-a-uuid']) {
    assert.throws(() => parseRef(bad), /ref/i, `should reject: ${JSON.stringify(bad)}`)
  }
})

test('parseRef rejects a pubkey that is not a 33-byte compressed point', () => {
  assert.throws(() => parseRef('AAAA.00000000-0000-0000-0000-000000000001'), /pubkey/i)
})

test('objectParams is blake3(pubkey_raw)[..16] ‖ uuid_16, matching derive-params', () => {
  const p = objectParams(TIJS)
  assert.equal(p.length, 32)
  // owner_addr printed by the Rust derive-params tool for this identity.
  assert.equal(toHex(p), '94296828df5ad8740d45310680ee3c9a00000000000000000000000000000001')
})

test('snapshotParams appends the revision as big-endian u64', () => {
  const p = snapshotParams(TIJS, 3)
  assert.equal(p.length, 40)
  assert.equal(
    toHex(p),
    '94296828df5ad8740d45310680ee3c9a000000000000000000000000000000010000000000000003',
  )
  assert.equal(toHex(snapshotParams(TIJS, 0)).slice(64), '0000000000000000')
  // Above 2^32 the high half must carry — a naive 32-bit write would lose this.
  assert.equal(toHex(snapshotParams(TIJS, 0x1_0000_0001)).slice(64), '0000000100000001')
})

test('snapshotParams rejects revisions that are not safe non-negative integers', () => {
  for (const bad of [-1, 1.5, NaN, Number.MAX_SAFE_INTEGER + 2, '3', null, undefined]) {
    assert.throws(() => snapshotParams(TIJS, bad), /revision/i, `should reject: ${bad}`)
  }
})

test('contractId is base58(blake3(code_hash ‖ params)) — live-verified golden ids', () => {
  assert.equal(
    contractId(CODE_HASHES.snapshot, snapshotParams(TIJS, 3)),
    '7GHNZLEQToEYz7Z6Jy6e7JqsSKNB4jgxUru1CwjnucbY',
  )
  assert.equal(
    contractId(CODE_HASHES.object, objectParams(TIJS)),
    'DWzw99Gtxyhu1gDjNKJcVfSsfw9HmEjNLwUrHmxY4VWB',
  )
  assert.equal(
    contractId(CODE_HASHES.index, objectParams(TIJS)),
    'FQ6Qbh6Y9N2syWVciUNtJoeEL28wCq1UNzRDfUJGNKTp',
  )
})

test('createAddressing binds the code hashes and derives all three ids', () => {
  const a = addressing()
  assert.equal(a.snapshotId(TIJS, 3), '7GHNZLEQToEYz7Z6Jy6e7JqsSKNB4jgxUru1CwjnucbY')
  assert.equal(a.headId(TIJS), 'DWzw99Gtxyhu1gDjNKJcVfSsfw9HmEjNLwUrHmxY4VWB')
  assert.equal(a.indexId(TIJS), 'FQ6Qbh6Y9N2syWVciUNtJoeEL28wCq1UNzRDfUJGNKTp')
  assert.equal(a.snapshotId(ROOT, 41), 'ExUAkBcvqWMicnkDwPCn6zf6wxAXU2Nc6Ee6Lbpyzpc8')
})

test('the index lives in its own keyspace but on the TARGET\'s 32-byte params', () => {
  const a = addressing()
  // Same params, different WASM → different id. This is what keeps head and
  // index from colliding even though both are addressed by the bare ref.
  assert.notEqual(a.indexId(TIJS), a.headId(TIJS))
  assert.equal(toHex(objectParams(TIJS)).length, 64, 'index params stay 32 bytes')
})

test('each revision gets its own immutable snapshot address', () => {
  const a = addressing()
  const ids = new Set([0, 1, 2, 3, 41].map(r => a.snapshotId(TIJS, r)))
  assert.equal(ids.size, 5)
})

test('uuid case does not split an object across two addresses', () => {
  const [pubkey, uuid] = TIJS.split('.')
  const upper = `${pubkey}.${uuid.toUpperCase()}`
  assert.equal(toHex(objectParams(upper)), toHex(objectParams(TIJS)))
})

test('createAddressing validates the code hashes it is handed', () => {
  assert.throws(() => createAddressing({}), /code hash/i)
  assert.throws(
    () => createAddressing({ ...CODE_HASHES, index: new Uint8Array(31) }),
    /code hash/i,
  )
})
