/**
 * End-to-end through REAL git: push a mixed-content repository through the
 * git-remote-ig helper into a local ig store, then clone it back and prove the
 * result is byte-identical and fsck-clean.
 *
 * Exercises binary files, a subdirectory, an executable bit, a symlink, a
 * unicode filename, a merge commit, an annotated tag and a lightweight tag,
 * plus incremental push, fast-forward enforcement, force, and branch delete.
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { rmSync, writeFileSync, mkdtempSync, readFileSync, readlinkSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildFixtureRepo, git, mkTmp } from '../test-support/git-fixture.js'
import { setupIgStore, setupHelperOnPath, gitEnv } from '../test-support/ig-store.js'

let store, bindir, env
const cleanup = []

before(async () => {
  store = await setupIgStore({ realm: 'server-public' })
  bindir = setupHelperOnPath()
  env = gitEnv(store, bindir)
  cleanup.push(store.dir, bindir)
})
after(() => { for (const d of cleanup) { try { rmSync(d, { recursive: true, force: true }) } catch {} } })

/** run git with the helper env; throw with stderr on failure. */
function rgit(dir, args, extraEnv) {
  return execFileSync('git', ['-C', dir, ...args], {
    env: extraEnv ? { ...env, ...extraEnv } : env,
    maxBuffer: 1 << 26,
  }).toString('utf-8')
}
/** git clone has no -C target repo; run from a parent cwd. */
function rclone(url, dest) {
  return execFileSync('git', ['clone', '--quiet', url, dest], { env, maxBuffer: 1 << 26, cwd: tmpdir() }).toString('utf-8')
}

test('push mixed-content repo, clone it back: identical oids, fsck-clean, history intact', () => {
  const src = buildFixtureRepo()
  cleanup.push(src.dir)
  const repoRef = `${store.pubkey}.${crypto.randomUUID()}`

  rgit(src.dir, ['remote', 'add', 'origin', `ig::${repoRef}`])
  rgit(src.dir, ['push', 'origin', '--all'])
  rgit(src.dir, ['push', 'origin', '--tags'])

  const clone = mkTmp('ig-e2e-clone-')
  cleanup.push(clone)
  rmSync(clone, { recursive: true, force: true }) // clone wants to create it
  rclone(`ig::${repoRef}`, clone)

  // fsck must be clean: it exits non-zero (throwing) on missing/broken/corrupt
  // objects; dangling objects are only warnings and keep exit 0.
  try {
    execFileSync('git', ['-C', clone, 'fsck', '--full', '--strict'], { env, maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] })
  } catch (e) {
    assert.fail(`git fsck reported problems:\n${(e.stderr || e.stdout || e.message).toString()}`)
  }

  // HEAD + branches identical
  assert.equal(rgit(clone, ['rev-parse', 'HEAD']).trim(), src.head)
  assert.equal(rgit(clone, ['rev-parse', 'refs/remotes/origin/main']).trim(), src.head)
  const srcSide = rgit(src.dir, ['rev-parse', 'refs/heads/side']).trim()
  assert.equal(rgit(clone, ['rev-parse', 'refs/remotes/origin/side']).trim(), srcSide)

  // annotated + lightweight tags identical (and v1.0 is a real tag object)
  const srcV1 = rgit(src.dir, ['rev-parse', 'refs/tags/v1.0']).trim()
  assert.equal(rgit(clone, ['rev-parse', 'refs/tags/v1.0']).trim(), srcV1)
  assert.equal(rgit(clone, ['cat-file', '-t', 'refs/tags/v1.0']).trim(), 'tag')
  assert.equal(rgit(clone, ['rev-parse', 'refs/tags/light']).trim(),
               rgit(src.dir, ['rev-parse', 'refs/tags/light']).trim())

  // full object graph parity: every reachable oid in src exists in clone
  const srcObjs = new Set(rgit(src.dir, ['rev-list', '--objects', '--all']).trim().split('\n').map(l => l.split(' ')[0]))
  const cloneObjs = new Set(rgit(clone, ['rev-list', '--objects', '--all']).trim().split('\n').map(l => l.split(' ')[0]))
  for (const o of srcObjs) assert.ok(cloneObjs.has(o), `clone missing object ${o}`)

  // history intact
  assert.equal(rgit(clone, ['log', '--oneline', 'origin/main']).trim(),
               rgit(src.dir, ['log', '--oneline', 'main']).trim())

  // tree fidelity: exec bit, symlink, subdir, unicode filename preserved
  // (-c core.quotePath=false so non-ASCII paths are shown literally, not octal-escaped)
  const tree = rgit(clone, ['-c', 'core.quotePath=false', 'ls-tree', '-r', 'HEAD'])
  assert.match(tree, /100755 blob .+\trun\.sh/, 'executable bit preserved')
  assert.match(tree, /120000 blob .+\tlink/, 'symlink preserved')
  assert.match(tree, /\tlib\/core\.js/, 'subdirectory preserved')
  assert.match(tree, /lib\/ünïcödé\.txt/, 'unicode filename preserved')

  // checked-out working tree matches: symlink target + binary bytes
  assert.equal(readlinkSync(join(clone, 'link')), 'readme.md')
  assert.deepEqual(readFileSync(join(clone, 'data.bin')), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x0a, 0x7f]))
  assert.ok(statSync(join(clone, 'run.sh')).mode & 0o111, 'run.sh executable on checkout')
})

