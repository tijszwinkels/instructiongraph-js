import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isVisible } from '../src/store/realm-filter.js'

function obj(realms) {
  return { item: { in: realms } }
}

const PK_ALICE = 'AliceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const PK_BOB = 'BobBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'
const SHARED_REALM = 'AliceAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA.TeamAlpha'

describe('isVisible', () => {
  it('public object is always visible', () => {
    assert.equal(isVisible(obj(['dataverse001']), PK_ALICE, []), true)
    assert.equal(isVisible(obj(['dataverse001']), PK_BOB, []), true)
    assert.equal(isVisible(obj(['dataverse001']), null, []), true)
  })

  it('identity-realm object visible to owner', () => {
    assert.equal(isVisible(obj([PK_ALICE]), PK_ALICE, []), true)
  })

  it('identity-realm object not visible to others', () => {
    assert.equal(isVisible(obj([PK_ALICE]), PK_BOB, []), false)
  })

  it('shared-realm object visible to members', () => {
    assert.equal(isVisible(obj([SHARED_REALM]), PK_BOB, [SHARED_REALM]), true)
  })

  it('shared-realm object not visible to non-members', () => {
    assert.equal(isVisible(obj([SHARED_REALM]), PK_BOB, []), false)
  })

  it('multi-realm object visible if any realm matches', () => {
    assert.equal(isVisible(obj([PK_ALICE, SHARED_REALM]), PK_BOB, [SHARED_REALM]), true)
    assert.equal(isVisible(obj([SHARED_REALM, 'dataverse001']), PK_BOB, []), true)
  })

  it('object with no realms is not visible', () => {
    assert.equal(isVisible(obj([]), PK_ALICE, []), false)
  })

  it('null/missing item.in is not visible', () => {
    assert.equal(isVisible({ item: {} }, PK_ALICE, []), false)
    assert.equal(isVisible({}, PK_ALICE, []), false)
    assert.equal(isVisible(null, PK_ALICE, []), false)
  })

  it('empty shared realm list — only public + own identity visible', () => {
    assert.equal(isVisible(obj(['dataverse001']), PK_ALICE, []), true)
    assert.equal(isVisible(obj([PK_ALICE]), PK_ALICE, []), true)
    assert.equal(isVisible(obj([SHARED_REALM]), PK_ALICE, []), false)
  })

  it('local realm is always visible', () => {
    assert.equal(isVisible(obj(['local']), PK_ALICE, []), true)
    assert.equal(isVisible(obj(['local']), PK_BOB, []), true)
    assert.equal(isVisible(obj(['local']), null, []), true)
  })

  it('local realm with other realms is visible', () => {
    assert.equal(isVisible(obj(['local', 'dataverse001']), PK_ALICE, []), true)
    assert.equal(isVisible(obj(['local', PK_ALICE]), PK_BOB, []), true)
  })

  it('server-public realm is always visible', () => {
    assert.equal(isVisible(obj(['server-public']), PK_ALICE, []), true)
    assert.equal(isVisible(obj(['server-public']), PK_BOB, []), true)
    assert.equal(isVisible(obj(['server-public']), null, []), true)
  })

  it('server-public realm with other realms is visible', () => {
    assert.equal(isVisible(obj(['server-public', 'dataverse001']), PK_ALICE, []), true)
    assert.equal(isVisible(obj(['server-public', PK_ALICE]), PK_BOB, []), true)
  })
})
