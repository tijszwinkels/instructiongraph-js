/**
 * End-to-end through REAL git across TWO identities: the whole collaboration
 * loop from the Q5 memo —
 *
 *   owner: ig git init upstream + push C1
 *   contributor: ig git fork → clone fork → commit C2 → push (thin: only C2)
 *   owner: clone upstream → ig git merge <fork> feature
 *   anyone: clone upstream → git fsck clean, history intact, C2 byte-identical
 *
 * Proves the resolver fallthrough (fork clone resolves C1 from upstream), the
 * thin push (fork stores only its delta), and owner re-signed copies carrying
 * `copied_from` provenance.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { mkTmp } from '../test-support/git-fixture.js'
import { setupIgStore, setupHelperOnPath, gitEnv, addIdentity, setActiveIdentity } from '../test-support/ig-store.js'

const IG = fileURLToPath(new URL('../cli/ig.js', import.meta.url))

let store, bindir, env, ownerPk, bobPk
const cleanup = []

before(async () => {
  store = await setupIgStore({ realm: 'server-public' }) // active identity: 'default' (owner)
  ownerPk = store.pubkey
  bobPk = await addIdentity(store, 'bob')
  bindir = setupHelperOnPath()
  // Owner git identity: the person running `ig git merge --no-ff` has git
  // configured. Explicit per-commit env (owner C1, Bob's commits) overrides this.
  env = gitEnv(store, bindir, {
    GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com',
    GIT_COMMITTER_NAME: 'Owner', GIT_COMMITTER_EMAIL: 'owner@example.com',
  })
  cleanup.push(store.dir, bindir)
})
after(() => { for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

/** Fixed git identity so the contributor's commit is byte-reproducible/assertable. */
function bobGit(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], {
    env: {
      ...env,
      GIT_AUTHOR_NAME: 'Bob Contributor', GIT_AUTHOR_EMAIL: 'bob@example.com',
      GIT_AUTHOR_DATE: '1700001000 +0000',
      GIT_COMMITTER_NAME: 'Bob Contributor', GIT_COMMITTER_EMAIL: 'bob@example.com',
      GIT_COMMITTER_DATE: '1700001000 +0000',
    },
    maxBuffer: 1 << 26,
  }).toString('utf-8')
}
function rgit(dir, args) {
  return execFileSync('git', ['-C', dir, ...args], { env, maxBuffer: 1 << 26 }).toString('utf-8')
}
function ig(cwd, args) {
  return execFileSync('node', [IG, ...args], { env, cwd, maxBuffer: 1 << 26 }).toString('utf-8')
}
/** True if `ig get <ref>` finds the object (exit 0); false on not-found (exit 1). */
function igGetExists(ref, identity) {
  try {
    execFileSync('node', [IG, 'get', ref, '--identity', identity], { env, cwd: tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] })
    return true
  } catch { return false }
}

/** Owner creates `upstream` with a single commit C1 (readme.md) on main. */
function seedUpstream() {
  setActiveIdentity(store, 'default')
  const ref = ig(tmpdir(), ['git', 'init', 'upstream', '--realm', 'server-public']).trim()
  const work = mkTmp('ig-fm-upstream-')
  cleanup.push(work)
  rgit(work, ['init', '-q', '-b', 'main'])
  writeFileSync(join(work, 'readme.md'), 'hello world\n')
  rgit(work, ['add', '-A'])
  execFileSync('git', ['-C', work, 'commit', '-q', '-m', 'first commit'], {
    env: { ...env, GIT_AUTHOR_NAME: 'Owner', GIT_AUTHOR_EMAIL: 'owner@example.com',
      GIT_AUTHOR_DATE: '1700000000 +0000', GIT_COMMITTER_NAME: 'Owner',
      GIT_COMMITTER_EMAIL: 'owner@example.com', GIT_COMMITTER_DATE: '1700000000 +0000' },
  })
  rgit(work, ['remote', 'add', 'origin', `ig::${ref}`])
  rgit(work, ['push', 'origin', 'main'])
  return { ref, c1: rgit(work, ['rev-parse', 'main']).trim() }
}

/** Bob forks, clones the fork, commits C2 on `feature`, pushes (thin). */
function contributorFork(upstreamRef) {
  setActiveIdentity(store, 'bob')
  const forkRef = ig(tmpdir(), ['git', 'fork', upstreamRef, '--name', 'fork', '--identity', 'bob']).trim()

  const clone = mkTmp('ig-fm-forkclone-')
  cleanup.push(clone)
  rmSync(clone, { recursive: true, force: true })
  execFileSync('git', ['clone', '--quiet', `ig::${forkRef}`, clone], { env, cwd: tmpdir(), maxBuffer: 1 << 26 })

  // resolver fallthrough proof: cloning the thin fork reconstructs C1's tree,
  // whose objects live ONLY in the upstream namespace.
  execFileSync('git', ['-C', clone, 'fsck', '--full', '--strict'], { env, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] })
  assert.equal(rgit(clone, ['show', 'HEAD:readme.md']), 'hello world\n', 'fork clone resolves upstream C1 content')

  bobGit(clone, ['checkout', '-q', '-b', 'feature'])
  writeFileSync(join(clone, 'readme.md'), 'hello world\nbob was here\n')
  bobGit(clone, ['add', '-A'])
  bobGit(clone, ['commit', '-q', '-m', 'bob: add a line'])
  const c2 = rgit(clone, ['rev-parse', 'HEAD']).trim()
  rgit(clone, ['push', 'origin', 'feature'])
  return { forkRef, clone, c2 }
}

