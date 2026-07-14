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
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from '../src/client.js'
import { createFsStore } from '../src/store/fs.js'
import { buildFixtureRepo } from '../test-support/git-fixture.js'
import { throwawayIdentity } from '../test-support/throwaway-identity.js'
import { initRepo, openRepo, forkRepo } from '../src/git/repo.js'
import { pushToRemote } from '../src/git/transfer.js'
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

test('fork delta relations resolve across the graft point (no dangling sugar)', async () => {
  // Generic graph-walkers (the web viewer) follow `relations`; on a thin fork a
  // delta object's parent/tree/entry must point at the namespace where the
  // referenced object actually lives — fork-local for the delta, upstream for
  // objects it inherited — not blindly at the fork namespace.
  const { dataDir, aliceClient, bobClient } = await twoParty()
  const up = mkdtempSync(join(tmpdir(), 'ig-fork-rel-'))
  const G = {
    ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@e', GIT_AUTHOR_DATE: '1700000000 +0000',
    GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@e', GIT_COMMITTER_DATE: '1700000000 +0000',
  }
  const g = (args) => execFileSync('git', ['-C', up, ...args], { env: G }).toString('utf-8')
  g(['init', '-q', '-b', 'main'])
  writeFileSync(join(up, 'a.txt'), 'aaa\n'); writeFileSync(join(up, 'b.txt'), 'bbb\n')
  g(['add', '-A']); g(['commit', '-q', '-m', 'c1'])

  const upstreamRef = await initRepo({ client: aliceClient, id: crypto.randomUUID(), name: 'up', in: ['server-public'], defaultBranch: 'refs/heads/main' })
  const upstream = await openRepo({ client: aliceClient, repoRef: upstreamRef })
  await pushToRemote({ repo: upstream, gitDir: join(up, '.git'), pushes: [{ src: 'refs/heads/main', dst: 'refs/heads/main', force: false }] })

  const { ref: forkRef } = await forkRepo({ client: bobClient, upstreamRef })
  const fork = await openRepo({ client: bobClient, repoRef: forkRef })

  // change ONLY a.txt → new commit + new root tree + new a.txt blob; b.txt's
  // blob is inherited (lives upstream, not in the fork).
  g(['checkout', '-q', '-b', 'feature'])
  writeFileSync(join(up, 'a.txt'), 'aaa2\n'); g(['add', '-A']); g(['commit', '-q', '-m', 'c2'])
  const c2 = g(['rev-parse', 'HEAD']).trim()
  await pushToRemote({ repo: fork, gitDir: join(up, '.git'), pushes: [{ src: 'refs/heads/feature', dst: 'refs/heads/feature', force: false }] })

  const c2obj = (await bobClient.get(await objRef(fork.owner, fork.repoId, c2))).item

  // parent → the upstream namespace, and it resolves (would be a 404 in the fork ns)
  const parentRef = c2obj.relations.parent[0].ref
  assert.ok((await bobClient.get(parentRef))?.item, 'parent relation must resolve')
  assert.ok(parentRef.startsWith(aliceClient.pubkey + '.'), 'parent points at the upstream owner namespace')

  // tree → the new (fork-local) root tree, resolves
  const treeRef = c2obj.relations.tree[0].ref
  assert.ok(treeRef.startsWith(bobClient.pubkey + '.'), 'new root tree is fork-local')
  const treeObj = (await bobClient.get(treeRef)).item

  // every entry resolves: a.txt (changed → fork-local), b.txt (unchanged → upstream)
  for (const e of treeObj.relations.entry) {
    const owner = e.ref.startsWith(bobClient.pubkey + '.') ? 'fork' : 'upstream'
    assert.ok((await bobClient.get(e.ref))?.item, `entry ${e.name} (${owner}) must resolve`)
  }
  const byName = Object.fromEntries(treeObj.relations.entry.map(e => [e.name, e.ref]))
  assert.ok(byName['a.txt'].startsWith(bobClient.pubkey + '.'), 'changed blob is fork-local')
  assert.ok(byName['b.txt'].startsWith(aliceClient.pubkey + '.'), 'inherited blob points upstream')

  rmSync(up, { recursive: true, force: true })
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
