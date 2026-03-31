import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSyncStore } from '../src/store/sync.js'

/** In-memory mock store for testing */
function createMockStore(objects = {}) {
  const data = { ...objects }
  const calls = []
  return {
    data,
    calls,
    async get(ref, opts = {}) {
      calls.push({ method: 'get', ref, opts })
      return data[ref] || null
    },
    async put(obj) {
      const ref = obj.item.ref
      calls.push({ method: 'put', ref })
      data[ref] = obj
      return { ok: true }
    },
    async search(query) { return { items: Object.values(data), cursor: null } },
    async inbound() { return { items: [], cursor: null } }
  }
}

/** Mock hub store that supports localRevision → _notModified */
function createMockHubStore(objects = {}) {
  const data = { ...objects }
  const calls = []
  return {
    data,
    calls,
    async get(ref, opts = {}) {
      calls.push({ method: 'get', ref, opts })
      const obj = data[ref] || null
      // Simulate ETag: if localRevision matches, return 304
      if (obj && opts.localRevision != null && obj.item.revision === opts.localRevision) {
        return { _notModified: true }
      }
      return obj
    },
    async put(obj) {
      const ref = obj.item.ref
      calls.push({ method: 'put', ref })
      data[ref] = obj
      return { ok: true }
    },
    async search(query) { return { items: Object.values(data), cursor: null } },
    async inbound() { return { items: [], cursor: null } }
  }
}

/** Mock hub store that simulates being unreachable */
function createUnreachableStore() {
  return {
    async get() { throw new Error('network down') },
    async put() { throw new Error('network down') },
    async search() { throw new Error('network down') },
    async inbound() { throw new Error('network down') }
  }
}

function makeObj(ref, revision = 0, realms = ['dataverse001']) {
  return {
    is: 'instructionGraph001',
    signature: 'mock',
    item: { ref, id: ref.split('.')[1], pubkey: ref.split('.')[0], revision, in: realms, type: 'TEST', created_at: '2026-01-01T00:00:00Z', content: {} }
  }
}

