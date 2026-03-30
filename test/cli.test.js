/**
 * CLI integration tests.
 * Spins up a mock hub server, configures a temp .instructionGraph dir,
 * and exercises all ig CLI commands.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { verify } from '../src/crypto.js'

const execFile = promisify(execFileCb)
const CLI = join(import.meta.dirname, '..', 'cli', 'ig.js')

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

describe('CLI', () => {
  let hub, projectDir, stored

  before(async () => {
    stored = new Map()

    // Mock hub server
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const body = await readBody(req)

      if (req.method === 'GET' && url.pathname === '/auth/challenge') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ challenge: 'cli-challenge', expires_at: '2026-04-01T00:00:00Z' }))
      }
      if (req.method === 'POST' && url.pathname === '/auth/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ token: 'cli-token', expires_at: '2026-04-02T00:00:00Z' }))
      }
      if (req.method === 'GET' && url.pathname === '/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ items: [...stored.values()], cursor: null }))
      }
      if (req.method === 'GET' && stored.has(url.pathname.slice(1))) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(stored.get(url.pathname.slice(1))))
      }
      if (req.method === 'PUT') {
        const obj = JSON.parse(body)
        stored.set(url.pathname.slice(1), obj)
        res.writeHead(201, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(obj))
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    })

    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve())
      server.on('error', reject)
    })
    const { port } = server.address()
    hub = {
      url: `http://127.0.0.1:${port}`,
      server,
      async close() { await new Promise(r => server.close(r)) }
    }

    // Set up project dir with .instructionGraph config + identity
    projectDir = await mkdtemp(join(tmpdir(), 'ig-cli-test-'))
    const igDir = join(projectDir, '.instructionGraph')
    await mkdir(join(igDir, 'config'), { recursive: true })
    await mkdir(join(igDir, 'identities', 'default'), { recursive: true })
    await writeFile(join(igDir, 'config', 'hub-url'), hub.url)
    await writeFile(join(igDir, 'config', 'active-identity'), 'default')

    const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
      .privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    await writeFile(join(igDir, 'identities', 'default', 'private.pem'), pem)
  })

  after(async () => { await hub.close() })

  function ig(...args) {
    return execFile('node', [CLI, ...args], {
      cwd: projectDir,
      env: { ...process.env, INSTRUCTIONGRAPH_DIR: join(projectDir, '.instructionGraph') }
    })
  }

  it('ig verify: accepts valid signature, rejects tampered', async () => {
    // Create a signed object via ig sign
    const specPath = join(projectDir, 'test-spec.json')
    await writeFile(specPath, JSON.stringify({ type: 'NOTE', content: { text: 'verify-test' } }))

    const { stdout: signedJson } = await ig('sign', specPath)
    const signed = JSON.parse(signedJson)
    const validPath = join(projectDir, 'valid.json')
    await writeFile(validPath, JSON.stringify(signed))

    const { stdout } = await ig('verify', validPath)
    assert.match(stdout, /Verified OK/)

    // Tamper and verify it fails
    signed.item.content.text = 'tampered'
    const tamperedPath = join(projectDir, 'tampered.json')
    await writeFile(tamperedPath, JSON.stringify(signed))

    await assert.rejects(
      ig('verify', tamperedPath),
      err => err.code === 1
    )
  })

  it('ig create: signs and publishes to hub', async () => {
    const specPath = join(projectDir, 'create-spec.json')
    await writeFile(specPath, JSON.stringify({ type: 'POST', content: { title: 'CLI Post' } }))

    const { stdout } = await ig('create', specPath)
    const ref = stdout.trim()
    assert.ok(ref.includes('.'), 'should return a ref')
    assert.ok(stored.has(ref), 'should be stored on hub')

    const obj = stored.get(ref)
    assert.equal(obj.item.type, 'POST')
    assert.equal(obj.item.content.title, 'CLI Post')

    const valid = await verify(obj.item.pubkey, obj.signature, obj.item)
    assert.ok(valid, 'published object should have valid signature')
  })

  it('ig get: fetches from hub', async () => {
    // Use the object created above
    const ref = [...stored.keys()][0]
    const { stdout } = await ig('get', ref)
    const obj = JSON.parse(stdout)
    assert.equal(obj.item.ref, ref)
  })

  it('ig search: lists objects', async () => {
    const { stdout } = await ig('search', '--type', 'POST')
    // search output is one-line-per-result format
    assert.ok(stdout.includes('POST'))
  })

  it('ig --help: shows InstructionGraph description and base commands', async () => {
    const { stdout } = await ig('--help')
    assert.match(stdout, /InstructionGraph/i)
    assert.match(stdout, /novel, self-describing graph data format/i)
    assert.match(stdout, /data, concepts, and applications between LLMs/i)
    assert.match(stdout, /https:\/\/dataverse001\.net\/AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ\.b3f5a7c9-2d4e-4f60-9b8a-0c1d2e3f4a5b/)
    assert.match(stdout, /ig get <ref>/)
    assert.match(stdout, /ig realm\s+Show current default realm/)
    assert.match(stdout, /ig realm set <realm>/)
  })

  it('base commands support --help', async () => {
    const commands = [
      ['get'],
      ['search'],
      ['inbound'],
      ['verify'],
      ['sign'],
      ['create'],
      ['auth'],
      ['identity'],
      ['realm']
    ]

    for (const command of commands) {
      const { stdout } = await ig(...command, '--help')
      assert.match(stdout, /Usage:/)
    }
  })

  it('ig identity: shows current identity name and pubkey', async () => {
    const { stdout } = await ig('identity')
    assert.match(stdout, /Identity: default/)
    assert.match(stdout, /Pubkey:/)
  })

  describe('ig identity generate', () => {
    it('generates a new identity with default name', async () => {
      const { stdout } = await ig('identity', 'generate', '--name', 'test-new')
      assert.match(stdout, /Generated identity: test-new/)
      assert.match(stdout, /Pubkey:/)
      assert.match(stdout, /PEM saved/)
    })

    it('generates identity with custom name and usable PEM', async () => {
      const { stdout } = await ig('identity', 'generate', '--name', 'work')
      assert.match(stdout, /Generated identity: work/)
      // PEM file should exist
      const pemPath = join(projectDir, '.instructionGraph', 'identities', 'work', 'private.pem')
      await access(pemPath) // throws if not found
      const pem = await readFile(pemPath, 'utf-8')
      assert.match(pem, /-----BEGIN PRIVATE KEY-----/)

      // Verify the PEM is usable: switch to it and sign something
      await writeFile(join(projectDir, '.instructionGraph', 'config', 'active-identity'), 'work')
      const specPath = join(projectDir, 'pem-test-spec.json')
      await writeFile(specPath, JSON.stringify({ type: 'NOTE', content: { text: 'signed with generated key' } }))
      const { stdout: signedJson } = await ig('sign', specPath)
      const signed = JSON.parse(signedJson)
      const valid = await verify(signed.item.pubkey, signed.signature, signed.item)
      assert.ok(valid, 'generated PEM should produce valid signatures')

      // Restore original identity
      await writeFile(join(projectDir, '.instructionGraph', 'config', 'active-identity'), 'default')
    })

    it('sets new identity as active with --activate', async () => {
      const { stdout } = await ig('identity', 'generate', '--name', 'activated', '--activate')
      assert.match(stdout, /Set as active identity/)
      // Check config file
      const activeIdentity = await readFile(
        join(projectDir, '.instructionGraph', 'config', 'active-identity'), 'utf-8'
      )
      assert.equal(activeIdentity.trim(), 'activated')
    })

    it('refuses to overwrite existing identity', async () => {
      // 'work' was created above
      await assert.rejects(
        ig('identity', 'generate', '--name', 'work'),
        err => err.stderr.includes('already exists')
      )
    })

    it('generates identity with --local flag in cwd', async () => {
      const localDir = await mkdtemp(join(tmpdir(), 'ig-local-test-'))
      function igLocal(...a) {
        const env = { ...process.env }
        delete env.INSTRUCTIONGRAPH_DIR
        return execFile('node', [CLI, ...a], { cwd: localDir, env })
      }

      const { stdout } = await igLocal('identity', 'generate', '--name', 'local-id', '--local')
      assert.match(stdout, /Initialized InstructionGraph/)
      assert.match(stdout, /Generated identity: local-id/)

      // Verify directory structure was bootstrapped
      await access(join(localDir, '.instructionGraph', 'data'))
      await access(join(localDir, '.instructionGraph', 'config'))
      await access(join(localDir, '.instructionGraph', 'identities', 'local-id', 'private.pem'))

      // First identity should be auto-activated
      const active = await readFile(
        join(localDir, '.instructionGraph', 'config', 'active-identity'), 'utf-8'
      )
      assert.equal(active.trim(), 'local-id')

      await rm(localDir, { recursive: true })
    })
  })

  describe('ig identity activate', () => {
    it('activates an existing identity', async () => {
      await ig('identity', 'generate', '--name', 'ops')
      const { stdout } = await ig('identity', 'activate', 'ops')
      assert.match(stdout, /Activated identity: ops/)
      const activeIdentity = await readFile(
        join(projectDir, '.instructionGraph', 'config', 'active-identity'), 'utf-8'
      )
      assert.equal(activeIdentity.trim(), 'ops')
    })

    it('fails if the identity does not exist', async () => {
      await assert.rejects(
        ig('identity', 'activate', 'missing'),
        err => err.stderr.includes('not found')
      )
    })
  })

  describe('ig identity list', () => {
    it('lists identities and marks the active one', async () => {
      await ig('identity', 'generate', '--name', 'list-a')
      await ig('identity', 'generate', '--name', 'list-b')
      await ig('identity', 'activate', 'list-b')

      const { stdout } = await ig('identity', 'list')
      assert.match(stdout, /^\s*default$/m)
      assert.match(stdout, /^\s*list-a$/m)
      assert.match(stdout, /^\* list-b$/m)
    })
  })

  describe('ig realm', () => {
    it('shows pubkey realm by default when no default-realm config is set', async () => {
      await rm(join(projectDir, '.instructionGraph', 'config', 'default-realm'), { force: true })
      const { stdout } = await ig('realm')
      assert.match(stdout, /Current realm: .* \(pubkey realm default\)/)
      assert.doesNotMatch(stdout, /^Current realm: dataverse001$/m)
    })

    it('sets and shows the configured default realm', async () => {
      const { stdout: setOut } = await ig('realm', 'set', 'dataverse001')
      assert.match(setOut, /Set default realm: dataverse001/)

      const configRealm = await readFile(join(projectDir, '.instructionGraph', 'config', 'default-realm'), 'utf-8')
      assert.equal(configRealm.trim(), 'dataverse001')

      const { stdout } = await ig('realm')
      assert.match(stdout, /^Current realm: dataverse001$/m)
    })

    it('uses configured default realm when signing new objects', async () => {
      await ig('realm', 'set', 'dataverse001')
      const specPath = join(projectDir, 'realm-test-spec.json')
      await writeFile(specPath, JSON.stringify({ type: 'NOTE', content: { text: 'realm-test' } }))
      const { stdout: signedJson } = await ig('sign', specPath)
      const signed = JSON.parse(signedJson)
      assert.deepEqual(signed.item.in, ['dataverse001'])
    })
  })
})
