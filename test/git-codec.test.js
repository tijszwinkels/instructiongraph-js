/**
 * Codec correctness against REAL git objects (ground truth from the git CLI).
 *   - oid recomputation matches git for every object kind
 *   - payload → ig content → payload is byte-identical (authoritative round-trip)
 *   - text/binary storage mode is chosen losslessly
 *   - parsed mirrors reflect the payload for well-formed objects
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rmSync } from 'node:fs'

import { buildFixtureRepo, objectsOfType } from '../test-support/git-fixture.js'
import { computeOid } from '../src/git/oid.js'
import { payloadToContent, contentToPayload, parseCommit, parseTree, parseTag } from '../src/git/codec.js'

const repo = buildFixtureRepo()
process.on('exit', () => { try { rmSync(repo.dir, { recursive: true, force: true }) } catch {} })

test('computeOid matches git for every object in the fixture', async () => {
  assert.ok(repo.objects.length >= 8, `expected several objects, got ${repo.objects.length}`)
  for (const o of repo.objects) {
    const oid = await computeOid(o.type, o.payload, 'sha1')
    assert.equal(oid, o.oid, `${o.type} ${o.oid} recomputed as ${oid}`)
  }
})

test('empty blob has the canonical git oid', async () => {
  const oid = await computeOid('blob', Buffer.alloc(0), 'sha1')
  assert.equal(oid, 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
})

test('payload → content → payload is byte-identical for every object', async () => {
  for (const o of repo.objects) {
    const content = await payloadToContent(o.type, o.payload, 'sha1')
    assert.equal(content.oid, o.oid)
    assert.equal(content.otype, o.type)
    assert.equal(content.size, o.payload.length)
    const back = contentToPayload(content)
    assert.deepEqual(Buffer.from(back), o.payload, `${o.type} ${o.oid} did not round-trip`)
  }
})

test('text blobs store as text, binary blobs store as base64 data', async () => {
  const blobs = objectsOfType(repo, 'blob')
  const textBlob = blobs.find(b => b.payload.toString('utf-8') === 'hello world\n')
  const binBlob = blobs.find(b => b.payload.includes(0x00))
  assert.ok(textBlob && binBlob, 'fixture should have a text and a binary blob')

  const textContent = await payloadToContent('blob', textBlob.payload, 'sha1')
  assert.equal(textContent.text, 'hello world\n')
  assert.ok(!('data' in textContent), 'text blob must not use data')

  const binContent = await payloadToContent('blob', binBlob.payload, 'sha1')
  assert.ok('data' in binContent, 'binary blob must use base64 data')
  assert.ok(!('text' in binContent), 'binary blob must not use text')
})

test('sha256 mirror is the SHA-256 of the payload bytes alone', async () => {
  const { createHash } = await import('node:crypto')
  const o = repo.objects[0]
  const content = await payloadToContent(o.type, o.payload, 'sha1')
  const expected = createHash('sha256').update(o.payload).digest('hex')
  assert.equal(content.sha256, expected)
})

test('parseCommit reflects the merge commit (two parents)', () => {
  const commits = objectsOfType(repo, 'commit')
  const merge = commits.map(c => ({ c, p: parseCommit(c.payload) }))
                       .find(x => x.p.parents.length === 2)
  assert.ok(merge, 'fixture should contain a merge commit')
  const { p } = merge
  assert.match(p.tree, /^[a-f0-9]{40}$/)
  assert.equal(p.parents.length, 2)
  assert.ok(p.author.includes('Fixture Author'))
  assert.ok(p.committer.includes('Fixture Committer'))
  assert.equal(p.message, 'merge side\n')
})

test('parseTree yields mode/name/oid entries with normalized dir mode', () => {
  const trees = objectsOfType(repo, 'tree')
  // find the root tree of HEAD
  const headCommit = objectsOfType(repo, 'commit').find(c => c.oid === repo.head)
  const rootOid = parseCommit(headCommit.payload).tree
  const rootTree = trees.find(t => t.oid === rootOid)
  const entries = parseTree(rootTree.payload)
  const byName = Object.fromEntries(entries.map(e => [e.name, e]))

  assert.equal(byName['readme.md'].mode, '100644')
  assert.equal(byName['run.sh'].mode, '100755')
  assert.equal(byName['lib'].mode, '040000', 'directory mode normalized to 6 digits')
  for (const e of entries) assert.match(e.oid, /^[a-f0-9]{40}$/)
})

test('parseTree round-trips a symlink entry (mode 120000)', () => {
  const trees = objectsOfType(repo, 'tree')
  const withLink = trees.map(parseTreeSafe).find(es => es && es.some(e => e.mode === '120000'))
  assert.ok(withLink, 'fixture should contain a symlink tree entry')
  function parseTreeSafe(t) { try { return parseTree(t.payload) } catch { return null } }
})

test('parseTag reflects the annotated tag', () => {
  const tags = objectsOfType(repo, 'tag')
  assert.equal(tags.length, 1, 'exactly one annotated tag object')
  const t = parseTag(tags[0].payload)
  assert.match(t.object, /^[a-f0-9]{40}$/)
  assert.equal(t.target_type, 'commit')
  assert.equal(t.tag, 'v1.0')
  assert.ok(t.tagger.includes('Fixture'))
  assert.equal(t.message, 'release one\n')
})
