/**
 * Test-support: build a real git repository with the git CLI and expose its
 * raw object bytes/oids, so codec tests can byte-compare against ground truth.
 *
 * Everything here uses the actual `git` binary — never our own codec — so the
 * fixtures are independent ground truth.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Fixed identity + dates so commit/tag oids are reproducible across runs. */
const FIXED_ENV = {
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'author@example.com',
  GIT_AUTHOR_DATE: '1700000000 +0000',
  GIT_COMMITTER_NAME: 'Fixture Committer',
  GIT_COMMITTER_EMAIL: 'committer@example.com',
  GIT_COMMITTER_DATE: '1700000100 +0000',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
}

/** Run git in `dir`, returning stdout as a Buffer. */
export function git(dir, args, { env = {}, input } = {}) {
  return execFileSync('git', ['-C', dir, ...args], {
    env: { ...process.env, ...FIXED_ENV, ...env },
    input,
    maxBuffer: 64 * 1024 * 1024,
  })
}

/** Run git and decode stdout as a trimmed utf-8 string. */
function gitStr(dir, args, opts) {
  return git(dir, args, opts).toString('utf-8').trim()
}

/** Create a fresh temp dir. */
export function mkTmp(prefix = 'ig-git-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

/**
 * Build a repository exercising the tricky cases: text/binary/empty blobs,
 * a subdirectory, an executable bit, a symlink, a merge commit, and an
 * annotated tag. Returns the repo path plus ground-truth object/ref data.
 *
 * @param {string} [dir] - existing dir to init in (default: fresh temp dir)
 * @returns {{ dir: string, objects: {oid:string,type:string,size:number,payload:Buffer}[], refs: {name:string,oid:string}[], head: string, headBranch: string }}
 */
export function buildFixtureRepo(dir = mkTmp()) {
  git(dir, ['init', '-q', '-b', 'main'])

  // ── first commit: text + binary + executable + subdir + empty file ──
  writeFileSync(join(dir, 'readme.md'), 'hello world\n')
  writeFileSync(join(dir, 'empty.txt'), '')
  // binary content incl. NUL and non-utf8 bytes
  writeFileSync(join(dir, 'data.bin'), Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x80, 0x0a, 0x7f]))
  const script = join(dir, 'run.sh')
  writeFileSync(script, '#!/bin/sh\necho hi\n')
  chmodSync(script, 0o755)
  mkdirSync(join(dir, 'lib'))
  writeFileSync(join(dir, 'lib', 'core.js'), 'export const x = 1\n')
  // unicode filename
  writeFileSync(join(dir, 'lib', 'ünïcödé.txt'), 'café\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'first commit'])

  // ── second commit on a side branch: adds a symlink, modifies a file ──
  git(dir, ['checkout', '-q', '-b', 'side'])
  symlinkSync('readme.md', join(dir, 'link'))
  writeFileSync(join(dir, 'readme.md'), 'hello world\nsecond line\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'side: symlink + edit'])

  // ── merge side into main ──
  git(dir, ['checkout', '-q', 'main'])
  writeFileSync(join(dir, 'lib', 'core.js'), 'export const x = 2\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-q', '-m', 'main: bump'])
  git(dir, ['merge', '-q', '--no-ff', '-m', 'merge side', 'side'])

  // ── annotated tag ──
  git(dir, ['tag', '-a', 'v1.0', '-m', 'release one'])
  // lightweight tag
  git(dir, ['tag', 'light'])

  return readRepo(dir)
}

/** Read every object + ref from an existing repo (via git, not our codec). */
export function readRepo(dir) {
  // enumerate all objects
  const listing = gitStr(dir, ['cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype) %(objectsize)'])
  const objects = []
  for (const line of listing.split('\n').filter(Boolean)) {
    const [oid, type, sizeStr] = line.split(' ')
    const payload = git(dir, ['cat-file', type, oid])
    objects.push({ oid, type, size: Number(sizeStr), payload })
  }

  // enumerate refs (branches + tags), resolving symbolic HEAD separately
  const refLines = gitStr(dir, ['show-ref']).split('\n').filter(Boolean)
  const refs = refLines.map(l => {
    const [oid, name] = l.split(' ')
    return { name, oid }
  })
  const headBranch = gitStr(dir, ['symbolic-ref', 'HEAD']) // e.g. refs/heads/main
  const head = gitStr(dir, ['rev-parse', 'HEAD'])

  return { dir, objects, refs, head, headBranch }
}

/** Convenience: the sole object of a given type, or throw. */
export function objectsOfType(repo, type) {
  return repo.objects.filter(o => o.type === type)
}