describe('sync store', () => {
  describe('get: hub-first with ETag', () => {
    it('sends localRevision to hub for ETag', async () => {
      const local = createMockStore({ 'pk.1': makeObj('pk.1', 3) })
      const remote = createMockHubStore({ 'pk.1': makeObj('pk.1', 3) })
      const sync = createSyncStore({ local, remote })

      const obj = await sync.get('pk.1')
      assert.equal(obj.item.revision, 3)
      // Hub should have received localRevision=3
      const hubGet = remote.calls.find(c => c.method === 'get')
      assert.equal(hubGet.opts.localRevision, 3)
    })

    it('returns local on 304 (not modified)', async () => {
      const localObj = makeObj('pk.1', 5)
      const local = createMockStore({ 'pk.1': localObj })
      const remote = createMockHubStore({ 'pk.1': makeObj('pk.1', 5) }) // same rev → 304
      const sync = createSyncStore({ local, remote })

      const obj = await sync.get('pk.1')
      assert.equal(obj, localObj, 'should return exact local object')
      // No put should have been called
      assert.equal(local.calls.filter(c => c.method === 'put').length, 0)
      assert.equal(remote.calls.filter(c => c.method === 'put').length, 0)
    })

    it('caches hub result locally when hub is newer', async () => {
      const local = createMockStore({ 'pk.1': makeObj('pk.1', 1) })
      const remote = createMockHubStore({ 'pk.1': makeObj('pk.1', 5) })
      const sync = createSyncStore({ local, remote })

      const obj = await sync.get('pk.1')
      assert.equal(obj.item.revision, 5)
      // Wait for background cache
      await new Promise(r => setTimeout(r, 10))
      assert.equal(local.data['pk.1'].item.revision, 5, 'local should be updated')
    })

    it('pushes local to hub when local is newer', async () => {
      const local = createMockStore({ 'pk.1': makeObj('pk.1', 7) })
      const remote = createMockHubStore({ 'pk.1': makeObj('pk.1', 3) })
      const sync = createSyncStore({ local, remote })

      const obj = await sync.get('pk.1')
      assert.equal(obj.item.revision, 7)
      // Wait for background push
      await new Promise(r => setTimeout(r, 10))
      assert.equal(remote.data['pk.1'].item.revision, 7, 'hub should be updated')
    })

    it('pushes local to hub when hub returns 404', async () => {
      const local = createMockStore({ 'pk.1': makeObj('pk.1', 3) })
      const remote = createMockHubStore() // empty hub
      const sync = createSyncStore({ local, remote })

      const obj = await sync.get('pk.1')
      assert.equal(obj.item.revision, 3)
      // Wait for background push
      await new Promise(r => setTimeout(r, 10))
      assert.equal(remote.data['pk.1'].item.revision, 3, 'hub should get the object')
    })

    it('caches hub-only object locally', async () => {
      const local = createMockStore() // empty local
      const remote = createMockHubStore({ 'pk.1': makeObj('pk.1', 2) })
      const sync = createSyncStore({ local, remote })

      const obj = await sync.get('pk.1')
      assert.equal(obj.item.revision, 2)
      // Wait for background cache
      await new Promise(r => setTimeout(r, 10))
      assert.ok(local.data['pk.1'], 'should sync to local')
    })

    it('returns null when both are null', async () => {
      const sync = createSyncStore({ local: createMockStore(), remote: createMockHubStore() })
      const obj = await sync.get('pk.missing')
      assert.equal(obj, null)
    })
  })

  describe('get: hub fallback', () => {
    it('falls back to local when hub is unreachable', async () => {
      const local = createMockStore({ 'pk.1': makeObj('pk.1', 3) })
      const remote = createUnreachableStore()
      const sync = createSyncStore({ local, remote })

      const obj = await sync.get('pk.1')
      assert.equal(obj.item.revision, 3)
    })

    it('returns null when hub unreachable and no local', async () => {
      const local = createMockStore()
      const remote = createUnreachableStore()
      const sync = createSyncStore({ local, remote })

      const obj = await sync.get('pk.missing')
      assert.equal(obj, null)
    })
  })

  describe('put', () => {
    it('writes to both local and remote', async () => {
      const local = createMockStore()
      const remote = createMockHubStore()
      const sync = createSyncStore({ local, remote })

      const obj = makeObj('pk.new', 0)
      await sync.put(obj)
      assert.ok(local.data['pk.new'])
      assert.ok(remote.data['pk.new'])
    })

    it('remote failure is non-fatal', async () => {
      const local = createMockStore()
      const remote = createUnreachableStore()
      const sync = createSyncStore({ local, remote })

      const obj = makeObj('pk.offline', 0)
      const result = await sync.put(obj)
      assert.ok(result.ok, 'should succeed locally')
      assert.ok(local.data['pk.offline'], 'local should have the object')
    })
  })

  describe('search: merge + cache', () => {
    it('merges results from both stores', async () => {
      const local = createMockStore({ 'pk.1': makeObj('pk.1', 1) })
      const remote = createMockHubStore({ 'pk.2': makeObj('pk.2', 1) })
      const sync = createSyncStore({ local, remote })

      const result = await sync.search({})
      assert.equal(result.items.length, 2)
      const refs = result.items.map(i => i.item.ref).sort()
      assert.deepEqual(refs, ['pk.1', 'pk.2'])
    })

    it('deduplicates by ref, preferring higher revision', async () => {
      const local = createMockStore({ 'pk.1': makeObj('pk.1', 1) })
      const remote = createMockHubStore({ 'pk.1': makeObj('pk.1', 5) })
      const sync = createSyncStore({ local, remote })

      const result = await sync.search({})
      assert.equal(result.items.length, 1)
      assert.equal(result.items[0].item.revision, 5)
    })

    it('caches hub search results locally', async () => {
      const local = createMockStore()
      const remote = createMockHubStore({ 'pk.1': makeObj('pk.1', 2) })
      const sync = createSyncStore({ local, remote })

      await sync.search({})
      // Wait for background cache
      await new Promise(r => setTimeout(r, 10))
      assert.ok(local.data['pk.1'], 'hub result should be cached locally')
    })

    it('falls back to local when hub unreachable', async () => {
      const local = createMockStore({ 'pk.1': makeObj('pk.1', 1) })
      const remote = createUnreachableStore()
      const sync = createSyncStore({ local, remote })

      const result = await sync.search({})
      assert.equal(result.items.length, 1)
    })
  })

  describe('inbound: merge + cache', () => {
    it('caches hub inbound results locally', async () => {
      const inboundObj = makeObj('pk.2', 1)
      const local = createMockStore()
      const remote = {
        ...createMockHubStore(),
        async inbound() { return { items: [inboundObj], cursor: null } }
      }
      const sync = createSyncStore({ local, remote })

      const result = await sync.inbound('pk.target', { relation: 'author' })
      assert.equal(result.items.length, 1)
      // Wait for background cache
      await new Promise(r => setTimeout(r, 10))
      assert.ok(local.data['pk.2'], 'inbound result should be cached locally')
    })
  })

  describe('pushAll: push all local objects to remote', () => {
    it('pushes all local objects to hub', async () => {
      const local = createMockStore({
        'pk.1': makeObj('pk.1', 1),
        'pk.2': makeObj('pk.2', 2),
        'pk.3': makeObj('pk.3', 0)
      })
      const remote = createMockHubStore()
      const sync = createSyncStore({ local, remote })

      const result = await sync.pushAll()
      assert.equal(result.total, 3)
      assert.equal(result.pushed, 3)
      assert.equal(result.errors, 0)
      assert.ok(remote.data['pk.1'])
      assert.ok(remote.data['pk.2'])
      assert.ok(remote.data['pk.3'])
    })

    it('reports errors but continues pushing other objects', async () => {
      const local = createMockStore({
        'pk.1': makeObj('pk.1', 1),
        'pk.2': makeObj('pk.2', 2)
      })
      let callCount = 0
      const remote = {
        ...createMockHubStore(),
        async put(obj) {
          callCount++
          if (obj.item.ref === 'pk.1') throw new Error('server error')
          return { ok: true }
        }
      }
      const sync = createSyncStore({ local, remote })

      const result = await sync.pushAll()
      assert.equal(result.total, 2)
      assert.equal(result.pushed, 1)
      assert.equal(result.errors, 1)
      assert.equal(callCount, 2, 'should attempt both')
    })

    it('calls onProgress for each object', async () => {
      const local = createMockStore({
        'pk.1': makeObj('pk.1', 1),
        'pk.2': makeObj('pk.2', 2)
      })
      const remote = createMockHubStore()
      const sync = createSyncStore({ local, remote })

      const events = []
      await sync.pushAll({ onProgress: (info) => events.push(info) })
      assert.equal(events.length, 2)
      for (const ev of events) {
        assert.ok(ev.ref)
        assert.ok(typeof ev.index === 'number')
        assert.ok(typeof ev.total === 'number')
        assert.ok(ev.status === 'ok' || ev.status === 'error')
      }
    })

    it('returns zero counts when local is empty', async () => {
      const local = createMockStore()
      const remote = createMockHubStore()
      const sync = createSyncStore({ local, remote })

      const result = await sync.pushAll()
      assert.equal(result.total, 0)
      assert.equal(result.pushed, 0)
      assert.equal(result.errors, 0)
    })

    it('filters by realms when specified', async () => {
      const local = createMockStore({
        'pk.1': makeObj('pk.1', 1, ['dataverse001']),
        'pk.2': makeObj('pk.2', 1, ['mypubkey']),
        'pk.3': makeObj('pk.3', 1, ['dataverse001', 'mypubkey']),
        'pk.4': makeObj('pk.4', 1, ['other-realm'])
      })
      const remote = createMockHubStore()
      remote.getToken = () => 'valid-token'  // authenticated
      const sync = createSyncStore({ local, remote })

      const result = await sync.pushAll({ realms: ['dataverse001', 'mypubkey'] })
      assert.equal(result.pushed, 3, 'pk.1, pk.2, pk.3 match')
      assert.equal(result.skipped, 1, 'pk.4 does not match')
      assert.ok(remote.data['pk.1'])
      assert.ok(remote.data['pk.2'])
      assert.ok(remote.data['pk.3'])
      assert.ok(!remote.data['pk.4'])
    })

    it('realm filter combines with auth gating', async () => {
      const local = createMockStore({
        'pk.1': makeObj('pk.1', 1, ['dataverse001']),
        'pk.2': makeObj('pk.2', 1, ['mypubkey']),
        'pk.3': makeObj('pk.3', 1, ['other-realm'])
      })
      const remote = createMockHubStore()
      // not authenticated
      const sync = createSyncStore({ local, remote })

      const result = await sync.pushAll({ realms: ['dataverse001', 'mypubkey'] })
      assert.equal(result.pushed, 1, 'only public pk.1 pushed')
      assert.equal(result.skipped, 2, 'pk.2 auth-gated, pk.3 realm-filtered')
    })
  })

  describe('identity-realm gating: skip remote push when not authenticated', () => {
    it('put: skips remote push for identity-realm objects when not authenticated', async () => {
      const local = createMockStore()
      const remote = createMockHubStore()
      // remote has no getToken → not authenticated
      const sync = createSyncStore({ local, remote })

      const privateObj = makeObj('pk.1', 1, ['mypubkey'])
      await sync.put(privateObj)

      assert.ok(local.data['pk.1'], 'should store locally')
      assert.ok(!remote.data['pk.1'], 'should NOT push to remote')
    })

    it('put: pushes identity-realm objects when authenticated', async () => {
      const local = createMockStore()
      const remote = createMockHubStore()
      remote.getToken = () => 'valid-token'
      const sync = createSyncStore({ local, remote })

      const privateObj = makeObj('pk.1', 1, ['mypubkey'])
      await sync.put(privateObj)

      assert.ok(local.data['pk.1'], 'should store locally')
      assert.ok(remote.data['pk.1'], 'should push to remote when authenticated')
    })

    it('put: always pushes public (dataverse001) objects regardless of auth', async () => {
      const local = createMockStore()
      const remote = createMockHubStore()
      // no getToken → not authenticated
      const sync = createSyncStore({ local, remote })

      const publicObj = makeObj('pk.1', 1, ['dataverse001'])
      await sync.put(publicObj)

      assert.ok(local.data['pk.1'], 'should store locally')
      assert.ok(remote.data['pk.1'], 'should push public objects to remote')
    })

    it('pushAll: skips identity-realm objects when not authenticated', async () => {
      const local = createMockStore({
        'pk.1': makeObj('pk.1', 1, ['dataverse001']),
        'pk.2': makeObj('pk.2', 1, ['mypubkey']),
        'pk.3': makeObj('pk.3', 1, ['dataverse001', 'mypubkey'])
      })
      const remote = createMockHubStore()
      // no getToken → not authenticated
      const sync = createSyncStore({ local, remote })

      const events = []
      const result = await sync.pushAll({ onProgress: (info) => events.push(info) })

      assert.equal(result.pushed, 1, 'only public object pushed')
      assert.equal(result.skipped, 2, 'two private objects skipped')
      assert.ok(remote.data['pk.1'], 'public object pushed')
      assert.ok(!remote.data['pk.2'], 'pure private object not pushed')
      assert.ok(!remote.data['pk.3'], 'mixed-realm object not pushed (has identity realm)')

      const skippedEvents = events.filter(e => e.status === 'skipped')
      assert.equal(skippedEvents.length, 2)
    })

    it('pushAll: pushes all objects when authenticated', async () => {
      const local = createMockStore({
        'pk.1': makeObj('pk.1', 1, ['dataverse001']),
        'pk.2': makeObj('pk.2', 1, ['mypubkey'])
      })
      const remote = createMockHubStore()
      remote.getToken = () => 'valid-token'
      const sync = createSyncStore({ local, remote })

      const result = await sync.pushAll()
      assert.equal(result.pushed, 2)
      assert.equal(result.skipped, 0)
    })
  })

  describe('authenticate / logout delegation', () => {
    it('delegates authenticate() to remote store', async () => {
      const local = createMockStore()
      const remote = createMockHubStore()
      remote.authenticate = async (signer) => ({ ok: true, pubkey: 'test-pk', token: 'tok123' })
      const sync = createSyncStore({ local, remote })

      const result = await sync.authenticate('fake-signer')
      assert.equal(result.ok, true)
      assert.equal(result.token, 'tok123')
    })

    it('throws if remote store lacks authenticate()', async () => {
      const local = createMockStore()
      const remote = createMockHubStore()
      const sync = createSyncStore({ local, remote })

      await assert.rejects(() => sync.authenticate('fake'), /does not support authenticate/)
    })

    it('delegates logout() to remote store', async () => {
      const local = createMockStore()
      const remote = createMockHubStore()
      let logoutCalled = false
      remote.logout = async () => { logoutCalled = true; return { ok: true } }
      const sync = createSyncStore({ local, remote })

      await sync.logout()
      assert.ok(logoutCalled)
    })

    it('throws if remote store lacks logout()', async () => {
      const local = createMockStore()
      const remote = createMockHubStore()
      const sync = createSyncStore({ local, remote })

      await assert.rejects(() => sync.logout(), /does not support logout/)
    })
  })
})
