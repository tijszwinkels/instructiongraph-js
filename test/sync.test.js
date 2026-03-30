import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSyncStore } from '../src/store/sync.js'

/** In-memory mock store for testing */
function createMockStore(objects = {}) {
  const data = { ...objects }
  return {
    data,
    async get(ref) { return data[ref] || null },
    async put(obj) {
      const ref = obj.item.ref
      data[ref] = obj
      return { ok: true }
    },
    async search() { return { items: Object.values(data), cursor: null } },
    async inbound() { return { items: [], cursor: null } }
  }
}

function makeObj(ref, revision = 0) {
  return {
    is: 'instructionGraph001',
    signature: 'mock',
    item: { ref, id: ref.split('.')[1], pubkey: ref.split('.')[0], revision, type: 'TEST', created_at: '2026-01-01T00:00:00Z', content: {} }
  }
}

describe('sync store', () => {
  it('get: returns from remote when local is null', async () => {
    const local = createMockStore()
    const remote = createMockStore({ 'pk.1': makeObj('pk.1', 2) })
    const sync = createSyncStore({ local, remote })

    const obj = await sync.get('pk.1')
    assert.ok(obj, 'should find remote object')
    assert.equal(obj.item.revision, 2)
    // Should have synced to local
    assert.ok(local.data['pk.1'], 'should sync to local')
  })

  it('get: returns from local when remote is null', async () => {
    const local = createMockStore({ 'pk.1': makeObj('pk.1', 3) })
    const remote = createMockStore()
    const sync = createSyncStore({ local, remote })

    const obj = await sync.get('pk.1')
    assert.ok(obj)
    assert.equal(obj.item.revision, 3)
    // Should have synced to remote
    assert.ok(remote.data['pk.1'], 'should sync to remote')
  })

  it('get: keeps higher revision (remote wins)', async () => {
    const local = createMockStore({ 'pk.1': makeObj('pk.1', 1) })
    const remote = createMockStore({ 'pk.1': makeObj('pk.1', 5) })
    const sync = createSyncStore({ local, remote })

    const obj = await sync.get('pk.1')
    assert.equal(obj.item.revision, 5)
    assert.equal(local.data['pk.1'].item.revision, 5, 'local should be updated')
  })

  it('get: keeps higher revision (local wins)', async () => {
    const local = createMockStore({ 'pk.1': makeObj('pk.1', 7) })
    const remote = createMockStore({ 'pk.1': makeObj('pk.1', 3) })
    const sync = createSyncStore({ local, remote })

    const obj = await sync.get('pk.1')
    assert.equal(obj.item.revision, 7)
    assert.equal(remote.data['pk.1'].item.revision, 7, 'remote should be updated')
  })

  it('get: returns null when both are null', async () => {
    const sync = createSyncStore({ local: createMockStore(), remote: createMockStore() })
    const obj = await sync.get('pk.missing')
    assert.equal(obj, null)
  })

  it('put: writes to both local and remote', async () => {
    const local = createMockStore()
    const remote = createMockStore()
    const sync = createSyncStore({ local, remote })

    const obj = makeObj('pk.new', 0)
    await sync.put(obj)
    assert.ok(local.data['pk.new'])
    assert.ok(remote.data['pk.new'])
  })

  it('put: remote failure is non-fatal', async () => {
    const local = createMockStore()
    const remote = {
      async get() { return null },
      async put() { throw new Error('network down') },
      async search() { return { items: [], cursor: null } },
      async inbound() { return { items: [], cursor: null } }
    }
    const sync = createSyncStore({ local, remote })

    const obj = makeObj('pk.offline', 0)
    const result = await sync.put(obj)
    assert.ok(result.ok, 'should succeed locally')
    assert.ok(local.data['pk.offline'], 'local should have the object')
  })
})
