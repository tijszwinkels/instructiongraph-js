import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseRef, makeRef, isEnvelope, buildItem, tombstone } from '../src/object.js'

describe('object', () => {
  describe('parseRef', () => {
    it('splits pubkey.uuid', () => {
      const ref = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.346bef5e-94ff-4f7a-bcf6-d78ae1e1541c'
      const { pubkey, id } = parseRef(ref)
      assert.equal(pubkey, 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ')
      assert.equal(id, '346bef5e-94ff-4f7a-bcf6-d78ae1e1541c')
    })

    it('throws on invalid ref', () => {
      assert.throws(() => parseRef('no-dot-here'), /Invalid ref/)
      assert.throws(() => parseRef(''), /Invalid ref/)
    })
  })

  describe('makeRef', () => {
    it('joins pubkey and id', () => {
      assert.equal(makeRef('ABC', '123'), 'ABC.123')
    })
  })

  describe('isEnvelope', () => {
    it('detects valid envelope', () => {
      assert.ok(isEnvelope({ is: 'instructionGraph001', signature: 'x', item: {} }))
    })
    it('rejects non-envelope', () => {
      assert.ok(!isEnvelope({ type: 'POST' }))
      assert.ok(!isEnvelope(null))
      assert.ok(!isEnvelope({ is: 'other', signature: 'x', item: {} }))
    })
  })

  describe('buildItem', () => {
    it('creates item with required fields', () => {
      const item = buildItem({
        pubkey: 'AxyU5_test',
        type: 'POST',
        content: { title: 'Hello' }
      })
      assert.ok(item.id, 'should have UUID id')
      assert.equal(item.pubkey, 'AxyU5_test')
      assert.equal(item.ref, 'AxyU5_test.' + item.id)
      assert.ok(item.created_at, 'should have created_at')
      assert.equal(item.type, 'POST')
      assert.deepEqual(item.content, { title: 'Hello' })
      assert.deepEqual(item.in, ['AxyU5_test'], 'default realm should be pubkey (private)')
    })

    it('respects custom realm', () => {
      const item = buildItem({
        pubkey: 'pk',
        type: 'TEST',
        in: ['custom-realm'],
        content: {}
      })
      assert.deepEqual(item.in, ['custom-realm'])
    })

    it('auto-adds author relation from identityRef', () => {
      const item = buildItem({
        pubkey: 'pk',
        type: 'POST',
        content: {},
        identityRef: 'pk.00000000-0000-0000-0000-000000000001',
        relations: { type_def: [{ ref: 'x.y' }] }
      })
      assert.ok(item.relations.author, 'should have author')
      assert.equal(item.relations.author[0].ref, 'pk.00000000-0000-0000-0000-000000000001')
      assert.ok(item.relations.type_def, 'should keep provided relations')
    })

    it('accepts explicit id', () => {
      const item = buildItem({
        pubkey: 'pk',
        type: 'TEST',
        id: 'my-explicit-id',
        content: {}
      })
      assert.equal(item.id, 'my-explicit-id')
      assert.equal(item.ref, 'pk.my-explicit-id')
    })

    it('includes optional fields when provided', () => {
      const item = buildItem({
        pubkey: 'pk',
        type: 'SPEC',
        content: {},
        name: 'My Spec',
        instruction: 'Do the thing',
        rights: { license: 'CC0-1.0', ai_training_allowed: true }
      })
      assert.equal(item.name, 'My Spec')
      assert.equal(item.instruction, 'Do the thing')
      assert.deepEqual(item.rights, { license: 'CC0-1.0', ai_training_allowed: true })
    })
  })

  describe('tombstone', () => {
    it('creates DELETED item from existing', () => {
      const original = {
        id: 'abc-123',
        pubkey: 'pk',
        ref: 'pk.abc-123',
        in: ['pk'],
        created_at: '2026-01-01T00:00:00Z',
        revision: 3,
        type: 'POST',
        content: { title: 'old' },
        relations: { author: [{ ref: 'pk.id' }] }
      }
      const ts = tombstone(original)
      assert.equal(ts.id, 'abc-123')
      assert.equal(ts.pubkey, 'pk')
      assert.equal(ts.ref, 'pk.abc-123')
      assert.deepEqual(ts.in, ['pk'])
      assert.equal(ts.created_at, '2026-01-01T00:00:00Z')
      assert.equal(ts.revision, 4)
      assert.equal(ts.type, 'DELETED')
      assert.deepEqual(ts.content, {})
      assert.deepEqual(ts.relations, {})
      assert.ok(ts.updated_at, 'should have updated_at')
    })
  })
})
