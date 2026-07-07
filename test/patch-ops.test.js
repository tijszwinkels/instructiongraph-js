/**
 * Unit tests for src/patch-ops.js — pure item mutations behind
 * `ig set` / `ig relate` / `ig unrelate` and the commit relation checks.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  isValidRef, assertValidRef, assertSettablePath,
  setAtPath, deleteAtPath, addRelation, removeRelation, relationRefErrors
} from '../src/patch-ops.js'

const REF = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.00000000-0000-0000-0000-000000000000'
const TARGET = 'ApWJVWXvVKIIMnH6CP6u8HUyU2gLvyYGnwRlgrWAUwcP.d3d1219a-e755-456c-b02b-3d81cd3bd303'

describe('ref shape', () => {
  it('accepts <pubkey>.<uuid>', () => {
    assert.ok(isValidRef(REF))
    assert.ok(isValidRef(TARGET))
  })
  it('rejects malformed refs', () => {
    for (const bad of ['', 'no-dot', 'pubkey.not-a-uuid', 'short.00000000-0000-0000-0000-000000000000', REF + 'x']) {
      assert.equal(isValidRef(bad), false, bad)
    }
    assert.throws(() => assertValidRef('bad'), /malformed ref/)
  })
})

describe('assertSettablePath', () => {
  it('refuses signature/envelope-managed paths', () => {
    for (const p of ['id', 'ref', 'pubkey', 'revision', 'created_at', 'updated_at', 'signature']) {
      assert.throws(() => assertSettablePath(p), /set automatically/, p)
    }
  })
  it('refuses whole-relations edits and points at relate/unrelate', () => {
    assert.throws(() => assertSettablePath('relations'), /ig relate/)
    assert.throws(() => assertSettablePath('relations.author'), /ig relate/)
    assert.throws(() => assertSettablePath('relations.likes'), /ig relate/)
  })
  it('allows content/name/instruction paths', () => {
    assert.doesNotThrow(() => assertSettablePath('content.title'))
    assert.doesNotThrow(() => assertSettablePath('name'))
    assert.doesNotThrow(() => assertSettablePath('instruction'))
  })
})

describe('setAtPath', () => {
  it('sets a nested value, creating intermediate objects', () => {
    const item = { content: {} }
    setAtPath(item, 'content.meta.version', 2)
    assert.equal(item.content.meta.version, 2)
  })
  it('sets a top-level field', () => {
    const item = { content: {} }
    setAtPath(item, 'name', 'Hello')
    assert.equal(item.name, 'Hello')
  })
  it('throws when an intermediate is not an object', () => {
    const item = { content: { title: 'x' } }
    assert.throws(() => setAtPath(item, 'content.title.deep', 1), /not an object/)
  })
})

describe('deleteAtPath', () => {
  it('removes an existing key', () => {
    const item = { content: { title: 'x', body: 'y' } }
    deleteAtPath(item, 'content.body')
    assert.deepEqual(item.content, { title: 'x' })
  })
  it('errors when the key is absent (state mismatch, no silent no-op)', () => {
    const item = { content: { title: 'x' } }
    assert.throws(() => deleteAtPath(item, 'content.missing'), /not set/)
  })
})

describe('addRelation', () => {
  it('creates the array and appends the entry', () => {
    const item = { ref: REF, relations: {} }
    addRelation(item, 'likes', TARGET)
    assert.deepEqual(item.relations.likes, [{ ref: TARGET }])
  })
  it('carries instruction and url when supplied', () => {
    const item = { ref: REF, relations: {} }
    addRelation(item, 'cites', TARGET, { instruction: 'see also', url: 'https://x' })
    assert.deepEqual(item.relations.cites, [{ ref: TARGET, instruction: 'see also', url: 'https://x' }])
  })
  it('errors "already related" on a duplicate with no new metadata', () => {
    const item = { ref: REF, relations: { likes: [{ ref: TARGET }] } }
    assert.throws(() => addRelation(item, 'likes', TARGET), /already related/)
  })
  it('updates instruction/url on an existing entry instead of erroring', () => {
    const item = { ref: REF, relations: { likes: [{ ref: TARGET }] } }
    addRelation(item, 'likes', TARGET, { instruction: 'updated' })
    assert.equal(item.relations.likes[0].instruction, 'updated')
  })
  it('refuses the author relation', () => {
    assert.throws(() => addRelation({ ref: REF, relations: {} }, 'author', TARGET), /author/)
  })
  it('validates the target ref shape', () => {
    assert.throws(() => addRelation({ ref: REF, relations: {} }, 'likes', 'bad'), /malformed ref/)
  })
})

describe('removeRelation', () => {
  it('removes an entry and drops the key when the array empties', () => {
    const item = { ref: REF, relations: { likes: [{ ref: TARGET }] } }
    removeRelation(item, 'likes', TARGET)
    assert.ok(!('likes' in item.relations))
  })
  it('keeps other entries in the array', () => {
    const other = 'ApWJVWXvVKIIMnH6CP6u8HUyU2gLvyYGnwRlgrWAUwcP.11111111-1111-1111-1111-111111111111'
    const item = { ref: REF, relations: { likes: [{ ref: TARGET }, { ref: other }] } }
    removeRelation(item, 'likes', TARGET)
    assert.deepEqual(item.relations.likes, [{ ref: other }])
  })
  it('errors when the relation is absent (state mismatch)', () => {
    assert.throws(() => removeRelation({ ref: REF, relations: {} }, 'likes', TARGET), /not related/)
  })
  it('refuses the author relation', () => {
    assert.throws(() => removeRelation({ ref: REF, relations: { author: [{ ref: TARGET }] } }, 'author', TARGET), /author/)
  })
})

describe('relationRefErrors', () => {
  it('flags malformed refs with a JSON path, allows well-formed ones', () => {
    const item = { relations: { author: [{ ref: REF }], cites: [{ ref: 'bad' }, { ref: TARGET }] } }
    const errors = relationRefErrors(item)
    assert.equal(errors.length, 1)
    assert.match(errors[0], /relations\.cites\[0\]/)
  })
  it('returns [] for an item with no relations', () => {
    assert.deepEqual(relationRefErrors({}), [])
  })
})
