/**
 * Thin forks: an O(1) fork anchor (forked_from + one mirrored ref, zero git
 * objects) and the resolver fallthrough that lets a fork read upstream objects
 * by computing their address in the upstream owner's namespace on a local miss.
 *
 * Two identities over one fs store (Alice = upstream owner, Bob = contributor),
 * mirroring the single-owner-push model.
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
import { initRepo, openRepo, forkRepo } from '../src/git/repo.js'
import { objRef } from '../src/git/addressing.js'

async function twoParty() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ig-fork-'))
  const store = createFsStore({ dataDir, filter: null })
  const alice = await throwawayIdentity()
  const bob = await throwawayIdentity()
  const aliceClient = createClient({ store, identity: alice.identity }); await aliceClient.ready
  const bobClient = createClient({ store, identity: bob.identity }); await bobClient.ready
  return { dataDir, store, alice, bob, aliceClient, bobClient }
}

/** Alice: a repo carrying the whole fixture history with main → its head. */
async function upstreamWithFixture(aliceClient) {
  const fx = buildFixtureRepo()
  const repoRef = await initRepo({ client: aliceClient, id: crypto.randomUUID(), name: 'upstream', in: ['server-public'], defaultBranch: 'refs/heads/main' })
  const repo = await openRepo({ client: aliceClient, repoRef })
  for (const o of fx.objects) await repo.putObject(o.type, o.payload)
  await repo.putRef('refs/heads/main', { targetOid: fx.head }, { expectedOldOid: null })
  return { fx, repoRef, repo }
}

test('forkRepo: O(1) anchor with forked_from + one mirrored ref, zero git objects', async () => {
  const { dataDir, aliceClient, bobClient } = await twoParty()
  const { fx, repoRef: upstreamRef } = await upstreamWithFixture(aliceClient)

  const { ref: forkRef } = await forkRepo({ client: bobClient, upstreamRef, name: 'my-fork' })
  assert.ok(forkRef.startsWith((await bobClient.pubkey) + '.') || forkRef.startsWith(bobClient.pubkey + '.'))

  const anchor = (await bobClient.get(forkRef)).item
  assert.equal(anchor.content.name, 'my-fork')
  assert.deepEqual(anchor.relations.forked_from.map(r => r.ref), [upstreamRef], 'forked_from → upstream')
  assert.deepEqual(anchor.in, ['server-public'], 'fork inherits upstream realm by default')

  const fork = await openRepo({ client: bobClient, repoRef: forkRef })
  assert.deepEqual(fork.forkedFrom, [upstreamRef])

  // the mirrored default branch points at the upstream tip …
  const main = await fork.getRef('refs/heads/main')
  assert.equal(main.targetOid, fx.head, 'mirrored main → upstream tip')

  // … and NOT a single git object was copied into the fork namespace (thin fork).
  assert.equal(await fork.hasObjectLocal(fx.head), false, 'no git objects stored in the fork')
  assert.equal(await fork.getObjectLocal(fx.head), null)

  rmSync(dataDir, { recursive: true, force: true })
})

test('resolver fallthrough: fork.getObject resolves upstream objects it does not store', async () => {
  const { dataDir, aliceClient, bobClient } = await twoParty()
  const { fx, repoRef: upstreamRef } = await upstreamWithFixture(aliceClient)
  const { ref: forkRef } = await forkRepo({ client: bobClient, upstreamRef })
  const fork = await openRepo({ client: bobClient, repoRef: forkRef })

  // every reachable upstream object resolves through the fork, byte-identically
  for (const o of fx.objects) {
    const got = await fork.getObject(o.oid)
    assert.ok(got, `fork must resolve upstream object ${o.type} ${o.oid}`)
    assert.equal(got.otype, o.type)
    assert.deepEqual(Buffer.from(got.payload), o.payload)
  }
  assert.equal(await fork.hasObject(fx.head), true, 'hasObject also falls through')
  // a genuinely-absent object is still null (no infinite walk)
  assert.equal(await fork.getObject('0'.repeat(40)), null)

  rmSync(dataDir, { recursive: true, force: true })
})

test('fork prefers its own object over the upstream copy at the same oid', async () => {
  // A blob present in BOTH namespaces must resolve from the fork's own copy.
  const { dataDir, aliceClient, bobClient } = await twoParty()
  const { repoRef: upstreamRef } = await upstreamWithFixture(aliceClient)
  const { ref: forkRef } = await forkRepo({ client: bobClient, upstreamRef })
  const fork = await openRepo({ client: bobClient, repoRef: forkRef })

  const payload = Buffer.from('hello world\n') // same as a fixture blob
  const oid = await fork.putObject('blob', payload)
  const localAddr = await objRef(fork.owner, fork.repoId, oid)
  const got = await fork.getObject(oid)
  assert.ok(got)
  assert.deepEqual(Buffer.from(got.payload), payload)
  // it came from the fork's namespace (owner = Bob), not Alice's
  assert.ok(localAddr.startsWith(bobClient.pubkey + '.'))
  assert.ok((await bobClient.get(localAddr)).item, 'fork stored its own copy')

  rmSync(dataDir, { recursive: true, force: true })
})

test('putObject extraRelations: copied_from / merges land on the written object', async () => {
  const { dataDir, aliceClient } = await twoParty()
  const repoRef = await initRepo({ client: aliceClient, id: crypto.randomUUID(), name: 'prov', in: ['server-public'] })
  const repo = await openRepo({ client: aliceClient, repoRef })

  const src = `${aliceClient.pubkey}.11111111-1111-4111-8111-111111111111`
  const mr = `${aliceClient.pubkey}.22222222-2222-4222-8222-222222222222`
  const oid = await repo.putObject('blob', Buffer.from('contrib\n'), {
    extraRelations: { copied_from: [{ ref: src }], merges: [{ ref: mr }] },
  })
  const obj = (await aliceClient.get(await objRef(repo.owner, repo.repoId, oid))).item
  assert.deepEqual(obj.relations.copied_from.map(r => r.ref), [src])
  assert.deepEqual(obj.relations.merges.map(r => r.ref), [mr])
  assert.equal(obj.relations.type_def[0].ref !== undefined, true, 'base relations preserved')

  rmSync(dataDir, { recursive: true, force: true })
})
