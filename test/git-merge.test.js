/**
 * merge internals (src/git/merge.js) at the API level, over a real local git
 * repo + an fs-backed ig store with two identities. Covers the parts the CLI
 * e2e does not: the owner-only guard, --ff-only rejection on divergence, and
 * the provenance placement of `copied_from` / `merges` (native-mode form b).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from '../src/client.js'
import { createFsStore } from '../src/store/fs.js'
import { throwawayIdentity } from '../test-support/throwaway-identity.js'
import { parseRef } from '../src/object.js'
import { initRepo, openRepo, forkRepo } from '../src/git/repo.js'
import { pushToRemote } from '../src/git/transfer.js'
import { objRef } from '../src/git/addressing.js'
import { mergeIntoUpstream } from '../src/git/merge.js'

const FIXED = {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Bob', GIT_AUTHOR_EMAIL: 'bob@example.com', GIT_AUTHOR_DATE: '1700001000 +0000',
  GIT_COMMITTER_NAME: 'Bob', GIT_COMMITTER_EMAIL: 'bob@example.com', GIT_COMMITTER_DATE: '1700001000 +0000',
}
const sh = (dir, args, extra = {}) =>
  execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, ...FIXED, ...extra }, maxBuffer: 1 << 26 }).toString('utf-8')
const mkd = (p) => mkdtempSync(join(tmpdir(), p))

/**
 * Build: a local git repo (main=C1, feature=C2), alice's upstream (main→C1),
 * bob's thin fork (feature→C2, delta-only), and an owner working copy checked
 * out on main at C1 with a committer identity configured.
 */
async function scenario() {
  const dataDir = mkd('ig-merge-store-')
  const store = createFsStore({ dataDir, filter: null })
  const alice = await throwawayIdentity(); const bob = await throwawayIdentity()
  const aliceClient = createClient({ store, identity: alice.identity }); await aliceClient.ready
  const bobClient = createClient({ store, identity: bob.identity }); await bobClient.ready

  const up = mkd('ig-merge-up-')
  sh(up, ['init', '-q', '-b', 'main'])
  writeFileSync(join(up, 'readme.md'), 'hello\n'); sh(up, ['add', '-A']); sh(up, ['commit', '-q', '-m', 'c1'])
  const c1 = sh(up, ['rev-parse', 'HEAD']).trim()
  sh(up, ['checkout', '-q', '-b', 'feature'])
  writeFileSync(join(up, 'readme.md'), 'hello\nmore\n'); sh(up, ['add', '-A']); sh(up, ['commit', '-q', '-m', 'c2'])
  const c2 = sh(up, ['rev-parse', 'HEAD']).trim()
  const upGitDir = join(up, '.git')

  const upstreamRef = await initRepo({ client: aliceClient, id: crypto.randomUUID(), name: 'up', in: ['server-public'], defaultBranch: 'refs/heads/main' })
  const upstream = await openRepo({ client: aliceClient, repoRef: upstreamRef })
  await pushToRemote({ repo: upstream, gitDir: upGitDir, pushes: [{ src: 'refs/heads/main', dst: 'refs/heads/main', force: false }] })

  const { ref: forkRef } = await forkRepo({ client: bobClient, upstreamRef })
  const fork = await openRepo({ client: bobClient, repoRef: forkRef })
  await pushToRemote({ repo: fork, gitDir: upGitDir, pushes: [{ src: 'refs/heads/feature', dst: 'refs/heads/feature', force: false }] })

  const ownerWork = mkd('ig-merge-owner-'); rmSync(ownerWork, { recursive: true, force: true })
  execFileSync('git', ['clone', '--quiet', '--single-branch', '--branch', 'main', up, ownerWork],
    { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, maxBuffer: 1 << 26 })
  sh(ownerWork, ['config', 'user.name', 'Owner']); sh(ownerWork, ['config', 'user.email', 'owner@example.com'])

  return { dataDir, up, store, alice, bob, aliceClient, bobClient, upstreamRef, forkRef, ownerWork, ownerGitDir: join(ownerWork, '.git'), c1, c2 }
}

const cleanup = (s) => { for (const d of [s.dataDir, s.up, s.ownerWork]) try { rmSync(d, { recursive: true, force: true }) } catch {} }

test('merge is refused for anyone but the upstream owner', async () => {
  const s = await scenario()
  await assert.rejects(
    () => mergeIntoUpstream({ client: s.bobClient, gitDir: s.ownerGitDir, worktree: s.ownerWork, sourceRef: s.forkRef, sourceBranch: 'feature' }),
    /only the owner can merge/i
  )
  cleanup(s)
})

