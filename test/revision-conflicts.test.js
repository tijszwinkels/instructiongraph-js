import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeypair, sign } from '../src/crypto.js'
import { buildItem } from '../src/object.js'
import { createFsStore } from '../src/store/fs.js'
import { createSyncStore } from '../src/store/sync.js'
import { createClient } from '../src/client.js'

describe('revision conflicts', () => {
  let dir, local, first, second, key

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ig-conflicts-'))
    local = createFsStore({ dataDir: dir })
    key = await generateKeypair()
    const item = buildItem({ pubkey: key.pubkey, in: ['dataverse001'], type: 'NOTE', revision: 1,
      content: { text: 'offline edit A' }, relations: { replies_to: [{ ref: 'target' }] } })
    first = await signed(item)
    second = await signed({ ...item, content: { text: 'offline edit B' } })
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  async function signed(item) {
    return { is: 'instructionGraph001', item, signature: await sign(key.privateKey, item) }
  }

  function remoteStore() {
    const calls = []
    return {
      calls,
      async get(ref, opts = {}) {
        calls.push({ method: 'get', opts })
        // A revision-only ETag must not hide independently authored edits.
        return opts.localRevision === second.item.revision ? { _notModified: true } : second
      },
      async put(obj) {
        calls.push({ method: 'put', obj })
        return { ok: false, status: 409, error: 'revision conflict' }
      },
      async search() { return { items: [second], cursor: null } },
      async inbound() { return { items: [second], cursor: null } },
    }
  }

  function assertPreserved(path, expected) {
    assert.ok(path, 'the caller must get a path to the preserved edit')
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).item, expected.item)
  }

  it('rejects a distinct equal revision and preserves both edits across retries', async () => {
    await local.put(first)
    for (let i = 0; i < 2; i++) {
      const result = await local.put(second)
      assert.equal(result.ok, false)
      assert.equal(result.status, 409)
      assert.equal(result.code, 'REVISION_CONFLICT')
      assertPreserved(result.conflictPath, second)
      assert.deepEqual((await local.get(first.item.ref)).item, first.item)
    }
    const third = await signed({ ...first.item, content: { text: 'offline edit C' } })
    const conflict = await local.put(third)
    assertPreserved(conflict.conflictPath, third)
    assertPreserved((await local.put(second)).conflictPath, second)
  })

  it('treats a re-signature or unsigned metadata change as an idempotent write', async () => {
    await local.put(first)
    const resigned = { ...await signed(first.item), _inbound_counts: { replies_to: 2 } }
    assert.equal((await local.put(resigned)).ok, true)
    assert.deepEqual(await local.get(first.item.ref), first)
    assert.equal(existsSync(join(dir, 'bk')), false)
  })

  it('retains the original when the conflict archive cannot be written', async () => {
    await local.put(first)
    writeFileSync(join(dir, 'conflicts'), 'block archive directory')
    await assert.rejects(() => local.put(second))
    assert.deepEqual((await local.get(first.item.ref)).item, first.item)
  })

  it('accepts an explicit higher-revision resolution and retains the competing edit', async () => {
    await local.put(first)
    const rejected = await local.put(second)
    const merged = await signed({ ...first.item, revision: 2, content: { text: 'resolved A and B' } })
    assert.equal((await local.put(merged)).ok, true)
    assert.deepEqual((await local.get(first.item.ref)).item, merged.item)
    assertPreserved(rejected.conflictPath, second)
  })

  for (const method of ['get', 'search', 'inbound']) {
    it(`${method} reports equal-revision divergence without replacing either edit`, async () => {
      await local.put(first)
      const remote = remoteStore()
      const sync = createSyncStore({ local, remote })
      await assert.rejects(
        () => method === 'get' ? sync.get(first.item.ref) : method === 'search' ? sync.search() : sync.inbound('target'),
        error => {
          assert.equal(error.code, 'REVISION_CONFLICT')
          assert.equal(error.ref, first.item.ref)
          assertPreserved(error.conflictPath, second)
          return true
        },
      )
      assert.deepEqual((await local.get(first.item.ref)).item, first.item)
      assert.equal(remote.calls.filter(call => call.method === 'put').length, 0)
    })
  }

  it('detects conflicts even when the local version is outside the search filter', async () => {
    await local.put(first)
    second = await signed({ ...second.item, type: 'TASK' })
    const sync = createSyncStore({ local, remote: remoteStore() })
    await assert.rejects(() => sync.search({ type: 'TASK' }), { code: 'REVISION_CONFLICT' })
    assert.deepEqual((await local.get(first.item.ref)).item, first.item)
  })

  it('does not send a rejected local write to the remote', async () => {
    await local.put(first)
    const remote = remoteStore()
    const sync = createSyncStore({ local, remote })
    const result = await sync.put(second)
    assert.equal(result.ok, false)
    assertPreserved(result.conflictPath, second)
    assert.equal(remote.calls.filter(call => call.method === 'put').length, 0)
  })

  it('reports an upstream conflict as failure while keeping the local edit', async () => {
    const sync = createSyncStore({ local, remote: remoteStore() })
    const result = await sync.put(first)
    assert.equal(result.ok, false)
    assert.equal(result.status, 409)
    assert.equal(result._remoteOk, false)
    assert.deepEqual((await local.get(first.item.ref)).item, first.item)
  })

  it('counts returned HTTP conflicts as errors during bulk push', async () => {
    await local.put(first)
    const other = await signed({ ...buildItem({ pubkey: key.pubkey, in: ['dataverse001'] }), content: {} })
    await local.put(other)
    const remote = remoteStore()
    const reject = remote.put
    remote.put = obj => obj.item.ref === first.item.ref ? reject(obj) : { ok: true }
    const sync = createSyncStore({ local, remote })
    const progress = []
    const result = await sync.pushAll({ onProgress: info => progress.push(info) })
    assert.equal(result.pushed, 1)
    assert.equal(result.errors, 1)
    assert.equal(progress.find(info => info.ref === first.item.ref).status, 'error')
    assert.deepEqual((await local.get(first.item.ref)).item, first.item)
  })

  it('does not turn a thrown remote conflict into a successful offline write', async () => {
    const remote = remoteStore()
    remote.put = async () => { throw Object.assign(new Error('proxy conflict'), { status: 409 }) }
    const result = await createSyncStore({ local, remote }).put(first)
    assert.equal(result.ok, false)
    assert.equal(result.code, 'REVISION_CONFLICT')
    assert.equal(result._remoteOk, false)
    assert.deepEqual((await local.get(first.item.ref)).item, first.item)
  })

  it('stops create when the existing object has conflicting copies', async () => {
    await local.put(first)
    const remote = remoteStore()
    const client = createClient({ store: createSyncStore({ local, remote }),
      identity: { type: 'signer', signer: { pubkey: key.pubkey } } })
    await client.ready
    await assert.rejects(() => client.create(first.item, { allowUpdate: true }), { code: 'REVISION_CONFLICT' })
    assert.equal(remote.calls.filter(call => call.method === 'put').length, 0)
  })

  it('does not skip validation or cache absence when a TYPE has conflicting copies', async () => {
    first = await signed({ ...first.item, type: 'TYPE', content: { schema: { type: 'object' } } })
    second = await signed({ ...first.item, content: { schema: { type: 'object', required: ['content'] } } })
    await local.put(first)
    const client = createClient({ store: createSyncStore({ local, remote: remoteStore() }) })
    for (let i = 0; i < 2; i++) {
      await assert.rejects(() => client.validateType({ relations: { type_def: [{ ref: first.item.ref }] } }),
        { code: 'REVISION_CONFLICT' })
    }
  })

  for (const method of ['get', 'search', 'inbound']) {
    it(`${method} does not conceal a conflict reported by an upstream proxy`, async () => {
      await local.put(first)
      const remote = remoteStore()
      remote[method] = async () => { throw Object.assign(new Error('proxy conflict'), { status: 409, code: 'REVISION_CONFLICT' }) }
      const sync = createSyncStore({ local, remote })
      await assert.rejects(() => method === 'get' ? sync.get(first.item.ref) : method === 'search' ? sync.search() : sync.inbound('target'),
        { code: 'REVISION_CONFLICT' })
    })
  }

  it('does not mistake a projected BLOB list entry for a conflicting edit', async () => {
    first = await signed({ ...first.item, type: 'BLOB', content: { mime_type: 'text/plain', text: 'payload' } })
    await local.put(first)
    second = { ...first, item: { ...first.item, content: { mime_type: 'text/plain' } }, _inbound_counts: { replies_to: 2 } }
    const remote = remoteStore()
    const sync = createSyncStore({ local, remote })
    const result = await sync.search()
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0]._inbound_counts.replies_to, 2)
    assert.deepEqual((await local.get(first.item.ref)).item, first.item)
    assert.equal(remote.calls.length, 0, 'matching signed BLOB must not need a payload download')
  })

  it('fetches the full BLOB before comparing different signatures at the same revision', async () => {
    first = await signed({ ...first.item, type: 'BLOB', content: { mime_type: 'text/plain', text: 'A' } })
    const fullRemote = await signed({ ...first.item, content: { mime_type: 'text/plain', text: 'B' } })
    second = { ...fullRemote, item: { ...fullRemote.item, content: { mime_type: 'text/plain' } } }
    await local.put(first)
    const remote = remoteStore()
    remote.get = async () => fullRemote
    const sync = createSyncStore({ local, remote })
    await assert.rejects(() => sync.search(), error => {
      assert.equal(error.code, 'REVISION_CONFLICT')
      assertPreserved(error.conflictPath, fullRemote)
      return true
    })
  })
})
