import { afterEach, beforeEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { generateKeyPairSync } from 'node:crypto'
import { importPEM } from '../src/identity.js'
import { sign } from '../src/crypto.js'
import { buildItem } from '../src/object.js'
import { createFsStore } from '../src/store/fs.js'
import { createHubStore } from '../src/store/hub.js'

const run = promisify(execFile)
const cli = join(import.meta.dirname, '..', 'cli', 'ig.js')

describe('CLI conflict reporting and recovery', () => {
  let dir, server, local, first, second, url
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ig-conflict-cli-'))
    mkdirSync(join(dir, 'config'))
    mkdirSync(join(dir, 'identities', 'default'), { recursive: true })
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1',
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    writeFileSync(join(dir, 'identities', 'default', 'private.pem'), privateKey)
    const kp = await importPEM(privateKey)
    const item = buildItem({ pubkey: kp.pubkey, in: ['dataverse001'], type: 'NOTE', revision: 1, content: { text: 'local' } })
    first = { is: 'instructionGraph001', item, signature: await sign(kp.privateKey, item) }
    const other = { ...item, content: { text: 'remote' } }
    second = { is: 'instructionGraph001', item: other, signature: await sign(kp.privateKey, other) }
    local = createFsStore({ dataDir: join(dir, 'data') })
    await local.put(first)
    server = createServer(async (req, res) => {
      for await (const chunk of req) { /* consume request */ }
      if (req.method === 'PUT') {
        res.writeHead(409, { 'Content-Type': 'application/problem+json' })
        res.end(JSON.stringify({ code: 'REVISION_CONFLICT', detail: 'existing revision 1 >= incoming 1' }))
      } else if (req.url === '/' + first.item.ref) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(second))
      } else { res.writeHead(404); res.end() }
    })
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${server.address().port}`
    writeFileSync(join(dir, 'config', 'hub-url'), url)
  })
  afterEach(async () => {
    await new Promise(resolve => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })
  const ig = (...args) => run(process.execPath, [cli, ...args], { env: { ...process.env, INSTRUCTIONGRAPH_DIR: dir } })

  it('preserves the hub conflict detail in the SDK result', async () => {
    const result = await createHubStore({ url }).put(first)
    assert.equal(result.code, 'REVISION_CONFLICT')
    assert.match(result.error, /existing revision 1/)
  })

  it('acknowledges a rejected retry when the hub already holds the same signed item', async () => {
    second = first
    const result = await createHubStore({ url }).put(first)
    assert.equal(result.ok, true)
  })

  it('exits unsuccessfully when bulk push contains rejected writes', async () => {
    await assert.rejects(() => ig('server', 'push', '--all'), error => {
      assert.equal(error.code, 1)
      assert.match(error.stdout, /0 pushed, 1 errors/)
      return true
    })
  })

  it('does not claim a rejected --no-push write was stored', async () => {
    const spec = join(dir, 'spec.json')
    writeFileSync(spec, JSON.stringify(second.item))
    await assert.rejects(() => ig('create', spec, '--update', '--no-push'), error => {
      assert.equal(error.code, 1)
      assert.match(error.stderr, /Revision conflict/)
      assert.doesNotMatch(error.stdout, /Stored locally/)
      return true
    })
    assert.deepEqual((await local.get(first.item.ref)).item, first.item)
  })

  it('allows both candidates to be read explicitly without syncing either', async () => {
    const a = JSON.parse((await ig('get', first.item.ref, '--local')).stdout)
    const b = JSON.parse((await ig('get', first.item.ref, '--remote')).stdout)
    assert.deepEqual(a.item, first.item)
    assert.deepEqual(b.item, second.item)
    assert.deepEqual((await local.get(first.item.ref)).item, first.item)
  })
})
