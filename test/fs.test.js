import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { canonicalJSON, generateKeypair, signItem } from '../src/index.js'
import { createFsStore } from '../src/store/fs.js'

function makeEnvelope(privateKey, pubkey, fields) {
  return signItem({
    id: fields.id,
    in: fields.in ?? ['dataverse001'],
    ref: `${pubkey}.${fields.id}`,
    pubkey,
    created_at: fields.created_at,
    ...(fields.updated_at ? { updated_at: fields.updated_at } : {}),
    ...(fields.revision !== undefined ? { revision: fields.revision } : {}),
    type: fields.type,
    relations: fields.relations ?? {},
    content: fields.content ?? {},
  }, privateKey)
}

test('createFsStore stores canonical JSON, sets mtime, backs up updates, and purges backups on tombstone', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ig-fs-'))
  const store = createFsStore({ dataDir })
  const { privateKey, pubkey } = await generateKeypair()

  const first = await makeEnvelope(privateKey, pubkey, {
    id: '11111111-1111-4111-8111-111111111111',
    created_at: '2026-03-01T00:00:00Z',
    revision: 0,
    type: 'POST',
    content: { title: 'first' },
  })

  assert.deepEqual(await store.put(first), { ok: true, status: 201, object: first })

  const mainPath = join(dataDir, `${first.item.ref}.json`)
  assert.equal(await readFile(mainPath, 'utf8'), `${canonicalJSON(first)}\n`)
  assert.equal((await stat(mainPath)).mtime.toISOString(), '2026-03-01T00:00:00.000Z')
  assert.deepEqual(await store.get(first.item.ref), first)

  const second = await makeEnvelope(privateKey, pubkey, {
    id: first.item.id,
    created_at: first.item.created_at,
    updated_at: '2026-03-02T00:00:00Z',
    revision: 1,
    type: 'POST',
    content: { title: 'second' },
  })

  assert.deepEqual(await store.put(second), { ok: true, status: 200, object: second })
  const backupPath = join(dataDir, 'bk', `${first.item.ref}.r0.json`)
  assert.equal(await readFile(backupPath, 'utf8'), `${canonicalJSON(first)}\n`)
  assert.equal((await stat(mainPath)).mtime.toISOString(), '2026-03-02T00:00:00.000Z')

  const tombstone = await makeEnvelope(privateKey, pubkey, {
    id: first.item.id,
    created_at: first.item.created_at,
    updated_at: '2026-03-03T00:00:00Z',
    revision: 2,
    type: 'DELETED',
    content: {},
  })

  await store.put(tombstone)
  await assert.rejects(stat(backupPath))
})

test('createFsStore search and inbound support filters, pagination, and inbound counts', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ig-fs-search-'))
  const store = createFsStore({ dataDir })
  const owner = await generateKeypair()
  const other = await generateKeypair()
  const targetId = '22222222-2222-4222-8222-222222222222'
  const targetRef = `${owner.pubkey}.${targetId}`

  const target = await makeEnvelope(owner.privateKey, owner.pubkey, {
    id: targetId,
    created_at: '2026-03-01T00:00:00Z',
    type: 'POST',
    content: { title: 'target' },
  })
  const commentA = await makeEnvelope(other.privateKey, other.pubkey, {
    id: '33333333-3333-4333-8333-333333333333',
    created_at: '2026-03-03T00:00:00Z',
    type: 'COMMENT',
    relations: { replies_to: [{ ref: targetRef }] },
    content: { text: 'A' },
  })
  const commentB = await makeEnvelope(owner.privateKey, owner.pubkey, {
    id: '44444444-4444-4444-8444-444444444444',
    created_at: '2026-03-02T00:00:00Z',
    type: 'COMMENT',
    relations: { replies_to: [{ ref: targetRef }] },
    content: { text: 'B' },
  })
  const unrelated = await makeEnvelope(owner.privateKey, owner.pubkey, {
    id: '55555555-5555-4555-8555-555555555555',
    created_at: '2026-03-04T00:00:00Z',
    type: 'NOTE',
    content: { text: 'ignore' },
  })

  for (const object of [target, commentA, commentB, unrelated]) {
    await store.put(object)
  }

  const firstPage = await store.search({ type: 'COMMENT', limit: 1 })
  assert.equal(firstPage.items.length, 1)
  assert.equal(firstPage.items[0].item.ref, commentA.item.ref)
  assert.equal(firstPage.hasMore, true)
  assert.ok(firstPage.cursor)

  const secondPage = await store.search({ type: 'COMMENT', limit: 1, cursor: firstPage.cursor })
  assert.equal(secondPage.items.length, 1)
  assert.equal(secondPage.items[0].item.ref, commentB.item.ref)

  const withCounts = await store.search({ includeInboundCounts: true })
  const targetWithCounts = withCounts.items.find((item) => item.item.ref === targetRef)
  assert.deepEqual(targetWithCounts._inbound_counts, { replies_to: 2 })

  const inbound = await store.inbound(targetRef, { relation: 'replies_to', from: other.pubkey })
  assert.deepEqual(inbound.items.map((item) => item.item.ref), [commentA.item.ref])

  const owned = await store.search({ by: owner.pubkey })
  assert.deepEqual(
    owned.items.map((item) => item.item.ref),
    [unrelated.item.ref, commentB.item.ref, target.item.ref],
  )
})

test('createFsStore rejects invalid signatures and stale revisions', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ig-fs-invalid-'))
  const store = createFsStore({ dataDir })
  const { privateKey, pubkey } = await generateKeypair()

  const valid = await makeEnvelope(privateKey, pubkey, {
    id: '66666666-6666-4666-8666-666666666666',
    created_at: '2026-03-01T00:00:00Z',
    revision: 1,
    type: 'POST',
    content: { title: 'valid' },
  })
  await store.put(valid)

  const stale = await makeEnvelope(privateKey, pubkey, {
    id: valid.item.id,
    created_at: valid.item.created_at,
    revision: 1,
    type: 'POST',
    content: { title: 'stale' },
  })
  assert.deepEqual(await store.put(stale), {
    ok: false,
    status: 409,
    error: 'existing revision 1 >= incoming 1',
  })

  const tampered = structuredClone(valid)
  tampered.item.content.title = 'tampered'
  assert.deepEqual(await store.put(tampered), {
    ok: false,
    status: 400,
    error: 'signature verification failed',
  })
})
