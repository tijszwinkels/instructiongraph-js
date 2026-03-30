import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { canonicalJSON } from '../src/canonical.js'
import { createHubStore } from '../src/store/hub.js'

function createJsonServer(handler) {
  const server = http.createServer(async (req, res) => {
    try {
      await handler(req, res)
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: error.message }))
    }
  })

  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        server,
        url: `http://127.0.0.1:${address.port}`,
        async close() {
          await new Promise((done, fail) => server.close((error) => error ? fail(error) : done()))
        },
      })
    })
    server.on('error', reject)
  })
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

test('createHubStore get/put/search/inbound speak the hub HTTP API', async () => {
  const requests = []
  const fixture = {
    is: 'instructionGraph001',
    signature: 'sig',
    item: {
      id: '77777777-7777-4777-8777-777777777777',
      pubkey: 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ',
      ref: 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.77777777-7777-4777-8777-777777777777',
      in: ['dataverse001'],
      created_at: '2026-03-30T00:00:00Z',
      type: 'TEST',
      relations: {},
      content: { hello: 'world' },
    },
  }

  const hub = await createJsonServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    requests.push({
      method: req.method,
      pathname: url.pathname,
      search: url.search,
      authorization: req.headers.authorization,
      accept: req.headers.accept,
      body: await readBody(req),
    })

    if (req.method === 'GET' && url.pathname === `/${fixture.item.ref}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(fixture))
      return
    }

    if (req.method === 'GET' && url.pathname === '/missing') {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'object not found' }))
      return
    }

    if (req.method === 'PUT' && url.pathname === `/${fixture.item.ref}`) {
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(fixture))
      return
    }

    if (req.method === 'GET' && url.pathname === '/search') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ items: [fixture], cursor: 'next-cursor', has_more: true }))
      return
    }

    if (req.method === 'GET' && url.pathname === `/${fixture.item.ref}/inbound`) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ items: [fixture], cursor: null, has_more: false }))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  try {
    const store = createHubStore({ url: hub.url, token: 'secret-token' })

    assert.deepEqual(await store.get(fixture.item.ref), fixture)
    assert.equal(await store.get('missing'), null)

    assert.deepEqual(await store.put(fixture), {
      ok: true,
      status: 201,
      object: fixture,
    })

    assert.deepEqual(
      await store.search({ by: fixture.item.pubkey, type: 'TEST', limit: 5, cursor: 'abc', includeInboundCounts: true }),
      { items: [fixture], cursor: 'next-cursor', hasMore: true },
    )

    assert.deepEqual(
      await store.inbound(fixture.item.ref, {
        relation: 'author',
        from: fixture.item.pubkey,
        type: 'TEST',
        limit: 3,
        cursor: 'cur',
        includeInboundCounts: true,
      }),
      { items: [fixture], cursor: null, hasMore: false },
    )

    assert.equal(requests[0].accept, 'application/json')
    assert.equal(requests[0].authorization, 'Bearer secret-token')
    assert.equal(requests[2].body, canonicalJSON(fixture))
    assert.equal(
      requests[3].search,
      `?by=${fixture.item.pubkey}&type=TEST&limit=5&cursor=abc&include=inbound_counts`,
    )
    assert.equal(
      requests[4].search,
      `?relation=author&from=${fixture.item.pubkey}&type=TEST&limit=3&cursor=cur&include=inbound_counts`,
    )
  } finally {
    await hub.close()
  }
})

test('createHubStore authenticate stores bearer token and logout clears it', async () => {
  const authRequests = []
  const fixture = {
    is: 'instructionGraph001',
    signature: 'sig',
    item: {
      id: '88888888-8888-4888-8888-888888888888',
      pubkey: 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ',
      ref: 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.88888888-8888-4888-8888-888888888888',
      in: ['dataverse001'],
      created_at: '2026-03-30T00:00:00Z',
      type: 'TEST',
      relations: {},
      content: {},
    },
  }

  const hub = await createJsonServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    authRequests.push({
      method: req.method,
      pathname: url.pathname,
      authorization: req.headers.authorization,
      body: await readBody(req),
    })

    if (req.method === 'GET' && url.pathname === '/auth/challenge') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ challenge: 'abc123', expires_at: '2026-03-30T00:05:00Z' }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/auth/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ token: 'token-1', pubkey: fixture.item.pubkey, expires_at: '2026-03-31T00:00:00Z' }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/auth/logout') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok' }))
      return
    }

    if (req.method === 'GET' && url.pathname === `/${fixture.item.ref}`) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(fixture))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  try {
    const signedPayloads = []
    const store = createHubStore({ url: hub.url })
    const auth = await store.authenticate({
      pubkey: fixture.item.pubkey,
      async sign(data) {
        signedPayloads.push(new TextDecoder().decode(data))
        return 'signed-challenge'
      },
    })

    assert.deepEqual(auth, {
      token: 'token-1',
      pubkey: fixture.item.pubkey,
      expires_at: '2026-03-31T00:00:00Z',
    })
    assert.deepEqual(signedPayloads, ['abc123'])

    await store.get(fixture.item.ref)
    assert.equal(authRequests.at(-1).authorization, 'Bearer token-1')

    await store.logout()
    await store.get(fixture.item.ref)
    assert.equal(authRequests.at(-1).authorization, undefined)

    const tokenBody = JSON.parse(authRequests.find((entry) => entry.pathname === '/auth/token').body)
    assert.deepEqual(tokenBody, {
      pubkey: fixture.item.pubkey,
      challenge: 'abc123',
      signature: 'signed-challenge',
    })
  } finally {
    await hub.close()
  }
})

test('createHubStore can read live hub search and inbound endpoints', async () => {
  const pubkey = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ'
  const rootRef = `${pubkey}.00000000-0000-0000-0000-000000000000`
  const store = createHubStore({ url: 'https://dataverse001.net' })

  const root = await store.get(rootRef)
  assert.equal(root?.item?.ref, rootRef)
  assert.equal(root?.item?.content?.name, 'dataverse001')

  const search = await store.search({ by: pubkey, type: 'ROOT', limit: 5 })
  assert.ok(search.items.length >= 1)
  assert.equal(search.items[0].item.type, 'ROOT')

  const inbound = await store.inbound(rootRef, { relation: 'root', limit: 5 })
  assert.ok(inbound.items.length >= 1)
})
