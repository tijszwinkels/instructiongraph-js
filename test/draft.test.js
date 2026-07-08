/**
 * Unit tests for src/draft.js — draft parsing/envelope checks behind `ig commit`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDraftJSON, extractDraft, envelopeErrors, resolveCommitTarget, ALLOWED_TOP_LEVEL
} from '../src/draft.js'

describe('parseDraftJSON', () => {
  it('parses valid JSON', () => {
    assert.deepEqual(parseDraftJSON('{"a":1}'), { a: 1 })
  })
  it('reports line and column on a syntax error', () => {
    assert.throws(() => parseDraftJSON('{\n  "a": 1,\n  bad\n}'), /line \d+ column \d+/)
  })
})

describe('extractDraft', () => {
  it('splits _draft from the signed payload', () => {
    const { draft, payload } = extractDraft({ type: 'POST', _draft: { mode: 'new' }, content: {} })
    assert.deepEqual(draft, { mode: 'new' })
    assert.ok(!('_draft' in payload))
    assert.equal(payload.type, 'POST')
  })
  it('returns null draft when absent', () => {
    const { draft } = extractDraft({ type: 'POST' })
    assert.equal(draft, null)
  })
})

describe('envelopeErrors', () => {
  it('accepts a payload of only allowed fields', () => {
    assert.deepEqual(envelopeErrors({ type: 'POST', name: 'x', content: {}, relations: {} }), [])
  })
  it('flags unknown top-level fields and lists the allowed set', () => {
    const errors = envelopeErrors({ type: 'POST', titel: 'typo' })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /titel/)
    assert.match(errors[0], /allowed/)
  })
  it('flags signature-managed fields with a remove hint', () => {
    const errors = envelopeErrors({ type: 'POST', pubkey: 'x', signature: 'y' })
    assert.equal(errors.length, 2)
    assert.ok(errors.every(e => /remove/.test(e)))
  })
  it('exposes the allowed field set (checkout payloads pass)', () => {
    for (const f of ['id', 'created_at', 'updated_at', 'revision', 'in']) {
      assert.ok(ALLOWED_TOP_LEVEL.has(f), f)
    }
    assert.deepEqual(envelopeErrors({ id: 'x', in: ['r'], created_at: 't', revision: 2, type: 'POST', content: {} }), [])
  })
})

describe('resolveCommitTarget', () => {
  it('CLI flags win over _draft values', () => {
    const r = resolveCommitTarget({
      draft: { identity: 'draftId', realm: 'draftRealm' },
      flagIdentity: 'flagId', flagRealm: 'flagRealm', activeIdentity: 'active', defaultRealm: 'def'
    })
    assert.equal(r.identity, 'flagId')
    assert.equal(r.realm, 'flagRealm')
    assert.equal(r.identitySource, 'flag')
  })
  it('falls back to _draft when no flag', () => {
    const r = resolveCommitTarget({ draft: { identity: 'draftId', realm: 'draftRealm' }, activeIdentity: 'active', defaultRealm: 'def' })
    assert.equal(r.identity, 'draftId')
    assert.equal(r.identitySource, 'draft')
    assert.equal(r.realm, 'draftRealm')
  })
  it('falls back to the active identity / default realm, flagging the fallback', () => {
    const r = resolveCommitTarget({ draft: null, activeIdentity: 'active', defaultRealm: 'def' })
    assert.equal(r.identity, 'active')
    assert.equal(r.identitySource, 'fallback')
    assert.equal(r.realm, 'def')
    assert.equal(r.realmSource, 'fallback')
  })
})
