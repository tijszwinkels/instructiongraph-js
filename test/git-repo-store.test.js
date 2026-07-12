/**
 * Store layer: git objects and refs ↔ the ig store, via createClient over a
 * local fs store with a throwaway identity. Exercises immutable object put/get,
 * addressing, GIT_REF encode/decode + CAS, ls-remote (inbound), and delete.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from '../src/client.js'
import { createFsStore } from '../src/store/fs.js'
import { buildFixtureRepo } from '../test-support/git-fixture.js'
import { throwawayIdentity } from '../test-support/throwaway-identity.js'
import { initRepo, openRepo } from '../src/git/repo.js'
import { objRef } from '../src/git/addressing.js'

async function setup() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ig-store-'))
  const store = createFsStore({ dataDir, filter: null })
  const id = await throwawayIdentity()
  const client = createClient({ store, identity: id.identity })
  await client.ready
  return { dataDir, store, client, pubkey: id.pubkey }
}

test('initRepo creates a GIT_REPOSITORY anchor; openRepo reads it back', async () => {
  const { client, pubkey } = await setup()
  const repoRef = await initRepo({ client, id: crypto.randomUUID(), name: 'demo', format: 'sha1', in: ['server-public'] })
  assert.ok(repoRef.startsWith(pubkey + '.'))
  const repo = await openRepo({ client, repoRef })
  assert.equal(repo.owner, pubkey)
  assert.equal(repo.format, 'sha1')
  assert.deepEqual(repo.in, ['server-public'])
  assert.equal(repo.content.name, 'demo')
})

test('every fixture object round-trips through put/getObject byte-identically', async () => {
  const { client } = await setup()
  const fx = buildFixtureRepo()
  test.after?.(() => rmSync(fx.dir, { recursive: true, force: true }))
  const repoRef = await initRepo({ client, id: crypto.randomUUID(), name: 'fx', in: ['server-public'] })
  const repo = await openRepo({ client, repoRef })

  for (const o of fx.objects) {
    const oid = await repo.putObject(o.type, o.payload)
    assert.equal(oid, o.oid)
  }
  for (const o of fx.objects) {
    const got = await repo.getObject(o.oid)
    assert.ok(got, `object ${o.oid} should be retrievable`)
    assert.equal(got.otype, o.type)
    assert.deepEqual(Buffer.from(got.payload), o.payload, `payload mismatch for ${o.type} ${o.oid}`)
  }
  rmSync(fx.dir, { recursive: true, force: true })
})

test('putObject is idempotent (immutable) and stored at the computed address', async () => {
  const { client } = await setup()
  const repoRef = await initRepo({ client, id: crypto.randomUUID(), name: 'idem', in: ['server-public'] })
  const repo = await openRepo({ client, repoRef })
  const payload = Buffer.from('hello world\n')
  const oid1 = await repo.putObject('blob', payload)
  const oid2 = await repo.putObject('blob', payload) // no-op
  assert.equal(oid1, oid2)
  const addr = await objRef(repo.owner, repo.repoId, oid1)
  const env = await client.get(addr)
  assert.ok(env?.item, 'object present at objRef address')
  assert.equal(env.item.type, 'GIT_BLOB')
  assert.equal(env.item.content.oid, oid1)
})

test('commit object gets tree + parent relations pointing at computed addresses', async () => {
  const { client } = await setup()
  const fx = buildFixtureRepo()
  const repoRef = await initRepo({ client, id: crypto.randomUUID(), name: 'rel', in: ['server-public'] })
  const repo = await openRepo({ client, repoRef })
  for (const o of fx.objects) await repo.putObject(o.type, o.payload)

  const mergeCommit = fx.objects.find(o => o.type === 'commit' && o.oid === fx.head)
  const addr = await objRef(repo.owner, repo.repoId, mergeCommit.oid)
  const env = await client.get(addr)
  const rels = env.item.relations
  assert.equal(rels.repository[0].ref, repoRef)
  assert.ok(rels.tree?.[0]?.ref, 'commit has a tree relation')
  assert.ok(Array.isArray(rels.parent) && rels.parent.length >= 1, 'commit has parent relation(s)')
  rmSync(fx.dir, { recursive: true, force: true })
})

test('refs: putRef/getRef/listRefs (ls-remote) and symref HEAD', async () => {
  const { client } = await setup()
  const repoRef = await initRepo({ client, id: crypto.randomUUID(), name: 'refs', in: ['server-public'] })
  const repo = await openRepo({ client, repoRef })
  const oid = 'a'.repeat(40)

  await repo.putRef('refs/heads/main', { targetOid: oid })
  await repo.putRef('HEAD', { symrefTarget: 'refs/heads/main' })

  const main = await repo.getRef('refs/heads/main')
  assert.equal(main.targetOid, oid)
  const head = await repo.getRef('HEAD')
  assert.equal(head.symrefTarget, 'refs/heads/main')

  const refs = await repo.listRefs()
  const names = refs.map(r => r.refname).sort()
  assert.deepEqual(names, ['HEAD', 'refs/heads/main'])
})

test('putRef CAS: expectedOldOid mismatch is rejected, correct value succeeds', async () => {
  const { client } = await setup()
  const repoRef = await initRepo({ client, id: crypto.randomUUID(), name: 'cas', in: ['server-public'] })
  const repo = await openRepo({ client, repoRef })
  const a = 'a'.repeat(40), b = 'b'.repeat(40)

  await repo.putRef('refs/heads/main', { targetOid: a }, { expectedOldOid: null }) // create
  await assert.rejects(
    () => repo.putRef('refs/heads/main', { targetOid: b }, { expectedOldOid: 'c'.repeat(40) }),
    /compare-and-swap|CAS|stale|conflict/i
  )
  // correct expected value advances the ref (revision bumps)
  await repo.putRef('refs/heads/main', { targetOid: b }, { expectedOldOid: a })
  assert.equal((await repo.getRef('refs/heads/main')).targetOid, b)
})

test('non-owner writes are rejected; reads still work (single-owner push)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ig-store-own-'))
  const store = createFsStore({ dataDir, filter: null })
  const a = await throwawayIdentity()
  const b = await throwawayIdentity()
  const clientA = createClient({ store, identity: a.identity }); await clientA.ready
  const clientB = createClient({ store, identity: b.identity }); await clientB.ready

  const repoRef = await initRepo({ client: clientA, id: crypto.randomUUID(), name: 'owned', in: ['server-public'] })
  const repoA = await openRepo({ client: clientA, repoRef })
  const oid = await repoA.putObject('blob', Buffer.from('hi\n'))
  await repoA.putRef('refs/heads/main', { targetOid: oid })

  // B opens the same repo (owned by A). Reads work...
  const repoB = await openRepo({ client: clientB, repoRef })
  assert.ok(await repoB.getObject(oid), 'non-owner can read a public repo object')
  assert.equal((await repoB.getRef('refs/heads/main')).targetOid, oid)

  // ...but writes are refused (would sign into B's namespace, unreadable here)
  await assert.rejects(() => repoB.putObject('blob', Buffer.from('x\n')), /only the owner can write/i)
  await assert.rejects(() => repoB.putRef('refs/heads/x', { targetOid: oid }), /only the owner can write/i)
  await assert.rejects(() => repoB.deleteRef('refs/heads/main'), /only the owner can write/i)

  rmSync(dataDir, { recursive: true, force: true })
})

test('deleteRef tombstones the ref so it no longer lists', async () => {
  const { client } = await setup()
  const repoRef = await initRepo({ client, id: crypto.randomUUID(), name: 'del', in: ['server-public'] })
  const repo = await openRepo({ client, repoRef })
  await repo.putRef('refs/heads/tmp', { targetOid: 'a'.repeat(40) })
  await repo.deleteRef('refs/heads/tmp')
  assert.equal(await repo.getRef('refs/heads/tmp'), null)
  const refs = await repo.listRefs()
  assert.ok(!refs.some(r => r.refname === 'refs/heads/tmp'))
})
