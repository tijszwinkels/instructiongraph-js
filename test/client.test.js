import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createClient } from '../src/client.js'
import { createHubStore } from '../src/store/hub.js'
import { verify, sign, generateKeypair } from '../src/crypto.js'
import { buildItem } from '../src/object.js'

const HUB_URL = 'https://dataverse001.net'
const ROOT_REF = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.00000000-0000-0000-0000-000000000000'

/** Simple in-memory mock store for client tests */
function createMockStore(initial = {}) {
  const objects = new Map(Object.entries(initial))
  return {
    async get(ref) { return structuredClone(objects.get(ref) ?? null) },
    async put(obj) { objects.set(obj.item.ref, structuredClone(obj)); return { ok: true } },
    async search(q = {}) {
      const items = [...objects.values()].filter(o => {
        if (q.type && o.item.type !== q.type) return false
        if (q.by && o.item.pubkey !== q.by) return false
        return true
      })
      return { items, cursor: null }
    },
    async inbound() { return { items: [], cursor: null } }
  }
}

describe('client', () => {
  describe('read-only', () => {
    const ig = createClient({
      store: createHubStore({ url: HUB_URL })
    })

    it('get fetches object', async () => {
      const obj = await ig.get(ROOT_REF)
      assert.ok(obj)
      assert.equal(obj.item.type, 'ROOT')
    })

    it('search works', async () => {
      const result = await ig.search({ type: 'TYPE', limit: 3 })
      assert.ok(result.items.length > 0)
    })

    it('inbound works', async () => {
      const result = await ig.inbound(ROOT_REF, { limit: 3 })
      assert.ok(result.items.length > 0)
    })

    it('create throws without identity', async () => {
      await assert.rejects(
        () => ig.create({ type: 'POST', content: { title: 'test' } }),
        /No identity configured/
      )
    })
  })

  describe('with credentials identity', () => {
    const ig = createClient({
      store: createHubStore({ url: HUB_URL }),
      identity: { type: 'credentials', username: 'ig-js-test-user', password: 'ig-js-test-password-do-not-use' }
    })

    it('build creates unsigned item', async () => {
      // Need to wait for identity to resolve
      await ig.ready
      const item = ig.build({ type: 'TEST', content: { hello: 'world' } })
      assert.ok(item.id)
      assert.ok(item.pubkey)
      assert.equal(item.type, 'TEST')
      assert.deepEqual(item.in, [ig.pubkey], 'default realm should be pubkey (private)')
    })

    it('sign creates valid envelope', async () => {
      await ig.ready
      const item = ig.build({ type: 'TEST', content: { signed: true } })
      const envelope = await ig.sign(item)
      assert.equal(envelope.is, 'instructionGraph001')
      assert.ok(envelope.signature)

      const valid = await verify(envelope.item.pubkey, envelope.signature, envelope.item)
      assert.ok(valid, 'signature should verify')
    })
  })

  describe('TYPE validation', () => {
    it('rejects content that violates TYPE schema', async () => {
      // Mock store with a TYPE object containing a schema
      const typeRef = 'pk.type-id'
      const typeObj = {
        is: 'instructionGraph001', signature: 'sig',
        item: {
          id: 'type-id', pubkey: 'pk', ref: typeRef,
          type: 'TYPE',
          content: {
            schema: {
              type: 'object',
              required: ['content'],
              properties: {
                content: {
                  type: 'object',
                  required: ['title'],
                  properties: { title: { type: 'string' }, body: { type: 'string' } }
                }
              }
            }
          }
        }
      }

      const objects = new Map([[typeRef, typeObj]])
      const mockStore = {
        async get(ref) { return objects.get(ref) || null },
        async put(obj) { objects.set(obj.item.ref, obj); return { ok: true } },
        async search() { return { items: [], cursor: null } },
        async inbound() { return { items: [], cursor: null } }
      }

      const ig = createClient({
        store: mockStore,
        identity: { type: 'credentials', username: 'type-test', password: 'type-test-pw' }
      })
      await ig.ready

      // Should reject: missing required 'title'
      await assert.rejects(
        () => ig.create({
          type: 'POST',
          relations: { type_def: [{ ref: typeRef }] },
          content: { body: 'no title' }
        }),
        /title.*required/
      )

      // Should pass: has required 'title'
      const ref = await ig.create({
        type: 'POST',
        relations: { type_def: [{ ref: typeRef }] },
        content: { title: 'Hello' }
      })
      assert.ok(ref)
    })

    it('validates item-level required fields (not just content)', async () => {
      // Regression: validateType used to pass item.content instead of item to validateSchema,
      // so item-level required fields like 'instruction' were checked against content.
      const typeRef2 = 'pk.recipe-type'
      const recipeType = {
        is: 'instructionGraph001', signature: 'sig',
        item: {
          id: 'recipe-type', pubkey: 'pk', ref: typeRef2,
          type: 'TYPE',
          content: {
            schema: {
              type: 'object',
              required: ['instruction', 'content'],
              properties: {
                instruction: { type: 'string' },
                content: {
                  type: 'object',
                  required: ['name'],
                  properties: { name: { type: 'string' } }
                }
              }
            }
          }
        }
      }

      const objects = new Map([[typeRef2, recipeType]])
      const mockStore = {
        async get(ref) { return objects.get(ref) || null },
        async put(obj) { objects.set(obj.item.ref, obj); return { ok: true } },
        async search() { return { items: [], cursor: null } },
        async inbound() { return { items: [], cursor: null } }
      }

      const ig = createClient({
        store: mockStore,
        identity: { type: 'credentials', username: 'recipe-test', password: 'recipe-test-pw' }
      })
      await ig.ready

      // Should pass: item has instruction + content.name after build
      const ref2 = await ig.create({
        type: 'RECIPE',
        instruction: 'A recipe for testing',
        relations: { type_def: [{ ref: typeRef2 }] },
        content: { name: 'Test Recipe' }
      })
      assert.ok(ref2)

      // Should reject: missing instruction
      await assert.rejects(
        () => ig.create({
          type: 'RECIPE',
          relations: { type_def: [{ ref: typeRef2 }] },
          content: { name: 'No instruction' }
        }),
        /instruction.*required/
      )

      // Should reject: missing content.name
      await assert.rejects(
        () => ig.create({
          type: 'RECIPE',
          instruction: 'Has instruction',
          relations: { type_def: [{ ref: typeRef2 }] },
          content: {}
        }),
        /name.*required/
      )
    })
  })

  describe('deep merge in update()', () => {
    it('recursively merges nested content fields', async () => {
      const store = createMockStore()
      const ig = createClient({
        store,
        identity: { type: 'credentials', username: 'merge-test', password: 'merge-test-pw' }
      })
      await ig.ready

      // Create an object owned by this identity
      const ref = await ig.create({
        type: 'POST',
        content: { title: 'Original', meta: { author: 'Alice', version: 1 } }
      })

      // Patch only meta.version — meta.author should be preserved
      await ig.update(ref, { content: { meta: { version: 2 } } })
      const updated = await store.get(ref)
      assert.equal(updated.item.content.title, 'Original', 'title preserved')
      assert.equal(updated.item.content.meta.author, 'Alice', 'nested author preserved')
      assert.equal(updated.item.content.meta.version, 2, 'nested version updated')
      assert.equal(updated.item.revision, 1)
    })

    it('preserves immutable fields on update', async () => {
      const store = createMockStore()
      const ig = createClient({
        store,
        identity: { type: 'credentials', username: 'merge-test', password: 'merge-test-pw' }
      })
      await ig.ready

      const ref = await ig.create({ type: 'POST', content: { title: 'Original' } })
      const original = await store.get(ref)

      // Try to change immutable fields via patch — should be ignored
      await ig.update(ref, { id: 'hacked', pubkey: 'fake', created_at: '1999-01-01' })
      const updated = await store.get(ref)
      assert.equal(updated.item.id, original.item.id)
      assert.equal(updated.item.pubkey, ig.pubkey)
      assert.equal(updated.item.created_at, original.item.created_at)
    })
  })

  describe('createIdentity with PEM persistence', () => {
    it('generates keypair, publishes IDENTITY, saves PEM to disk', async () => {
      const tmpDir = join(tmpdir(), `ig-identity-test-${Date.now()}`)
      mkdirSync(tmpDir, { recursive: true })

      try {
        const store = createMockStore()
        const ig = createClient({ store })

        const result = await ig.createIdentity({ name: 'TestAgent', configDir: tmpDir })
        assert.ok(result.ref)
        assert.ok(result.pubkey)
        assert.ok(result.ok)
        assert.ok(result.pemPath)
        assert.ok(existsSync(result.pemPath), 'PEM file should exist')

        const pem = readFileSync(result.pemPath, 'utf-8')
        assert.ok(pem.includes('BEGIN PRIVATE KEY'))

        // Verify the published IDENTITY object
        const identityObj = await store.get(result.ref)
        assert.equal(identityObj.item.type, 'IDENTITY')
        assert.equal(identityObj.item.content.name, 'TestAgent')
        assert.equal(identityObj.item.id, '00000000-0000-0000-0000-000000000001')

        // Client should now use the new identity
        assert.equal(ig.pubkey, result.pubkey)
      } finally {
        rmSync(tmpDir, { recursive: true, force: true })
      }
    })
  })

  describe('with PEM identity', () => {
    it('loads PEM and signs', async () => {
      const pemPath = '/home/claude/projects/dataverse/.instructionGraph/identities/default/private.pem'
      if (!existsSync(pemPath)) {
        console.log('Skipping PEM client test — no local key')
        return
      }

      const ig = createClient({
        store: createHubStore({ url: HUB_URL }),
        identity: { type: 'pem', pem: readFileSync(pemPath, 'utf-8') }
      })
      await ig.ready

      const item = ig.build({ type: 'TEST', content: { from: 'pem' } })
      const envelope = await ig.sign(item)

      const valid = await verify(envelope.item.pubkey, envelope.signature, envelope.item)
      assert.ok(valid)
    })
  })
})
