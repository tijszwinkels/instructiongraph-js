import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'

import { verifyItemSignature, generateKeypair, signItem } from '../src/index.js'

const execFile = promisify(execFileCb)
const CLI_PATH = '/home/claude/projects/dataverse/instructiongraph-js/worktrees/initial-implementation-gpt-54/cli/ig.js'

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

test('ig verify exits 0 for valid signatures and 1 for invalid ones', async () => {
  const { privateKey, pubkey } = await generateKeypair()
  const signed = await signItem({
    id: '77777777-7777-4777-8777-777777777777',
    ref: `${pubkey}.77777777-7777-4777-8777-777777777777`,
    pubkey,
    in: ['dataverse001'],
    created_at: '2026-03-30T00:00:00Z',
    type: 'NOTE',
    relations: {},
    content: { text: 'hello' },
  }, privateKey)

  const dir = await mkdtemp(join(os.tmpdir(), 'ig-cli-verify-'))
  const validPath = join(dir, 'valid.json')
  const invalidPath = join(dir, 'invalid.json')
  await writeFile(validPath, JSON.stringify(signed), 'utf8')
  const invalid = structuredClone(signed)
  invalid.item.content.text = 'tampered'
  await writeFile(invalidPath, JSON.stringify(invalid), 'utf8')

  const valid = await execFile('node', [CLI_PATH, 'verify', validPath])
  assert.match(valid.stdout, /Verified OK/)

  await assert.rejects(
    execFile('node', [CLI_PATH, 'verify', invalidPath]),
    (error) => error.code === 1,
  )
})

test('ig get/search/sign/create/auth work against a configured local hub', { concurrency: false }, async () => {
  const projectDir = await mkdtemp(join(os.tmpdir(), 'ig-cli-project-'))
  const localBase = join(projectDir, '.instructionGraph')
  const requests = []
  const stored = new Map()
  const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    .export({ format: 'pem', type: 'pkcs8' }).toString()

  const hub = await createJsonServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const body = await readBody(req)
    requests.push({
      method: req.method,
      pathname: url.pathname,
      search: url.search,
      authorization: req.headers.authorization,
      body,
    })

    if (req.method === 'GET' && url.pathname === '/auth/challenge') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ challenge: 'challenge-123', expires_at: '2026-03-31T00:00:00Z' }))
      return
    }

    if (req.method === 'POST' && url.pathname === '/auth/token') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ token: 'secret-token', expires_at: '2026-04-01T00:00:00Z' }))
      return
    }

    if (req.method === 'GET' && url.pathname === '/search') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ items: [...stored.values()], cursor: null, has_more: false }))
      return
    }

    if (req.method === 'GET' && stored.has(url.pathname.slice(1))) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(stored.get(url.pathname.slice(1))))
      return
    }

    if (req.method === 'PUT') {
      const object = JSON.parse(body)
      stored.set(url.pathname.slice(1), object)
      res.writeHead(201, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(object))
      return
    }

    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'not found' }))
  })

  try {
    await mkdir(join(localBase, 'config'), { recursive: true })
    await mkdir(join(localBase, 'identities', 'default'), { recursive: true })
    await writeFile(join(localBase, 'config', 'hub-url'), `${hub.url}\n`)
    await writeFile(join(localBase, 'config', 'active-identity'), 'default\n')
    await writeFile(join(localBase, 'identities', 'default', 'private.pem'), pem)

    const specPath = join(projectDir, 'spec.json')
    await writeFile(specPath, JSON.stringify({ type: 'NOTE', content: { text: 'hi' } }), 'utf8')

    const signed = await execFile('node', [CLI_PATH, 'sign', specPath], { cwd: projectDir })
    const signedObject = JSON.parse(signed.stdout)
    assert.equal(await verifyItemSignature(signedObject), true)

    const created = await execFile('node', [CLI_PATH, 'create', specPath], { cwd: projectDir })
    const createdRef = created.stdout.trim()
    assert.ok(stored.has(createdRef))
    assert.equal(await verifyItemSignature(stored.get(createdRef)), true)

    const searched = await execFile('node', [CLI_PATH, 'search', '--type', 'NOTE', '--limit', '1'], { cwd: projectDir })
    const searchResult = JSON.parse(searched.stdout)
    assert.equal(searchResult.items.length, 1)

    const authed = await execFile('node', [CLI_PATH, 'auth'], { cwd: projectDir })
    assert.equal(JSON.parse(authed.stdout).token, 'secret-token')
    assert.equal((await readFile(join(localBase, 'config', 'hub-token'), 'utf8')).trim(), 'secret-token')

    const fetched = await execFile('node', [CLI_PATH, 'get', createdRef], { cwd: projectDir })
    assert.equal(JSON.parse(fetched.stdout).item.ref, createdRef)
    assert.equal(requests.at(-1).authorization, 'Bearer secret-token')
  } finally {
    await hub.close()
  }
})