/** Owner clones upstream and returns the working copy dir. */
function ownerCloneUpstream(upstreamRef) {
  setActiveIdentity(store, 'default')
  const work = mkTmp('ig-fm-ownerwork-')
  cleanup.push(work)
  rmSync(work, { recursive: true, force: true })
  execFileSync('git', ['clone', '--quiet', `ig::${upstreamRef}`, work], { env, cwd: tmpdir(), maxBuffer: 1 << 26 })
  return work
}

/** Fresh clone + fsck; returns the clone dir. */
function verifyClone(upstreamRef, prefix) {
  const clone = mkTmp(prefix)
  cleanup.push(clone)
  rmSync(clone, { recursive: true, force: true })
  execFileSync('git', ['clone', '--quiet', `ig::${upstreamRef}`, clone], { env, cwd: tmpdir(), maxBuffer: 1 << 26 })
  execFileSync('git', ['-C', clone, 'fsck', '--full', '--strict'], { env, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] })
  return clone
}

test('fast-forward merge: contributor commit lands in upstream byte-identically', () => {
  const { ref: upstreamRef, c1 } = seedUpstream()
  const { forkRef, c2 } = contributorFork(upstreamRef)

  // thin fork: it stored ONLY its own delta — C1 is NOT in Bob's fork namespace
  assert.equal(igGetExists(`${bobPk}.${uuidv5ObjSync(forkRef, c1)}`, 'bob'), false, 'fork does not store C1 (resolves it upstream)')
  assert.equal(igGetExists(`${bobPk}.${uuidv5ObjSync(forkRef, c2)}`, 'bob'), true, 'fork stores its own delta commit C2')

  const ownerWork = ownerCloneUpstream(upstreamRef)
  setActiveIdentity(store, 'default')
  const out = ig(ownerWork, ['git', 'merge', forkRef, 'feature', '--identity', 'default'])
  assert.match(out.trim(), new RegExp(`^${c2}$`), 'merge prints the new upstream tip = C2 (ff)')

  const clone = verifyClone(upstreamRef, 'ig-fm-verify-ff-')
  assert.equal(rgit(clone, ['rev-parse', 'main']).trim(), c2, 'upstream main fast-forwarded to C2')
  // history intact: both commits, in order
  assert.equal(rgit(clone, ['log', '--format=%s', 'main']).trim(), 'bob: add a line\nfirst commit')
  // byte-identical: C2 present with Bob's authorship
  assert.equal(rgit(clone, ['cat-file', '-t', c2]).trim(), 'commit')
  assert.match(rgit(clone, ['cat-file', 'commit', c2]), /author Bob Contributor <bob@example\.com>/)
  assert.equal(rgit(clone, ['show', `${c2}:readme.md`]), 'hello world\nbob was here\n')

  // provenance: the owner-copy of C2 carries copied_from → Bob's fork object
  const copy = JSON.parse(ig(tmpdir(), ['get', `${ownerPk}.${uuidv5ObjSync(upstreamRef, c2)}`, '--identity', 'default']))
  assert.equal(copy.item.pubkey, ownerPk, 'C2 copy is owner-signed')
  assert.equal(copy.item.relations.copied_from[0].ref, `${bobPk}.${uuidv5ObjSync(forkRef, c2)}`)
})

test('--no-ff merge: creates an owner merge commit whose parents include C2', () => {
  const { ref: upstreamRef, c1 } = seedUpstream()
  const { forkRef, c2 } = contributorFork(upstreamRef)

  const ownerWork = ownerCloneUpstream(upstreamRef)
  setActiveIdentity(store, 'default')
  const out = ig(ownerWork, ['git', 'merge', forkRef, 'feature', '--no-ff', '--identity', 'default', '--message', 'Merge feature']).trim()
  const mergeTip = out.split('\n').pop().trim()

  const clone = verifyClone(upstreamRef, 'ig-fm-verify-noff-')
  assert.equal(rgit(clone, ['rev-parse', 'main']).trim(), mergeTip)
  // merge commit has two parents: C1 and C2
  const parents = rgit(clone, ['rev-list', '--parents', '-n', '1', mergeTip]).trim().split(/\s+/).slice(1)
  assert.deepEqual(parents.sort(), [c1, c2].sort(), 'merge commit parents are C1 and C2')
  // Bob's commit is present byte-identically inside the merged history
  assert.match(rgit(clone, ['cat-file', 'commit', c2]), /author Bob Contributor/)
  assert.equal(rgit(clone, ['show', `${c2}:readme.md`]), 'hello world\nbob was here\n')
})

// ── inline uuid_v5("obj:"+oid) so tests can address stored objects ──
function uuidv5ObjSync(repoRef, oid) {
  const repoId = repoRef.split('.').slice(1).join('.')
  const nsHex = repoId.replace(/-/g, '')
  const ns = Buffer.from(nsHex, 'hex')
  const name = Buffer.from('obj:' + oid, 'utf-8')
  const h = createHash('sha1').update(Buffer.concat([ns, name])).digest()
  const b = h.subarray(0, 16)
  b[6] = (b[6] & 0x0f) | 0x50
  b[8] = (b[8] & 0x3f) | 0x80
  const hex = b.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}
