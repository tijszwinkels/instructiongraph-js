/**
 * Adversarial codec edge cases, each built as a REAL git object with
 * `git hash-object -w` (stores payloads verbatim) then read back via cat-file:
 *   - gpgsig commits (folded multi-line header)
 *   - non-UTF8 author names (must store as base64 data, round-trip exact)
 *   - empty tree / empty blob
 *   - CRLF text blobs
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'

import { mkTmp, git } from '../test-support/git-fixture.js'
import { payloadToContent, contentToPayload, parseCommit, parseTree } from '../src/git/codec.js'

const dir = mkTmp('ig-git-edge-')
git(dir, ['init', '-q', '-b', 'main'])
process.on('exit', () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} })

/** Write raw bytes as a git object of `type`, return its oid; read it back exact. */
function hashObject(type, payload) {
  const oid = execFileSync('git', ['-C', dir, 'hash-object', '-w', '-t', type, '--stdin'], { input: payload })
    .toString('utf-8').trim()
  const back = execFileSync('git', ['-C', dir, 'cat-file', type, oid], { maxBuffer: 1 << 24 })
  return { oid, payload: back }
}

async function assertRoundTrips(type, payload) {
  const content = await payloadToContent(type, payload, 'sha1')
  const { oid } = hashObject(type, payload)
  assert.equal(content.oid, oid, 'oid must match git')
  assert.deepEqual(Buffer.from(contentToPayload(content)), Buffer.from(payload), 'payload must round-trip')
  return content
}

test('gpgsig commit: payload round-trips and mirror still extracts fields', async () => {
  const tree = 'a'.repeat(40)
  const parent = 'b'.repeat(40)
  const sig = [
    'gpgsig -----BEGIN PGP SIGNATURE-----',
    ' ',
    ' iQEzBAABCAAdFiEEexampleexampleexampleexampleexampleAAoJEHexample',
    ' =AbCd',
    ' -----END PGP SIGNATURE-----',
  ].join('\n')
  const payload = Buffer.from(
    `tree ${tree}\n` +
    `parent ${parent}\n` +
    `author A U Thor <a@example.com> 1700000000 +0000\n` +
    `committer A U Thor <a@example.com> 1700000100 +0000\n` +
    `${sig}\n` +
    `\n` +
    `signed commit message\n`, 'utf-8')

  const content = await assertRoundTrips('commit', payload)
  const m = content.commit
  assert.equal(m.tree, tree)
  assert.deepEqual(m.parents, [parent])
  assert.equal(m.author, 'A U Thor <a@example.com> 1700000000 +0000')
  assert.equal(m.committer, 'A U Thor <a@example.com> 1700000100 +0000')
  assert.equal(m.message, 'signed commit message\n')
})

test('commit with a non-UTF8 author name stores as base64 data', async () => {
  const tree = 'c'.repeat(40)
  // 0xff 0xfe are invalid UTF-8 — a Latin-1 "ÿþ" author name
  const payload = Buffer.concat([
    Buffer.from('tree ' + tree + '\nauthor ', 'utf-8'),
    Buffer.from([0xff, 0xfe]),
    Buffer.from(' <x@example.com> 1700000000 +0000\ncommitter C <c@example.com> 1700000000 +0000\n\nhi\n', 'utf-8'),
  ])
  const content = await assertRoundTrips('commit', payload)
  assert.ok('data' in content, 'non-UTF8 commit must use data')
  assert.ok(!('text' in content), 'non-UTF8 commit must not use text')
  // mirror still parses the well-formed parts
  assert.equal(content.commit.tree, tree)
})

test('empty tree object round-trips and parses to []', async () => {
  const payload = Buffer.alloc(0)
  const content = await assertRoundTrips('tree', payload)
  assert.equal(content.oid, '4b825dc642cb6eb9a060e54bf8d69288fbee4904', 'canonical empty-tree oid')
  assert.deepEqual(parseTree(payload), [])
  assert.deepEqual(content.entries, [])
})

test('empty blob round-trips as empty text', async () => {
  const content = await assertRoundTrips('blob', Buffer.alloc(0))
  assert.equal(content.text, '')
})

test('CRLF text blob keeps exact bytes as text', async () => {
  const payload = Buffer.from('line1\r\nline2\r\n', 'utf-8')
  const content = await assertRoundTrips('blob', payload)
  assert.equal(content.text, 'line1\r\nline2\r\n')
})

test('commit with no parents (root) parses to empty parents', async () => {
  const payload = Buffer.from(
    'tree ' + 'd'.repeat(40) + '\n' +
    'author A <a@example.com> 1 +0000\ncommitter A <a@example.com> 1 +0000\n\nroot\n', 'utf-8')
  const content = await assertRoundTrips('commit', payload)
  assert.deepEqual(content.commit.parents, [])
})
