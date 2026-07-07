/**
 * Unit tests for src/scaffold.js — schema → draft-spec scaffolding for `ig new`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { placeholderFor, scaffoldContent, buildDraft } from '../src/scaffold.js'
import { ROOT_REF } from '../src/identity.js'

describe('placeholderFor', () => {
  it('strings carry a typed, described placeholder', () => {
    assert.equal(placeholderFor({ type: 'string', description: 'the title' }), '<string: the title>')
    assert.equal(placeholderFor({ type: 'string' }), '<string: replace me>')
  })

  it('optional strings are marked optional', () => {
    assert.equal(placeholderFor({ type: 'string', description: 'a tag' }, { optional: true }), '<optional string: a tag>')
  })

  it('numbers, integers and booleans use typed zero-values', () => {
    assert.equal(placeholderFor({ type: 'number' }), 0)
    assert.equal(placeholderFor({ type: 'integer' }), 0)
    assert.equal(placeholderFor({ type: 'boolean' }), false)
  })

  it('enums list the allowed values', () => {
    assert.equal(placeholderFor({ enum: ['a', 'b', 'c'] }), '<one of: a | b | c>')
  })

  it('arrays of scalars include one example element; object arrays stay empty', () => {
    assert.deepEqual(placeholderFor({ type: 'array', items: { type: 'string', description: 'a tag' } }), ['<string: a tag>'])
    assert.deepEqual(placeholderFor({ type: 'array' }), [])
    assert.deepEqual(placeholderFor({ type: 'array', items: { type: 'object' } }), [])
  })

  it('objects recurse into their properties, or empty when unspecified', () => {
    assert.deepEqual(placeholderFor({ type: 'object' }), {})
    assert.deepEqual(
      placeholderFor({ type: 'object', required: ['x'], properties: { x: { type: 'integer' } } }),
      { x: 0 }
    )
  })

  it('picks the first non-null type from a type union', () => {
    assert.equal(placeholderFor({ type: ['null', 'string'], description: 'maybe' }), '<string: maybe>')
  })
})

describe('scaffoldContent', () => {
  const schema = {
    type: 'object',
    required: ['title', 'count'],
    properties: {
      count: { type: 'integer' },
      title: { type: 'string', description: 'headline' },
      note: { type: 'string', description: 'aside' }
    }
  }

  it('includes every property with the right placeholder type', () => {
    const c = scaffoldContent(schema)
    assert.equal(c.title, '<string: headline>')
    assert.equal(c.count, 0)
    assert.equal(c.note, '<optional string: aside>')
  })

  it('emits required properties before optional ones', () => {
    const keys = Object.keys(scaffoldContent(schema))
    assert.deepEqual(keys, ['title', 'count', 'note'])
  })

  it('a required key missing from properties still appears', () => {
    const c = scaffoldContent({ type: 'object', required: ['ghost'], properties: {} })
    assert.ok('ghost' in c)
  })

  it('returns {} when there is no property schema', () => {
    assert.deepEqual(scaffoldContent(undefined), {})
    assert.deepEqual(scaffoldContent({ type: 'object' }), {})
  })
})

describe('buildDraft', () => {
  const typeRef = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.ba52a919-af7f-460d-9606-6efb284ad9ae'
  const typeObj = { item: { content: { name: 'POST', schema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } } } } } }

  it('scaffolds a full draft with type_def + root relations and a _draft block', () => {
    const draft = buildDraft({ typeObj, typeRef, identityName: 'alt', realm: 'dataverse001' })
    assert.equal(draft.type, 'POST')
    assert.equal(draft.content.title, '<string: replace me>')
    assert.equal(draft.relations.type_def[0].ref, typeRef)
    assert.equal(draft.relations.root[0].ref, ROOT_REF)
    assert.deepEqual(draft._draft, { mode: 'new', type_ref: typeRef, identity: 'alt', realm: 'dataverse001' })
    assert.ok(typeof draft.name === 'string' && typeof draft.instruction === 'string')
  })

  it('omits identity/realm keys from _draft when not supplied', () => {
    const draft = buildDraft({ typeObj, typeRef })
    assert.deepEqual(draft._draft, { mode: 'new', type_ref: typeRef })
  })

  it('a TYPE without a schema still yields a minimal draft (empty content)', () => {
    const noSchema = { item: { content: { name: 'FREEFORM' } } }
    const draft = buildDraft({ typeObj: noSchema, typeRef })
    assert.equal(draft.type, 'FREEFORM')
    assert.deepEqual(draft.content, {})
    assert.equal(draft.relations.type_def[0].ref, typeRef)
  })
})
