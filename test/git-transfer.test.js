/**
 * Transfer-layer hardening (from the codex correctness review):
 *   - a non-commit object cannot be pushed to a branch
 *   - a shallow repository refuses object-bearing pushes
 *   - `git replace` substitution is ignored (true payloads are stored)
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createClient } from '../src/client.js'
import { createFsStore } from '../src/store/fs.js'
import { buildFixtureRepo, git, mkTmp } from '../test-support/git-fixture.js'
import { throwawayIdentity } from '../test-support/throwaway-identity.js'
import { initRepo, openRepo } from '../src/git/repo.js'
import { pushToRemote } from '../src/git/transfer.js'

async function freshRepo() {
  const dataDir = mkdtempSync(join(tmpdir(), 'ig-xfer-'))
  const store = createFsStore({ dataDir, filter: null })
  const id = await throwawayIdentity()
  const client = createClient({ store, identity: id.identity })
  await client.ready
  const repoRef = await initRepo({ client, id: crypto.randomUUID(), name: 'xfer', in: ['server-public'] })
  const repo = await openRepo({ client, repoRef })
  return { repo, dataDir }
}

test('a non-commit object cannot be pushed to a branch', async () => {
  const { repo, dataDir } = await freshRepo()
  const fx = buildFixtureRepo()
  const gitDir = join(fx.dir, '.git')
  const blob = execFileSync('git', ['-C', fx.dir, 'hash-object', '-w', '--stdin'], { input: Buffer.from('loose\n') }).toString().trim()

  const res = await pushToRemote({ repo, gitDir, pushes: [{ src: blob, dst: 'refs/heads/bad', force: false }] })
  assert.equal(res[0].ok, false)
  assert.match(res[0].error, /non-commit/i)

  rmSync(fx.dir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

test('a shallow repository refuses object-bearing pushes but allows deletes', async () => {
  const { repo, dataDir } = await freshRepo()
  const fx = buildFixtureRepo()
  // shallow clone of the fixture
  const shallow = mkTmp('ig-xfer-shallow-')
  execFileSync('git', ['clone', '--quiet', '--depth=1', `file://${fx.dir}`, shallow])
  const gitDir = join(shallow, '.git')

  const res = await pushToRemote({ repo, gitDir, pushes: [{ src: 'HEAD', dst: 'refs/heads/main', force: false }] })
  assert.equal(res[0].ok, false)
  assert.match(res[0].error, /shallow/i)

  // a delete (empty src) is still permitted
  const del = await pushToRemote({ repo, gitDir, pushes: [{ src: '', dst: 'refs/heads/whatever', force: false }] })
  assert.equal(del[0].ok, true)

  rmSync(fx.dir, { recursive: true, force: true })
  rmSync(shallow, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})

test('`git replace` substitution is ignored — true payloads are stored', async () => {
  const { repo, dataDir } = await freshRepo()
  const fx = buildFixtureRepo()
  const gitDir = join(fx.dir, '.git')

  const head = execFileSync('git', ['-C', fx.dir, 'rev-parse', 'HEAD']).toString().trim()
  const firstParent = execFileSync('git', ['-C', fx.dir, 'rev-parse', 'HEAD^1']).toString().trim()
  // replace the first-parent commit with HEAD — cat-file would lie without the guard
  git(fx.dir, ['replace', firstParent, head])

  const res = await pushToRemote({ repo, gitDir, pushes: [{ src: 'HEAD', dst: 'refs/heads/main', force: false }] })
  assert.equal(res[0].ok, true, `push should succeed, got: ${res[0].error}`)

  // the replaced commit must be stored with ITS OWN true payload, not HEAD's
  const stored = await repo.getObject(firstParent)
  assert.ok(stored, 'replaced commit stored under its own oid')
  const trueParentPayload = execFileSync('git', ['-C', fx.dir, `--no-replace-objects`, 'cat-file', 'commit', firstParent], { maxBuffer: 1 << 20 })
  assert.deepEqual(Buffer.from(stored.payload), trueParentPayload)

  rmSync(fx.dir, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
})
