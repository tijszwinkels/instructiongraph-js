/**
 * Deterministic addressing: uuid_v5 (RFC 4122 §4.3) + repo object/ref ids.
 * Vectors cross-checked against Python's uuid.uuid5.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { uuidv5, objId, refId, objRef, refRef } from '../src/git/addressing.js'

const REPO = '442843db-fc95-4e83-8b1a-000000000000'
const OID = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'
const OWNER = 'ApWJVWXvVKIIMnH6CP6u8HUyU2gLvyYGnwRlgrWAUwcP'

test('uuidv5 matches the RFC DNS-namespace vector', async () => {
  const id = await uuidv5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')
  assert.equal(id, '2ed6657d-e927-568b-95e1-2665a8aea6a2')
})

test('objId / refId match Python uuid5 vectors', async () => {
  assert.equal(await objId(REPO, OID), '922280f1-1135-5150-8759-e757b1a4e9af')
  assert.equal(await refId(REPO, 'refs/heads/main'), 'ad73b71a-2e29-5484-b500-00818428f993')
  assert.equal(await refId(REPO, 'HEAD'), '4011c7e2-2e20-5e90-bbc2-37bae6d95ad2')
})

test('objRef / refRef compose owner pubkey + id', async () => {
  assert.equal(await objRef(OWNER, REPO, OID), `${OWNER}.922280f1-1135-5150-8759-e757b1a4e9af`)
  assert.equal(await refRef(OWNER, REPO, 'HEAD'), `${OWNER}.4011c7e2-2e20-5e90-bbc2-37bae6d95ad2`)
})

test('uuidv5 sets version 5 and RFC variant bits', async () => {
  const id = await uuidv5(REPO, 'obj:' + OID)
  assert.equal(id[14], '5', 'version nibble must be 5')
  assert.match(id[19], /^[89ab]$/, 'variant nibble must be 8..b')
})

test('addressing is namespaced by repo — same oid, different repo → different id', async () => {
  const a = await objId(REPO, OID)
  const b = await objId('00000000-0000-4000-8000-000000000000', OID)
  assert.notEqual(a, b)
})
