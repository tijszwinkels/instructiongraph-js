/**
 * CLI integration tests for the write verbs: new, edit, commit, validate,
 * set, relate, unrelate. Mirrors test/cli.test.js: mock hub + temp
 * .instructionGraph dir, exercising exit codes and the stdout/stderr contract.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, access, rm, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const execFile = promisify(execFileCb)
const CLI = join(import.meta.dirname, '..', 'cli', 'ig.js')

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf-8')
}

describe('write verbs', () => {
  let hub, projectDir, stored, typeRef, noSchemaRef

  before(async () => {
    stored = new Map()

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const body = await readBody(req)
      if (req.method === 'GET' && url.pathname === '/auth/challenge') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ challenge: 'wv-challenge', expires_at: '2099-01-01T00:00:00Z' }))
      }
      if (req.method === 'POST' && url.pathname === '/auth/token') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ token: 'wv-token', expires_at: '2099-01-02T00:00:00Z' }))
      }
      if (req.method === 'GET' && url.pathname === '/search') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ items: [...stored.values()], cursor: null }))
      }
      if (req.method === 'GET' && url.pathname.endsWith('/inbound')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ items: [], cursor: null }))
      }
      if (req.method === 'GET' && stored.has(url.pathname.slice(1))) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(stored.get(url.pathname.slice(1))))
      }
      if (req.method === 'PUT') {
        const obj = JSON.parse(body)
        // A test hook to force a hub push failure (for exit-4 coverage).
        if (obj.item?.content?.failpush) {
          res.writeHead(500, { 'Content-Type': 'application/json' })
          return res.end(JSON.stringify({ error: 'forced push failure' }))
        }
        stored.set(url.pathname.slice(1), obj)
        res.writeHead(201, { 'Content-Type': 'application/json' })
        return res.end(body)
      }
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    })
    await new Promise((resolve, reject) => {
      server.listen(0, '127.0.0.1', () => resolve())
      server.on('error', reject)
    })
    const { port } = server.address()
    hub = { url: `http://127.0.0.1:${port}`, async close() { await new Promise(r => server.close(r)) } }

    projectDir = await mkdtemp(join(tmpdir(), 'ig-wv-test-'))
    const igDir = join(projectDir, '.instructionGraph')
    await mkdir(join(igDir, 'config'), { recursive: true })
    await mkdir(join(igDir, 'data'), { recursive: true }) // local store present → sync mode (as after `ig identity generate`)
    await mkdir(join(igDir, 'identities', 'default'), { recursive: true })
    await mkdir(join(igDir, 'identities', 'alt'), { recursive: true })
    await writeFile(join(igDir, 'config', 'hub-url'), hub.url)
    await writeFile(join(igDir, 'config', 'active-identity'), 'default')
    await writeFile(join(igDir, 'config', 'default-realm'), 'dataverse001')
    for (const name of ['default', 'alt']) {
      const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
        .privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
      await writeFile(join(igDir, 'identities', name, 'private.pem'), pem)
    }

    // A TYPE object with a schema (for `ig new` scaffolding + commit validation)
    const typeSpec = join(projectDir, 'type-spec.json')
    await writeFile(typeSpec, JSON.stringify({
      type: 'TYPE', in: ['dataverse001'], name: 'NOTE type',
      content: {
        name: 'NOTE',
        // Item-level schema: validated against the whole item; content lives under properties.content.
        schema: { type: 'object', properties: {
          content: { type: 'object', required: ['text', 'count'], properties: {
            text: { type: 'string', description: 'the note body' },
            count: { type: 'integer' },
            tags: { type: 'array', items: { type: 'string', description: 'a tag' } }
          } }
        } }
      }
    }))
    const { stdout: t } = await ig('create', typeSpec)
    typeRef = t.trim().split('\n').pop()

    // A TYPE-shaped object without a schema
    const noSchemaSpec = join(projectDir, 'noschema-spec.json')
    await writeFile(noSchemaSpec, JSON.stringify({ type: 'TYPE', in: ['dataverse001'], content: { name: 'FREEFORM' } }))
    const { stdout: n } = await ig('create', noSchemaSpec)
    noSchemaRef = n.trim().split('\n').pop()
  })

  after(async () => {
    await hub.close()
    await rm(projectDir, { recursive: true, force: true })
  })

  function ig(...args) {
    return execFile('node', [CLI, ...args], {
      cwd: projectDir,
      env: { ...process.env, INSTRUCTIONGRAPH_DIR: join(projectDir, '.instructionGraph') }
    })
  }
  /** Run ig expecting a non-zero exit; resolves with the error (code, stdout, stderr). */
  async function igFail(...args) {
    try { await ig(...args); throw new Error('expected non-zero exit') }
    catch (e) { if (e.code === undefined) throw e; return e }
  }

  // ─── ig new ──────────────────────────────────────────────────────

  describe('ig new', () => {
    it('scaffolds a draft with schema-required props, type_def + root relations', async () => {
      const { stdout } = await ig('new', typeRef)
      const path = stdout.trim()
      assert.ok(path.endsWith('.json'), 'stdout is the draft path')
      const draft = JSON.parse(await readFile(join(projectDir, path), 'utf-8'))
      assert.equal(draft.type, 'NOTE')
      assert.equal(draft.content.text, '<string: the note body>')
      assert.equal(draft.content.count, 0)
      assert.deepEqual(draft.content.tags, ['<string: a tag>'])
      assert.equal(draft.relations.type_def[0].ref, typeRef)
      assert.ok(draft.relations.root[0].ref, 'has a root relation')
      assert.equal(draft._draft.mode, 'new')
      assert.equal(draft._draft.type_ref, typeRef)
    })

    it('records identity/realm from flags in _draft', async () => {
      const { stdout } = await ig('new', typeRef, '--identity', 'alt', '--realm', 'dataverse001')
      const draft = JSON.parse(await readFile(join(projectDir, stdout.trim()), 'utf-8'))
      assert.equal(draft._draft.identity, 'alt')
      assert.equal(draft._draft.realm, 'dataverse001')
    })

    it('never overwrites an existing draft (suffixes the name)', async () => {
      const out = join(projectDir, 'fixed-draft.json')
      const { stdout: a } = await ig('new', typeRef, '--out', out)
      const { stdout: b } = await ig('new', typeRef, '--out', out)
      assert.notEqual(a.trim(), b.trim())
      assert.ok(existsSync(a.trim()) && existsSync(b.trim()))
    })

    it('a TYPE without a schema still scaffolds, with a stderr notice', async () => {
      const { stdout, stderr } = await ig('new', noSchemaRef)
      const draft = JSON.parse(await readFile(join(projectDir, stdout.trim()), 'utf-8'))
      assert.deepEqual(draft.content, {})
      assert.match(stderr, /no schema/i)
    })

    it('errors on a missing TYPE ref', async () => {
      const missing = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.99999999-9999-9999-9999-999999999999'
      const e = await igFail('new', missing)
      assert.equal(e.code, 1)
      assert.match(e.stderr, /error:/)
    })

    it('missing type-ref is a usage error (exit 2)', async () => {
      const e = await igFail('new')
      assert.equal(e.code, 2)
    })
  })

  // Helpers for the verbs that operate on existing objects.
  let draftSeq = 0
  async function writeDraft(obj) {
    const p = join(projectDir, `draft-${draftSeq++}.json`)
    await writeFile(p, JSON.stringify(obj))
    return p
  }
  /** Create a public object owned by the default identity; returns its ref. */
  async function createObj(spec) {
    const p = join(projectDir, `base-${draftSeq++}.json`)
    await writeFile(p, JSON.stringify({ in: ['dataverse001'], ...spec }))
    const { stdout } = await ig('create', p)
    return stdout.trim().split('\n').pop()
  }
  const localItem = async (ref) => JSON.parse(await readFile(join(projectDir, '.instructionGraph', 'data', `${ref}.json`), 'utf-8')).item

  // ─── ig edit ─────────────────────────────────────────────────────

  describe('ig edit', () => {
    it('checks out the latest revision with base_revision recorded', async () => {
      const ref = await createObj({ type: 'POST', name: 'orig', content: { title: 'a' } })
      const { stdout } = await ig('edit', ref)
      const draft = JSON.parse(await readFile(join(projectDir, stdout.trim()), 'utf-8'))
      assert.equal(draft._draft.mode, 'checkout')
      assert.equal(draft._draft.base_ref, ref)
      assert.equal(draft._draft.base_revision, 0)
      assert.equal(draft.content.title, 'a')
      assert.ok(!('pubkey' in draft) && !('ref' in draft), 'signature-managed fields stripped')
    })

    it('refuses an object owned by someone else', async () => {
      const altP = join(projectDir, 'alt-obj.json')
      await writeFile(altP, JSON.stringify({ type: 'POST', in: ['dataverse001'], content: { title: 'alt' } }))
      const { stdout } = await ig('create', altP, '--identity', 'alt')
      const altRef = stdout.trim().split('\n').pop()
      const e = await igFail('edit', altRef)
      assert.equal(e.code, 1)
      assert.match(e.stderr, /can only edit your own objects/)
    })
  })

  // ─── ig commit ───────────────────────────────────────────────────

  describe('ig commit', () => {
    it('creates a new object from a scaffold and consumes the drafts/ file', async () => {
      const { stdout: p } = await ig('new', typeRef, '--out', join(projectDir, 'drafts', 'note.json'))
      const draftPath = p.trim()
      const { stdout, stderr } = await ig('commit', draftPath)
      assert.match(stdout.trim(), /^committed \S+ rev 0 \(pushed\)$/)
      assert.equal(stdout.trim().split('\n').length, 1, 'stdout is exactly the committed line')
      const ref = stdout.trim().split(' ')[1]
      assert.ok(stored.has(ref), 'pushed to hub')
      assert.ok(!('_draft' in stored.get(ref).item), '_draft never appears in the signed item')
      assert.ok(!existsSync(draftPath), 'consumed draft under drafts/ is deleted')
    })

    it('checkout-update increments the revision', async () => {
      const ref = await createObj({ type: 'POST', name: 'orig', content: { title: 'v1' } })
      const { stdout: e } = await ig('edit', ref)
      const draftPath = join(projectDir, e.trim())
      const draft = JSON.parse(await readFile(draftPath, 'utf-8'))
      draft.content.title = 'v2'
      await writeFile(draftPath, JSON.stringify(draft))
      const { stdout } = await ig('commit', draftPath)
      assert.match(stdout.trim(), new RegExp(`^committed ${ref} rev 1 \\(pushed\\)$`))
      assert.equal(stored.get(ref).item.content.title, 'v2')
    })

    it('MERGE path (--update) preserves omitted top-level fields', async () => {
      const ref = await createObj({ type: 'POST', name: 'keep-me', content: { title: 'v1', extra: 'stays' } })
      const bare = await writeDraft({ content: { title: 'v2' } })
      const { stdout } = await ig('commit', bare, '--update', ref)
      assert.match(stdout.trim(), new RegExp(`^committed ${ref} rev 1`))
      const item = stored.get(ref).item
      assert.equal(item.name, 'keep-me', 'omitted top-level name preserved')
      assert.equal(item.content.extra, 'stays', 'omitted content field preserved')
      assert.equal(item.content.title, 'v2', 'patched field updated')
    })

    it('detects a revision conflict (exit 3)', async () => {
      const ref = await createObj({ type: 'POST', content: { title: 'v1' } })
      const { stdout: e } = await ig('edit', ref)
      const stalePath = join(projectDir, e.trim())
      await ig('set', ref, 'name', 'bumped') // advances to revision 1
      const err = await igFail('commit', stalePath)
      assert.equal(err.code, 3)
      assert.match(err.stderr, /conflict/)
      assert.match(err.stderr, /ig edit/)
    })

    it('rejects an unknown top-level field, naming it (exit 1)', async () => {
      const p = await writeDraft({ type: 'POST', titel: 'typo', _draft: { mode: 'new' } })
      const e = await igFail('commit', p)
      assert.equal(e.code, 1)
      assert.match(e.stderr, /titel/)
    })

    it('rejects signature-managed fields', async () => {
      const p = await writeDraft({ type: 'POST', pubkey: 'x', _draft: { mode: 'new' } })
      const e = await igFail('commit', p)
      assert.equal(e.code, 1)
      assert.match(e.stderr, /remove 'pubkey'/)
    })

    it('lists every schema error, one per line', async () => {
      const p = await writeDraft({
        type: 'NOTE', name: 'x', instruction: 'y', content: {},
        relations: { type_def: [{ ref: typeRef }] }, _draft: { mode: 'new' }
      })
      const e = await igFail('commit', p)
      assert.equal(e.code, 1)
      assert.match(e.stderr, /text.*required/)
      assert.match(e.stderr, /count.*required/)
    })

    it('--dry-run validates without touching the store', async () => {
      const id = '55555555-5555-5555-5555-555555555555'
      const p = await writeDraft({
        type: 'NOTE', id, name: 'x', instruction: 'y', in: ['dataverse001'],
        content: { text: 'hi', count: 1 },
        relations: { type_def: [{ ref: typeRef }] }, _draft: { mode: 'new' }
      })
      const { stdout } = await ig('validate', p) // alias for commit --dry-run
      assert.match(stdout.trim(), /^valid: would create /)
      const ref = `${(await ig('identity')).stdout.match(/Pubkey: (\S+)/)[1]}.${id}`
      assert.ok(!stored.has(ref), 'nothing pushed')
      const dataDir = join(projectDir, '.instructionGraph', 'data')
      assert.ok(!existsSync(join(dataDir, `${ref}.json`)), 'nothing stored')
      const bk = existsSync(join(dataDir, 'bk')) ? await readdir(join(dataDir, 'bk')) : []
      assert.ok(!bk.some(f => f.startsWith(ref)), 'no backup written for this object')
    })

    it('push failure stores locally and exits 4', async () => {
      const id = '66666666-6666-6666-6666-666666666666'
      const p = await writeDraft({ type: 'POST', id, in: ['dataverse001'], content: { failpush: true }, _draft: { mode: 'new' } })
      const e = await igFail('commit', p, '--push')
      assert.equal(e.code, 4)
      assert.match(e.stderr, /push/)
      assert.match(e.stderr, /ig server push --ref/)
      const pubkey = (await ig('identity')).stdout.match(/Pubkey: (\S+)/)[1]
      assert.ok(existsSync(join(projectDir, '.instructionGraph', 'data', `${pubkey}.${id}.json`)), 'stored locally')
    })

    it('errors when creating an object whose id already exists, pointing at ig edit', async () => {
      const ref = await createObj({ type: 'POST', content: { title: 'first' } })
      const id = ref.split('.').slice(1).join('.')
      const p = await writeDraft({ type: 'POST', id, in: ['dataverse001'], content: { title: 'again' }, _draft: { mode: 'new' } })
      const e = await igFail('commit', p)
      assert.equal(e.code, 1)
      assert.match(e.stderr, /already exists/)
      assert.match(e.stderr, /ig edit/)
    })

    it('reports a JSON syntax error with line/column (exit 1)', async () => {
      const p = join(projectDir, 'bad.json')
      await writeFile(p, '{\n  "type": "POST",\n  bad\n}')
      const e = await igFail('commit', p)
      assert.equal(e.code, 1)
      assert.match(e.stderr, /line \d+ column \d+/)
    })
  })

  // ─── ig set ──────────────────────────────────────────────────────

  describe('ig set', () => {
    it('sets a nested path and bumps revision by exactly 1', async () => {
      const ref = await createObj({ type: 'POST', content: { title: 'a' } })
      const { stdout } = await ig('set', ref, 'content.title', 'b')
      assert.match(stdout.trim(), new RegExp(`^committed ${ref} rev 1 \\(pushed\\)$`))
      assert.equal(stored.get(ref).item.content.title, 'b')
      await ig('set', ref, 'content.title', 'c')
      assert.equal(stored.get(ref).item.revision, 2)
    })

    it('--json parses typed values', async () => {
      const ref = await createObj({ type: 'POST', content: {} })
      await ig('set', ref, 'content.score', '42', '--json')
      assert.strictEqual(stored.get(ref).item.content.score, 42)
      await ig('set', ref, 'content.tags', '["x","y"]', '--json')
      assert.deepEqual(stored.get(ref).item.content.tags, ['x', 'y'])
    })

    it('--delete removes a key', async () => {
      const ref = await createObj({ type: 'POST', content: { title: 'a', body: 'b' } })
      await ig('set', ref, 'content.body', '--delete')
      assert.ok(!('body' in stored.get(ref).item.content))
    })

    it('refuses signature-managed and relations paths (exit 1)', async () => {
      const ref = await createObj({ type: 'POST', content: {} })
      const e1 = await igFail('set', ref, 'pubkey', 'x')
      assert.equal(e1.code, 1)
      assert.match(e1.stderr, /set automatically/)
      const e2 = await igFail('set', ref, 'relations.likes', 'x')
      assert.equal(e2.code, 1)
      assert.match(e2.stderr, /ig relate/)
    })

    it('usage error when neither value nor --delete is given (exit 2)', async () => {
      const ref = await createObj({ type: 'POST', content: {} })
      const e = await igFail('set', ref, 'content.title')
      assert.equal(e.code, 2)
    })
  })

  // ─── ig relate / ig unrelate ─────────────────────────────────────

  describe('ig relate / ig unrelate', () => {
    const TARGET = 'ApWJVWXvVKIIMnH6CP6u8HUyU2gLvyYGnwRlgrWAUwcP.d3d1219a-e755-456c-b02b-3d81cd3bd303'

    it('adds a relation, creating the array', async () => {
      const ref = await createObj({ type: 'POST', content: {} })
      const { stdout } = await ig('relate', ref, 'cites', TARGET)
      assert.match(stdout.trim(), new RegExp(`^committed ${ref} rev 1`))
      assert.deepEqual(stored.get(ref).item.relations.cites, [{ ref: TARGET }])
    })

    it('errors "already related" on a duplicate (exit 1)', async () => {
      const ref = await createObj({ type: 'POST', content: {} })
      await ig('relate', ref, 'cites', TARGET)
      const e = await igFail('relate', ref, 'cites', TARGET)
      assert.equal(e.code, 1)
      assert.match(e.stderr, /already related/)
    })

    it('updates instruction on an existing relation', async () => {
      const ref = await createObj({ type: 'POST', content: {} })
      await ig('relate', ref, 'cites', TARGET)
      await ig('relate', ref, 'cites', TARGET, '--instruction', 'see also')
      assert.equal(stored.get(ref).item.relations.cites[0].instruction, 'see also')
    })

    it('refuses the author relation (exit 1)', async () => {
      const ref = await createObj({ type: 'POST', content: {} })
      const e = await igFail('relate', ref, 'author', TARGET)
      assert.equal(e.code, 1)
      assert.match(e.stderr, /author/)
    })

    it('rejects a malformed target ref (exit 1)', async () => {
      const ref = await createObj({ type: 'POST', content: {} })
      const e = await igFail('relate', ref, 'cites', 'not-a-ref')
      assert.equal(e.code, 1)
      assert.match(e.stderr, /malformed ref/)
    })

    it('unrelate removes the entry and drops an emptied key', async () => {
      const ref = await createObj({ type: 'POST', content: {} })
      await ig('relate', ref, 'cites', TARGET)
      await ig('unrelate', ref, 'cites', TARGET)
      assert.ok(!('cites' in stored.get(ref).item.relations))
    })

    it('unrelate errors when the relation is absent (exit 1)', async () => {
      const ref = await createObj({ type: 'POST', content: {} })
      const e = await igFail('unrelate', ref, 'cites', TARGET)
      assert.equal(e.code, 1)
      assert.match(e.stderr, /not related/)
    })
  })
})
