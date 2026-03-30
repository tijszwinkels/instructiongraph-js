import test from 'node:test'
import assert from 'node:assert/strict'

import { createSyncStore } from '../src/store/sync.js'

function makeEnvelope(ref, revision, createdAt) {
  return {
    is: 'instructionGraph001',
    signature: 'sig',
    item: {
      id: ref.split('.')[1],
      in: ['dataverse001'],
      ref,
      pubkey: ref.split('.')[0],
      created_at: createdAt,
      revision,
      type: 'TEST',
      relations: {},
      content: { revision },
    },
  }
}

function createMemoryStore(initial = {}) {
  const objects = new Map(Object.entries(initial))
  const puts = []

  return {
    puts,
    async get(ref) {
      return objects.get(ref) ?? null
    },
    async put(object) {
      puts.push(object.item.ref)
      objects.set(object.item.ref, object)
      return { ok: true, status: 200, object }
    },
    async search() {
      return { items: [...objects.values()], cursor: null, hasMore: false }
    },
    async inbound(ref) {
      return {
        items: [...objects.values()].filter((object) =>
          Object.values(object.item.relations ?? {}).some((entries) =>
            (entries ?? []).some((entry) => entry.ref === ref),
          ),
        ),
        cursor: null,
        hasMore: false,
      }
    },
  }
}

test('createSyncStore get returns the newer revision and syncs the stale side', async () => {
  const ref = 'pk.11111111-1111-4111-8111-111111111111'
  const local = createMemoryStore({ [ref]: makeEnvelope(ref, 1, '2026-03-01T00:00:00Z') })
  const remote = createMemoryStore({ [ref]: makeEnvelope(ref, 2, '2026-03-02T00:00:00Z') })
  const sync = createSyncStore({ local, remote })

  const result = await sync.get(ref)
  assert.equal(result.item.revision, 2)
  assert.deepEqual(local.puts, [ref])
  assert.deepEqual(remote.puts, [])
})

test('createSyncStore pushes local-only newer objects to remote on read', async () => {
  const ref = 'pk.22222222-2222-4222-8222-222222222222'
  const local = createMemoryStore({ [ref]: makeEnvelope(ref, 3, '2026-03-03T00:00:00Z') })
  const remote = createMemoryStore()
  const sync = createSyncStore({ local, remote })

  const result = await sync.get(ref)
  assert.equal(result.item.revision, 3)
  assert.deepEqual(remote.puts, [ref])
})

test('createSyncStore put writes local first and tolerates remote failure', async () => {
  const ref = 'pk.33333333-3333-4333-8333-333333333333'
  const object = makeEnvelope(ref, 1, '2026-03-03T00:00:00Z')
  const local = createMemoryStore()
  const remote = {
    async get() { return null },
    async put() { return { ok: false, status: 0, error: 'hub unreachable' } },
    async search() { return { items: [], cursor: null, hasMore: false } },
    async inbound() { return { items: [], cursor: null, hasMore: false } },
  }
  const sync = createSyncStore({ local, remote })

  assert.deepEqual(await sync.put(object), {
    ok: true,
    status: 200,
    object,
    remote: { ok: false, status: 0, error: 'hub unreachable' },
  })
  assert.deepEqual(local.puts, [ref])
})

test('createSyncStore search and inbound merge by ref and keep higher revisions', async () => {
  const targetRef = 'pk.44444444-4444-4444-8444-444444444444'
  const sharedRef = 'pk.55555555-5555-4555-8555-555555555555'
  const onlyRemoteRef = 'pk.66666666-6666-4666-8666-666666666666'

  const local = createMemoryStore({
    [targetRef]: makeEnvelope(targetRef, 1, '2026-03-01T00:00:00Z'),
    [sharedRef]: {
      ...makeEnvelope(sharedRef, 1, '2026-03-02T00:00:00Z'),
      item: {
        ...makeEnvelope(sharedRef, 1, '2026-03-02T00:00:00Z').item,
        relations: { replies_to: [{ ref: targetRef }] },
      },
    },
  })
  const remote = createMemoryStore({
    [sharedRef]: {
      ...makeEnvelope(sharedRef, 2, '2026-03-03T00:00:00Z'),
      item: {
        ...makeEnvelope(sharedRef, 2, '2026-03-03T00:00:00Z').item,
        relations: { replies_to: [{ ref: targetRef }] },
      },
    },
    [onlyRemoteRef]: {
      ...makeEnvelope(onlyRemoteRef, 1, '2026-03-04T00:00:00Z'),
      item: {
        ...makeEnvelope(onlyRemoteRef, 1, '2026-03-04T00:00:00Z').item,
        relations: { replies_to: [{ ref: targetRef }] },
      },
    },
  })
  const sync = createSyncStore({ local, remote })

  const search = await sync.search({ limit: 10 })
  assert.deepEqual(search.items.map((item) => [item.item.ref, item.item.revision]), [
    [onlyRemoteRef, 1],
    [sharedRef, 2],
    [targetRef, 1],
  ])

  const inbound = await sync.inbound(targetRef, { limit: 10 })
  assert.deepEqual(inbound.items.map((item) => [item.item.ref, item.item.revision]), [
    [onlyRemoteRef, 1],
    [sharedRef, 2],
  ])
})
