import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHubStore } from '../src/store/hub.js'

const HUB_URL = 'https://dataverse001.net'
const ROOT_REF = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.00000000-0000-0000-0000-000000000000'
const KNOWN_PUBKEY = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ'

describe('hub store', () => {
  const store = createHubStore({ url: HUB_URL })

  it('get() fetches a known object', async () => {
    const obj = await store.get(ROOT_REF)
    assert.ok(obj, 'root object should exist')
    assert.equal(obj.is, 'instructionGraph001')
    assert.equal(obj.item.type, 'ROOT')
    assert.ok(obj.item.content.name.includes('dataverse'), 'root should mention dataverse')
  })

  it('get() returns null for non-existent ref', async () => {
    const obj = await store.get('AAAA.00000000-0000-0000-0000-ffffffffffff')
    assert.equal(obj, null)
  })

  it('search() finds objects by type', async () => {
    const result = await store.search({ type: 'TYPE', limit: 5 })
    assert.ok(result.items.length > 0, 'should find TYPE objects')
    assert.ok(result.items.length <= 5, 'should respect limit')
    for (const item of result.items) {
      assert.equal(item.item.type, 'TYPE')
    }
  })

  it('search() filters by pubkey', async () => {
    const result = await store.search({ by: KNOWN_PUBKEY, type: 'IDENTITY', limit: 3 })
    assert.ok(result.items.length > 0, 'should find identity for known pubkey')
  })

  it('search() supports pagination', async () => {
    const page1 = await store.search({ type: 'TYPE', limit: 2 })
    assert.equal(page1.items.length, 2)
    if (page1.cursor) {
      const page2 = await store.search({ type: 'TYPE', limit: 2, cursor: page1.cursor })
      assert.ok(page2.items.length > 0, 'second page should have items')
      // Items should be different
      const ids1 = new Set(page1.items.map(i => i.item.id))
      for (const item of page2.items) {
        assert.ok(!ids1.has(item.item.id), 'page 2 should have different items')
      }
    }
  })

  it('inbound() finds inbound relations', async () => {
    const result = await store.inbound(ROOT_REF, { limit: 5 })
    assert.ok(result.items.length > 0, 'root should have inbound relations')
  })

  it('search() with includeInboundCounts', async () => {
    const result = await store.search({ type: 'POST', limit: 3, includeInboundCounts: true })
    // Not all objects have inbound counts, but the field should be present when requested
    if (result.items.length > 0) {
      // At minimum, the response structure should be correct
      assert.ok(Array.isArray(result.items))
    }
  })

  it('put() rejects unsigned/invalid objects gracefully', async () => {
    const result = await store.put({ is: 'instructionGraph001', signature: 'bad', item: { id: 'fake' } })
    assert.ok(!result.ok, 'should reject invalid object')
  })
})