test('fast-forward merge: head copy carries copied_from AND merges (native mode)', async () => {
  const s = await scenario()
  const mrRef = `${s.bob.pubkey}.abcdef01-2345-4678-8abc-def012345678`
  const res = await mergeIntoUpstream({
    client: s.aliceClient, gitDir: s.ownerGitDir, worktree: s.ownerWork,
    sourceRef: s.forkRef, sourceBranch: 'feature', mergeRequestRef: mrRef,
  })
  assert.equal(res.kind, 'fast-forward')
  assert.equal(res.newTip, s.c2)

  const { pubkey: upOwner, id: upId } = parseRef(s.upstreamRef)
  const headCopy = (await s.aliceClient.get(await objRef(upOwner, upId, s.c2))).item
  assert.equal(headCopy.pubkey, upOwner, 'C2 copy is owner-signed')
  assert.deepEqual(headCopy.relations.merges.map(r => r.ref), [mrRef], 'head records merges → MR')
  const { pubkey: fkOwner, id: fkId } = parseRef(s.forkRef)
  assert.deepEqual(headCopy.relations.copied_from.map(r => r.ref), [await objRef(fkOwner, fkId, s.c2)])

  // upstream main advanced to C2 via CAS
  assert.equal((await openRepo({ client: s.aliceClient, repoRef: s.upstreamRef }).then(r => r.getRef('refs/heads/main'))).targetOid, s.c2)
  cleanup(s)
})

