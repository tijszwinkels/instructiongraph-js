import test from 'node:test'
import assert from 'node:assert/strict'

import { buildItem, makeRef, parseRef, tombstone } from '../src/object.js'

test('parseRef and makeRef are inverse operations', () => {
  const ref = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.346bef5e-94ff-4f7a-bcf6-d78ae1e1541c'
  assert.deepEqual(parseRef(ref), {
    pubkey: 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ',
    id: '346bef5e-94ff-4f7a-bcf6-d78ae1e1541c',
  })
  assert.equal(makeRef(parseRef(ref)), ref)
})

test('buildItem fills required fields and defaults', () => {
  const item = buildItem({
    id: '44444444-4444-4444-8444-444444444444',
    pubkey: 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ',
    type: 'POST',
    content: { title: 'Hello' },
  })

  assert.equal(item.ref, `${item.pubkey}.${item.id}`)
  assert.deepEqual(item.in, ['dataverse001'])
  assert.deepEqual(item.relations, {})
  assert.equal(item.type, 'POST')
  assert.deepEqual(item.content, { title: 'Hello' })
})

test('buildItem preserves optional fields', () => {
  const item = buildItem({
    id: '55555555-5555-4555-8555-555555555555',
    pubkey: 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ',
    in: ['custom'],
    type: 'POST',
    name: 'My Post',
    instruction: 'Display this nicely.',
    relations: { author: [{ ref: 'pk.uuid' }] },
    content: { title: 'Hello' },
    created_at: '2026-03-30T01:02:03Z',
  })

  assert.equal(item.name, 'My Post')
  assert.equal(item.instruction, 'Display this nicely.')
  assert.deepEqual(item.relations, { author: [{ ref: 'pk.uuid' }] })
  assert.equal(item.created_at, '2026-03-30T01:02:03Z')
  assert.deepEqual(item.in, ['custom'])
})

test('tombstone converts an item into a DELETED revision bump', () => {
  const deleted = tombstone({
    id: '66666666-6666-4666-8666-666666666666',
    pubkey: 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ',
    ref: 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.66666666-6666-4666-8666-666666666666',
    in: ['dataverse001'],
    created_at: '2026-03-01T00:00:00Z',
    updated_at: '2026-03-02T00:00:00Z',
    revision: 7,
    type: 'POST',
    relations: { author: [{ ref: 'pk.uuid' }] },
    content: { title: 'Hello' },
  }, { now: '2026-03-30T00:00:00Z' })

  assert.equal(deleted.type, 'DELETED')
  assert.equal(deleted.revision, 8)
  assert.deepEqual(deleted.relations, {})
  assert.deepEqual(deleted.content, {})
  assert.equal(deleted.updated_at, '2026-03-30T00:00:00Z')
  assert.equal(deleted.created_at, '2026-03-01T00:00:00Z')
})
