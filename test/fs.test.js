import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFsStore } from '../src/store/fs.js'
import { canonicalJSON } from '../src/canonical.js'
import { generateKeypair, sign } from '../src/crypto.js'
import { buildItem } from '../src/object.js'

describe('fs store', () => {
  let dataDir
  let store

  beforeEach(() => {
    dataDir = join(tmpdir(), `ig-fs-test-${Date.now()}`)
    mkdirSync(dataDir, { recursive: true })
    store = createFsStore({ dataDir })
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
  })

  async function makeSignedObj(overrides = {}) {
    const kp = await generateKeypair()
    const item = buildItem({
      pubkey: kp.pubkey,
      type: 'TEST',
      content: { title: 'Test' },
      ...overrides
    })
    const signature = await sign(kp.privateKey, item)
    return { is: 'instructionGraph001', signature, item }
  }

  it('put + get round-trip', async () => {
    const obj = await makeSignedObj()
    const result = await store.put(obj)
    assert.ok(result.ok, 'put should succeed')

    const fetched = await store.get(obj.item.ref)
    assert.ok(fetched, 'should find stored object')
    assert.equal(fetched.item.id, obj.item.id)
    assert.equal(fetched.item.type, 'TEST')
  })

  it('stores as canonical JSON with correct filename', async () => {
    const obj = await makeSignedObj()
    await store.put(obj)

    const filepath = join(dataDir, `${obj.item.ref}.json`)
    assert.ok(existsSync(filepath), 'file should exist')

    const raw = readFileSync(filepath, 'utf-8')
    assert.equal(raw, canonicalJSON(obj), 'should be canonical JSON')
  })

  it('sets mtime to object timestamp', async () => {
    const obj = await makeSignedObj()
    await store.put(obj)

    const filepath = join(dataDir, `${obj.item.ref}.json`)
    const stat = statSync(filepath)
    const expectedTime = new Date(obj.item.updated_at || obj.item.created_at).getTime()
    // Allow 1 second tolerance for filesystem precision
    assert.ok(
      Math.abs(stat.mtimeMs - expectedTime) < 1000,
      `mtime should match object timestamp (diff: ${Math.abs(stat.mtimeMs - expectedTime)}ms)`
    )
  })

  it('get returns null for missing object', async () => {
    const result = await store.get('nonexistent.00000000-0000-0000-0000-000000000000')
    assert.equal(result, null)
  })

  it('backs up old revisions', async () => {
    const kp = await generateKeypair()
    const item1 = buildItem({ pubkey: kp.pubkey, type: 'TEST', content: { v: 1 }, id: 'same-id' })
    const sig1 = await sign(kp.privateKey, item1)
    const obj1 = { is: 'instructionGraph001', signature: sig1, item: item1 }
    await store.put(obj1)

    // Update with higher revision
    const item2 = { ...item1, content: { v: 2 }, revision: 1, updated_at: new Date().toISOString() }
    const sig2 = await sign(kp.privateKey, item2)
    const obj2 = { is: 'instructionGraph001', signature: sig2, item: item2 }
    await store.put(obj2)

    // Check backup exists
    const bkDir = join(dataDir, 'bk')
    assert.ok(existsSync(bkDir), 'bk directory should exist')

    // Current file should be v2
    const current = await store.get(item1.ref)
    assert.equal(current.item.content.v, 2)
  })

  it('rejects lower revision', async () => {
    const kp = await generateKeypair()
    const item1 = { ...buildItem({ pubkey: kp.pubkey, type: 'TEST', content: {}, id: 'rev-test' }), revision: 5 }
    const sig1 = await sign(kp.privateKey, item1)
    await store.put({ is: 'instructionGraph001', signature: sig1, item: item1 })

    const item2 = { ...item1, revision: 3 }
    const sig2 = await sign(kp.privateKey, item2)
    const result = await store.put({ is: 'instructionGraph001', signature: sig2, item: item2 })
    assert.ok(!result.ok, 'should reject lower revision')
  })

  it('search returns items from filesystem', async () => {
    const obj1 = await makeSignedObj()
    const obj2 = await makeSignedObj()
    await store.put(obj1)
    await store.put(obj2)

    const result = await store.search({ type: 'TEST' })
    assert.equal(result.items.length, 2)
  })

  it('search filters by type', async () => {
    const kp = await generateKeypair()
    const post = buildItem({ pubkey: kp.pubkey, type: 'POST', content: {} })
    const sigP = await sign(kp.privateKey, post)
    await store.put({ is: 'instructionGraph001', signature: sigP, item: post })

    const comment = buildItem({ pubkey: kp.pubkey, type: 'COMMENT', content: {} })
    const sigC = await sign(kp.privateKey, comment)
    await store.put({ is: 'instructionGraph001', signature: sigC, item: comment })

    const posts = await store.search({ type: 'POST' })
    assert.equal(posts.items.length, 1)
    assert.equal(posts.items[0].item.type, 'POST')
  })

  it('search filters by pubkey', async () => {
    const obj1 = await makeSignedObj()
    const obj2 = await makeSignedObj() // different keypair
    await store.put(obj1)
    await store.put(obj2)

    const result = await store.search({ by: obj1.item.pubkey })
    assert.equal(result.items.length, 1)
    assert.equal(result.items[0].item.pubkey, obj1.item.pubkey)
  })
})
