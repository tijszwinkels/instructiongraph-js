/**
 * Node git I/O: writing loose objects that real git accepts, and reading local
 * objects via git plumbing. Tested against the actual git CLI.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { buildFixtureRepo, mkTmp, git } from '../test-support/git-fixture.js'
import { writeLooseObject, catFileBatch, revListObjects, revParse, catFileType, isAncestor, objectExists, looseObjectPath } from '../src/git/gitio.js'

test('catFileBatch returns exact type/payload for every fixture object', async () => {
  const repo = buildFixtureRepo()
  const gitDir = join(repo.dir, '.git')
  const oids = repo.objects.map(o => o.oid)
  const got = catFileBatch(gitDir, oids)
  for (const o of repo.objects) {
    const rec = got.get(o.oid)
    assert.ok(rec, `missing ${o.oid}`)
    assert.equal(rec.type, o.type)
    assert.deepEqual(rec.payload, o.payload, `payload mismatch for ${o.type} ${o.oid}`)
  }
  rmSync(repo.dir, { recursive: true, force: true })
})

test('writeLooseObject produces objects real git reads back identically', () => {
  const src = buildFixtureRepo()
  const dst = mkTmp('ig-git-loose-')
  git(dst, ['init', '-q'])
  const dstGit = join(dst, '.git')

  for (const o of src.objects) {
    writeLooseObject(dstGit, o.oid, o.type, o.payload)
    assert.ok(existsSync(looseObjectPath(dstGit, o.oid)), `loose file for ${o.oid} exists`)
  }
  // git must agree on type, size and content for every object we wrote
  for (const o of src.objects) {
    const type = execFileSync('git', ['-C', dst, 'cat-file', '-t', o.oid]).toString().trim()
    const payload = execFileSync('git', ['-C', dst, 'cat-file', o.type, o.oid], { maxBuffer: 1 << 24 })
    assert.equal(type, o.type)
    assert.deepEqual(payload, o.payload)
  }
  rmSync(src.dir, { recursive: true, force: true })
  rmSync(dst, { recursive: true, force: true })
})

test('writeLooseObject is idempotent (skips existing read-only loose files)', () => {
  const dst = mkTmp('ig-git-loose2-')
  git(dst, ['init', '-q'])
  const dstGit = join(dst, '.git')
  const payload = Buffer.from('hello world\n')
  const oid = '3b18e512dba79e4c8300dd08aeb37f8e728b8dad' // git blob oid of "hello world\n"
  writeLooseObject(dstGit, oid, 'blob', payload)
  writeLooseObject(dstGit, oid, 'blob', payload) // no throw
  assert.deepEqual(execFileSync('git', ['-C', dst, 'cat-file', 'blob', oid]), payload)
  rmSync(dst, { recursive: true, force: true })
})

test('revListObjects, revParse, catFileType, isAncestor, objectExists', () => {
  const repo = buildFixtureRepo()
  const gitDir = join(repo.dir, '.git')

  const head = revParse(gitDir, 'HEAD')
  assert.equal(head, repo.head)
  assert.equal(catFileType(gitDir, head), 'commit')
  assert.ok(objectExists(gitDir, head))
  assert.ok(!objectExists(gitDir, 'f'.repeat(40)))

  // every object reachable from HEAD is listed
  const objs = revListObjects(gitDir, head)
  assert.ok(objs.includes(head))
  assert.ok(objs.length >= 5)

  // the first commit is an ancestor of HEAD (merge); a fresh oid is not
  const firstParent = revParse(gitDir, 'HEAD^1')
  assert.ok(isAncestor(gitDir, firstParent, head))
  assert.ok(!isAncestor(gitDir, head, firstParent))

  // --not excludes a tip's reachable set
  const withNot = revListObjects(gitDir, head, [head])
  assert.equal(withNot.length, 0)

  rmSync(repo.dir, { recursive: true, force: true })
})