test('--ff-only refuses a diverged branch; --no-ff then makes a merge commit', async () => {
  const s = await scenario()
  // owner advances main to C3 (a sibling of C2 off C1) and publishes it
  writeFileSync(join(s.ownerWork, 'owner.txt'), 'owner change\n')
  sh(s.ownerWork, ['add', '-A']); sh(s.ownerWork, ['commit', '-q', '-m', 'c3'], { GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.com' })
  const c3 = sh(s.ownerWork, ['rev-parse', 'HEAD']).trim()
  const upstream = await openRepo({ client: s.aliceClient, repoRef: s.upstreamRef })
  await pushToRemote({ repo: upstream, gitDir: s.ownerGitDir, pushes: [{ src: 'refs/heads/main', dst: 'refs/heads/main', force: false }] })

  // not a fast-forward → rejected under --ff-only
  await assert.rejects(
    () => mergeIntoUpstream({ client: s.aliceClient, gitDir: s.ownerGitDir, worktree: s.ownerWork, sourceRef: s.forkRef, sourceBranch: 'feature', mode: 'ff-only' }),
    /not a fast-forward/i
  )

  // --no-ff builds a merge commit M with parents C3 and C2
  const mrRef = `${s.bob.pubkey}.abcdef01-2345-4678-8abc-def012345678`
  const res = await mergeIntoUpstream({
    client: s.aliceClient, gitDir: s.ownerGitDir, worktree: s.ownerWork,
    sourceRef: s.forkRef, sourceBranch: 'feature', mode: 'no-ff', message: 'merge feature', mergeRequestRef: mrRef,
  })
  assert.equal(res.kind, 'merge-commit')
  const parents = sh(s.ownerWork, ['rev-list', '--parents', '-n', '1', res.newTip]).trim().split(/\s+/).slice(1)
  assert.deepEqual(parents.sort(), [c3, s.c2].sort())

  // the owner-created merge commit records `merges` but NOT `copied_from`
  // (it has no fork original); C2 carries copied_from (it came from the fork).
  const { pubkey: upOwner, id: upId } = parseRef(s.upstreamRef)
  const mCopy = (await s.aliceClient.get(await objRef(upOwner, upId, res.newTip))).item
  assert.deepEqual(mCopy.relations.merges.map(r => r.ref), [mrRef])
  assert.equal(mCopy.relations.copied_from, undefined, 'merge commit has no copied_from')
  const c2Copy = (await s.aliceClient.get(await objRef(upOwner, upId, s.c2))).item
  const { pubkey: fkOwner, id: fkId } = parseRef(s.forkRef)
  assert.deepEqual(c2Copy.relations.copied_from.map(r => r.ref), [await objRef(fkOwner, fkId, s.c2)])
  assert.equal(c2Copy.relations.merges, undefined, 'non-head fork object has no merges')
  cleanup(s)
})

test('a conflicting --no-ff merge aborts cleanly and leaves the ref untouched', async () => {
  const s = await scenario()
  // owner rewrites the SAME line the fork touched, so a 3-way merge conflicts.
  writeFileSync(join(s.ownerWork, 'readme.md'), 'hello\nowner-only\n')
  sh(s.ownerWork, ['add', '-A']); sh(s.ownerWork, ['commit', '-q', '-m', 'c3 owner edit'],
    { GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.com' })
  const c3 = sh(s.ownerWork, ['rev-parse', 'HEAD']).trim()
  const upstream = await openRepo({ client: s.aliceClient, repoRef: s.upstreamRef })
  await pushToRemote({ repo: upstream, gitDir: s.ownerGitDir, pushes: [{ src: 'refs/heads/main', dst: 'refs/heads/main', force: false }] })

  await assert.rejects(
    () => mergeIntoUpstream({ client: s.aliceClient, gitDir: s.ownerGitDir, worktree: s.ownerWork, sourceRef: s.forkRef, sourceBranch: 'feature', mode: 'no-ff' }),
    /conflict/i
  )
  // abort worked: no MERGE_HEAD, working tree back at C3
  assert.throws(() => sh(s.ownerWork, ['rev-parse', '--verify', '-q', 'MERGE_HEAD']), 'MERGE_HEAD cleared by --abort')
  assert.equal(sh(s.ownerWork, ['rev-parse', 'HEAD']).trim(), c3)
  // upstream ref never advanced
  assert.equal((await upstream.getRef('refs/heads/main')).targetOid, c3, 'ref untouched after a failed merge')
  cleanup(s)
})

test('re-merging an already-merged branch is a no-op (up-to-date)', async () => {
  const s = await scenario()
  const first = await mergeIntoUpstream({ client: s.aliceClient, gitDir: s.ownerGitDir, worktree: s.ownerWork, sourceRef: s.forkRef, sourceBranch: 'feature' })
  assert.equal(first.newTip, s.c2)
  const again = await mergeIntoUpstream({ client: s.aliceClient, gitDir: s.ownerGitDir, worktree: s.ownerWork, sourceRef: s.forkRef, sourceBranch: 'feature' })
  assert.equal(again.kind, 'up-to-date')
  assert.deepEqual(again.copied, [])
  assert.equal(again.newTip, s.c2)
  cleanup(s)
})

test('merge bootstraps content into an empty upstream (base === null)', async () => {
  // upstream created but never pushed to (no refs); a fork carries the first commit.
  const dataDir = mkd('ig-merge-empty-')
  const store = createFsStore({ dataDir, filter: null })
  const alice = await throwawayIdentity(); const bob = await throwawayIdentity()
  const aliceClient = createClient({ store, identity: alice.identity }); await aliceClient.ready
  const bobClient = createClient({ store, identity: bob.identity }); await bobClient.ready

  const upstreamRef = await initRepo({ client: aliceClient, id: crypto.randomUUID(), name: 'empty', in: ['server-public'], defaultBranch: 'refs/heads/main' })
  const { ref: forkRef } = await forkRepo({ client: bobClient, upstreamRef })

  // bob builds C1 locally and pushes it to the fork's main
  const up = mkd('ig-merge-empty-up-')
  sh(up, ['init', '-q', '-b', 'main'])
  writeFileSync(join(up, 'readme.md'), 'first\n'); sh(up, ['add', '-A']); sh(up, ['commit', '-q', '-m', 'c1'])
  const c1 = sh(up, ['rev-parse', 'HEAD']).trim()
  const fork = await openRepo({ client: bobClient, repoRef: forkRef })
  await pushToRemote({ repo: fork, gitDir: join(up, '.git'), pushes: [{ src: 'refs/heads/main', dst: 'refs/heads/main', force: false }] })

  // owner has an empty (unborn-HEAD) checkout of the still-empty upstream
  const ownerWork = mkd('ig-merge-empty-owner-')
  sh(ownerWork, ['init', '-q', '-b', 'main'])
  sh(ownerWork, ['config', 'user.name', 'Owner']); sh(ownerWork, ['config', 'user.email', 'owner@example.com'])

  const res = await mergeIntoUpstream({ client: aliceClient, gitDir: join(ownerWork, '.git'), worktree: ownerWork, sourceRef: forkRef, sourceBranch: 'main' })
  assert.equal(res.base, null)
  assert.equal(res.newTip, c1)
  const upstream = await openRepo({ client: aliceClient, repoRef: upstreamRef })
  assert.equal((await upstream.getRef('refs/heads/main')).targetOid, c1, 'empty upstream main created at C1')

  for (const d of [dataDir, up, ownerWork]) try { rmSync(d, { recursive: true, force: true }) } catch {}
})
