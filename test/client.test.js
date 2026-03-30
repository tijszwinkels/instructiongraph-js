import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '../src/client.js'
import { createHubStore } from '../src/store/hub.js'
import { verify } from '../src/crypto.js'

const HUB_URL = 'https://dataverse001.net'
const ROOT_REF = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.00000000-0000-0000-0000-000000000000'

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

  describe('with PEM identity', () => {
    it('loads PEM and signs', async () => {
      const { readFileSync, existsSync } = await import('node:fs')
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
