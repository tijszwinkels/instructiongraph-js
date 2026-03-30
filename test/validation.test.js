import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateSchema } from '../src/validation.js'

describe('validateSchema', () => {
  it('returns empty for no schema', () => {
    assert.deepEqual(validateSchema({}, null), [])
    assert.deepEqual(validateSchema({}, {}), [])
  })

  it('validates required fields', () => {
    const schema = { type: 'object', required: ['title', 'body'] }
    const errors = validateSchema({ title: 'Hi' }, schema)
    assert.equal(errors.length, 1)
    assert.ok(errors[0].includes('body'))
    assert.ok(errors[0].includes('required'))
  })

  it('passes when all required fields present', () => {
    const schema = { type: 'object', required: ['title'] }
    assert.deepEqual(validateSchema({ title: 'Hi' }, schema), [])
  })

  it('validates property types', () => {
    const schema = {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        name: { type: 'string' }
      }
    }
    const errors = validateSchema({ count: 'not-a-number', name: 42 }, schema)
    assert.equal(errors.length, 2)
  })

  it('validates enum values', () => {
    const schema = {
      type: 'object',
      properties: {
        status: { enum: ['draft', 'published'] }
      }
    }
    const errors = validateSchema({ status: 'deleted' }, schema)
    assert.equal(errors.length, 1)
    assert.ok(errors[0].includes('must be one of'))
  })

  it('validates array items', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } }
      }
    }
    assert.deepEqual(validateSchema({ tags: ['a', 'b'] }, schema), [])

    const errors = validateSchema({ tags: ['a', 42] }, schema)
    assert.equal(errors.length, 1)
    assert.ok(errors[0].includes('tags[1]'))
  })

  it('validates nested objects', () => {
    const schema = {
      type: 'object',
      properties: {
        meta: {
          type: 'object',
          required: ['author'],
          properties: {
            author: { type: 'string' }
          }
        }
      }
    }
    const errors = validateSchema({ meta: {} }, schema)
    assert.equal(errors.length, 1)
    assert.ok(errors[0].includes('meta.author'))
  })

  it('supports multiple types', () => {
    const schema = { type: ['string', 'null'] }
    assert.deepEqual(validateSchema('hello', schema), [])
    assert.deepEqual(validateSchema(null, schema), [])
    assert.equal(validateSchema(42, schema).length, 1)
  })

  it('short-circuits on type mismatch', () => {
    const schema = {
      type: 'object',
      required: ['field'],
      properties: { field: { type: 'string' } }
    }
    // If value isn't an object, don't report missing fields
    const errors = validateSchema('not-an-object', schema)
    assert.equal(errors.length, 1)
    assert.ok(errors[0].includes('must be object'))
  })
})
