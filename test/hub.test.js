import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHubStore } from '../src/store/hub.js'
import { canonicalJSON } from '../src/canonical.js'

// ─── Helper: create a local HTTP server ──────────────────────────

function createMockHub(handler) {
  const server = http.createServer(async (req, res) => {
    try {
      await handler(req, res, new URL(req.url, 'http://127.0.0.1'))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    }
  })
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: `http://127.0.0.1:${port}`,
        async close() { await new Promise(r => server.close(r)) }
      })
    })
    server.on('error', reject)
  })
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

// ─── Fixture ─────────────────────────────────────────────────────

const FIXTURE = {
  is: 'instructionGraph001',
  signature: 'test-sig',
  item: {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    pubkey: 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ',
    ref: 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    in: ['dataverse001'],
    created_at: '2026-03-30T00:00:00Z',
    type: 'TEST',
    relations: {},
    content: { hello: 'world' }
  }
}

// ─── Tests ───────────────────────────────────────────────────────

describe('hub store (mock server)', () => {
  let hub
  const requests = []

  before(async () => {
    hub = await createMockHub(async (req, res, url) => {
      const body = await readBody(req)
      requests.push({
        method: req.method,
        path: url.pathname,
        search: url.search,
        auth: req.headers.authorization,
        body
      })

      // GET object (with ETag support)
      if (req.method === 'GET' && url.pathname === `/${FIXTURE.item.ref}`) {
        const etag = `"${FIXTURE.item.revision || 0}"`
        if (req.headers['if-none-match'] === etag) {
          res.writeHead(304)
          return res.end()
        }
        res.writeHead(200, { 'Content-Type': 'application/json', 'ETag': etag })
        return res.end(JSON.stringify(FIXTURE))
      }

      // GET 404
      if (req.method === 'GET' && url.pathname === '/missing') {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'not found' }))
      }

      // PUT
      if (req.method === 'PUT' && url.pathname === `/${FIXTURE.item.ref}`) {
        res.writeHead(201, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(FIXTURE))
      }

      // Search
      if (req.method === 'GET' && url.pathname === '/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ items: [FIXTURE], cursor: 'next', has_more: true }))
      }

      // Inbound
      if (req.method === 'GET' && url.pathname.endsWith('/inbound')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ items: [FIXTURE], cursor: null }))
      }

      // Auth challenge
      if (req.method === 'GET' && url.pathname === '/auth/challenge') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ challenge: 'test-challenge-123', expires_at: '2026-03-30T00:05:00Z' }))
      }

      // Auth token
      if (req.method === 'POST' && url.pathname === '/auth/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ token: 'granted-token', pubkey: 'pk', expires_at: '2026-04-01T00:00:00Z' }))
      }

      // Auth logout
      if (req.method === 'POST' && url.pathname === '/auth/logout') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: true }))
      }

      res.writeHead(404)
      res.end('{}')
    })
  })

  after(async () => { await hub.close() })

  it('get() fetches known object', async () => {
    const store = createHubStore({ url: hub.url })
    const obj = await store.get(FIXTURE.item.ref)
    assert.deepEqual(obj, FIXTURE)
  })

  it('get() returns null for 404', async () => {
    const store = createHubStore({ url: hub.url })
    assert.equal(await store.get('missing'), null)
  })

  it('put() sends canonical JSON with auth header', async () => {
    requests.length = 0
    const store = createHubStore({ url: hub.url, token: 'my-token' })
    const result = await store.put(FIXTURE)
    assert.ok(result.ok)
    assert.equal(result.status, 201)

    const putReq = requests.find(r => r.method === 'PUT')
    assert.equal(putReq.body, canonicalJSON(FIXTURE))
    assert.equal(putReq.auth, 'Bearer my-token')
  })

  it('search() passes query params', async () => {
    requests.length = 0
    const store = createHubStore({ url: hub.url })
    const result = await store.search({
      by: 'pk', type: 'TEST', limit: 5, cursor: 'c1', includeInboundCounts: true
    })
    assert.equal(result.items.length, 1)
    assert.equal(result.cursor, 'next')

    const searchReq = requests.find(r => r.path === '/search')
    assert.ok(searchReq.search.includes('by=pk'))
    assert.ok(searchReq.search.includes('type=TEST'))
    assert.ok(searchReq.search.includes('limit=5'))
    assert.ok(searchReq.search.includes('include=inbound_counts'))
  })

  it('inbound() passes query params', async () => {
    const store = createHubStore({ url: hub.url })
    const result = await store.inbound(FIXTURE.item.ref, {
      relation: 'author', type: 'COMMENT', limit: 3
    })
    assert.equal(result.items.length, 1)
  })

  it('authenticate() does challenge-response and sets token', async () => {
    requests.length = 0
    const store = createHubStore({ url: hub.url })
    const signedPayloads = []
    const mockSigner = {
      pubkey: 'test-pk',
      async sign(data) {
        signedPayloads.push(new TextDecoder().decode(data))
        return 'mock-sig'
      }
    }

    const result = await store.authenticate(mockSigner)
    assert.equal(result.token, 'granted-token')
    assert.deepEqual(signedPayloads, ['test-challenge-123'])

    // Token should now be set — next request should include it
    requests.length = 0
    await store.get(FIXTURE.item.ref)
    assert.equal(requests[0].auth, 'Bearer granted-token')
  })

  it('logout() clears the token', async () => {
    const store = createHubStore({ url: hub.url, token: 'initial-token' })
    await store.logout()

    requests.length = 0
    await store.get(FIXTURE.item.ref)
    assert.equal(requests[0].auth, undefined)
  })

  it('put() refuses local-realm objects (defense-in-depth)', async () => {
    requests.length = 0
    const store = createHubStore({ url: hub.url, token: 'my-token' })
    const localObj = {
      ...FIXTURE,
      item: { ...FIXTURE.item, in: ['local'] }
    }
    const result = await store.put(localObj)
    assert.ok(!result.ok, 'should refuse')
    assert.match(result.error, /local-realm/)
    // No PUT request should have been made
    const putReqs = requests.filter(r => r.method === 'PUT')
    assert.equal(putReqs.length, 0, 'should not send any request to hub')
  })

  it('put() refuses mixed local+public realm objects', async () => {
    requests.length = 0
    const store = createHubStore({ url: hub.url })
    const mixedObj = {
      ...FIXTURE,
      item: { ...FIXTURE.item, in: ['local', 'dataverse001'] }
    }
    const result = await store.put(mixedObj)
    assert.ok(!result.ok, 'should refuse mixed local+public')
    const putReqs = requests.filter(r => r.method === 'PUT')
    assert.equal(putReqs.length, 0)
  })

  it('search() preserves path prefix in base URL', async () => {
    requests.length = 0
    // Use hub.url + '/subpath' to simulate a reverse-proxy mount
    const store = createHubStore({ url: hub.url + '/subpath' })
    // This should hit /subpath/search, not /search
    await store.search({ type: 'TEST' }).catch(() => {})
    const searchReq = requests.find(r => r.path.includes('search'))
    assert.ok(searchReq, 'should have made a search request')
    assert.ok(searchReq.path.startsWith('/subpath/search'), `expected /subpath/search but got ${searchReq.path}`)
  })

  it('inbound() preserves path prefix in base URL', async () => {
    requests.length = 0
    const store = createHubStore({ url: hub.url + '/subpath' })
    await store.inbound('pk.1', {}).catch(() => {})
    const inboundReq = requests.find(r => r.path.includes('inbound'))
    assert.ok(inboundReq, 'should have made an inbound request')
    assert.ok(inboundReq.path.startsWith('/subpath/pk.1/inbound'), `expected /subpath/pk.1/inbound but got ${inboundReq.path}`)
  })

  it('handles unreachable server gracefully', async () => {
    const store = createHubStore({ url: 'http://127.0.0.1:1' }) // nothing on port 1
    // get, search, and inbound throw on network error (sync store catches and falls back)
    await assert.rejects(() => store.get('any.ref'), /fetch failed|ECONNREFUSED/)
    const putResult = await store.put(FIXTURE)
    assert.ok(!putResult.ok)
    await assert.rejects(() => store.search({ type: 'TEST' }), /fetch failed|ECONNREFUSED/)
    await assert.rejects(() => store.inbound('any.ref', {}), /fetch failed|ECONNREFUSED/)
  })

  it('get() with localRevision sends If-None-Match and returns _notModified on 304', async () => {
    requests.length = 0
    const store = createHubStore({ url: hub.url })
    const result = await store.get(FIXTURE.item.ref, { localRevision: FIXTURE.item.revision || 0 })
    assert.deepEqual(result, { _notModified: true })
    const getReq = requests.find(r => r.method === 'GET' && r.path === `/${FIXTURE.item.ref}`)
    assert.ok(getReq, 'should have made a GET request')
  })

  it('get() with wrong localRevision returns full object', async () => {
    const store = createHubStore({ url: hub.url })
    const result = await store.get(FIXTURE.item.ref, { localRevision: 999 })
    assert.deepEqual(result, FIXTURE)
  })

  it('get() without localRevision returns full object (no If-None-Match)', async () => {
    requests.length = 0
    const store = createHubStore({ url: hub.url })
    const result = await store.get(FIXTURE.item.ref)
    assert.deepEqual(result, FIXTURE)
    const getReq = requests.find(r => r.method === 'GET')
    assert.equal(getReq.search, '', 'should not have query params')
  })
})

describe('hub store (live smoke test)', () => {
  const store = createHubStore({ url: 'https://dataverse001.net' })
  const ROOT_REF = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.00000000-0000-0000-0000-000000000000'

  it('reads the root node from the live hub', async () => {
    const obj = await store.get(ROOT_REF)
    assert.ok(obj)
    assert.equal(obj.item.type, 'ROOT')
  })
})