test('incremental push fast-forwards; fetch picks up the new commit', () => {
  const src = buildFixtureRepo()
  cleanup.push(src.dir)
  const repoRef = `${store.pubkey}.${crypto.randomUUID()}`
  rgit(src.dir, ['remote', 'add', 'origin', `ig::${repoRef}`])
  rgit(src.dir, ['push', 'origin', 'main'])

  const clone = mkTmp('ig-e2e-inc-')
  cleanup.push(clone)
  rmSync(clone, { recursive: true, force: true })
  rclone(`ig::${repoRef}`, clone)

  // new commit on src, push (fast-forward)
  writeFileSync(join(src.dir, 'newfile.txt'), 'incremental\n')
  git(src.dir, ['add', '-A'])
  git(src.dir, ['commit', '-q', '-m', 'incremental commit'])
  const newHead = rgit(src.dir, ['rev-parse', 'HEAD']).trim()
  rgit(src.dir, ['push', 'origin', 'main'])

  // clone fetches the update
  rgit(clone, ['fetch', '--quiet', 'origin'])
  assert.equal(rgit(clone, ['rev-parse', 'refs/remotes/origin/main']).trim(), newHead)
})

test('non-fast-forward push is rejected without --force, accepted with it', () => {
  const src = buildFixtureRepo()
  cleanup.push(src.dir)
  const repoRef = `${store.pubkey}.${crypto.randomUUID()}`
  rgit(src.dir, ['remote', 'add', 'origin', `ig::${repoRef}`])
  rgit(src.dir, ['push', 'origin', 'main'])

  // rewrite history: amend the tip so it diverges
  git(src.dir, ['commit', '-q', '--amend', '-m', 'rewritten tip'])

  // plain push must fail
  let failed = false
  try { rgit(src.dir, ['push', 'origin', 'main']) } catch { failed = true }
  assert.ok(failed, 'non-fast-forward push should be rejected')

  // forced push succeeds and advances the remote
  rgit(src.dir, ['push', '--force', 'origin', 'main'])
  const forcedHead = rgit(src.dir, ['rev-parse', 'HEAD']).trim()

  const clone = mkTmp('ig-e2e-force-')
  cleanup.push(clone)
  rmSync(clone, { recursive: true, force: true })
  rclone(`ig::${repoRef}`, clone)
  assert.equal(rgit(clone, ['rev-parse', 'HEAD']).trim(), forcedHead)
})

test('documented flow: `ig git init` then push to the pre-created anchor', () => {
  const igCli = fileURLToPath(new URL('../cli/ig.js', import.meta.url))
  const ref = execFileSync('node', [igCli, 'git', 'init', 'documented', '--realm', 'server-public'], { env })
    .toString('utf-8').trim()
  assert.match(ref, new RegExp(`^${store.pubkey}\\.[0-9a-f-]{36}$`), 'ig git init prints the repo ref')

  const src = buildFixtureRepo()
  cleanup.push(src.dir)
  rgit(src.dir, ['remote', 'add', 'origin', `ig::${ref}`])
  rgit(src.dir, ['push', 'origin', 'main']) // pushes to the existing anchor (no auto-create)

  const clone = mkTmp('ig-e2e-doc-')
  cleanup.push(clone)
  rmSync(clone, { recursive: true, force: true })
  rclone(`ig::${ref}`, clone)
  assert.equal(rgit(clone, ['rev-parse', 'HEAD']).trim(), rgit(src.dir, ['rev-parse', 'main']).trim())
})

test('deleting a branch via push removes it from ls-remote', () => {
  const src = buildFixtureRepo()
  cleanup.push(src.dir)
  const repoRef = `${store.pubkey}.${crypto.randomUUID()}`
  rgit(src.dir, ['remote', 'add', 'origin', `ig::${repoRef}`])
  rgit(src.dir, ['push', 'origin', '--all'])

  let refs = rgit(src.dir, ['ls-remote', 'origin'])
  assert.match(refs, /refs\/heads\/side/, 'side branch present before delete')

  rgit(src.dir, ['push', 'origin', '--delete', 'side'])
  refs = rgit(src.dir, ['ls-remote', 'origin'])
  assert.ok(!/refs\/heads\/side/.test(refs), 'side branch gone after delete')
})
