import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'

import { createClient } from '../src/client.js'
import { generateKeypair, signBytes, signItem } from '../src/index.js'

function clone(value) {
  return structuredClone(value)
}

function createMemoryStore(initial = {}) {
  const objects = new Map(Object.entries(initial))
  const puts = []

  return {
    puts,
    async get(ref) {
      return clone(objects.get(ref) ?? null)
    },
    async put(object) {
      puts.push(clone(object))
      objects.set(object.item.ref, clone(object))
      return { ok: true, status: objects.has(object.item.ref) ? 200 : 201, object: clone(object) }
    },
    async search(query = {}) {
      const items = [...objects.values()]
        .filter((object) => (!query.by || object.item.pubkey === query.by) && (!query.type || object.item.type === query.type))
        .sort((a, b) => (b.item.updated_at ?? b.item.created_at).localeCompare(a.item.updated_at ?? a.item.created_at))
      return { items: clone(items), cursor: null, hasMore: false }
    },
    async inbound(ref, query = {}) {
      const items = [...objects.values()]
        .filter((object) => {
          if (query.from && object.item.pubkey !== query.from) return false
          if (query.type && object.item.type !== query.type) return false
          return Object.entries(object.item.relations ?? {}).some(([relationName, entries]) =>
            (!query.relation || relationName === query.relation) && (entries ?? []).some((entry) => entry.ref === ref),
          )
        })
        .sort((a, b) => (b.item.updated_at ?? b.item.created_at).localeCompare(a.item.updated_at ?? a.item.created_at))
      return { items: clone(items), cursor: null, hasMore: false }
    },
  }
}

test('createClient create/update/delete flow works with custom signer and type validation', async () => {
  const { privateKey, pubkey } = await generateKeypair()
  const signer = { pubkey, sign: (data) => signBytes(privateKey, data) }
  const typeRef = `${pubkey}.aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`
  const typeObject = {
    is: 'instructionGraph001',
    signature: 'sig',
    item: {
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      ref: typeRef,
      pubkey,
      in: ['dataverse001'],
      created_at: '2026-03-30T00:00:00Z',
      type: 'TYPE',
      relations: {},
      content: {
        schema: {
          type: 'object',
          required: ['title'],
          properties: {
            title: { type: 'string' },
            body: { type: 'string' },
          },
        },
      },
    },
  }

  const store = createMemoryStore({ [typeRef]: typeObject })
  const ig = createClient({
    store,
    identity: { type: 'signer', signer },
    defaultRealm: 'custom-realm',
  })

  await assert.rejects(
    ig.create({
      type: 'POST',
      relations: { type_def: [{ ref: typeRef }] },
      content: { body: 'missing title' },
    }),
    /content.title is required/,
  )

  const ref = await ig.create({
    type: 'POST',
    relations: { type_def: [{ ref: typeRef }] },
    content: { title: 'Hello' },
  })

  const created = await ig.get(ref)
  assert.equal(created.item.pubkey, pubkey)
  assert.deepEqual(created.item.in, ['custom-realm'])
  assert.equal(created.item.revision ?? 0, 0)
  assert.deepEqual(created.item.content, { title: 'Hello' })

  const updatedRef = await ig.update(ref, { content: { body: 'World' } })
  assert.equal(updatedRef, ref)
  const updated = await ig.get(ref)
  assert.equal(updated.item.revision, 1)
  assert.deepEqual(updated.item.content, { title: 'Hello', body: 'World' })
  assert.ok(updated.item.updated_at)

  const deletedRef = await ig.delete(ref)
  assert.equal(deletedRef, ref)
  const deleted = await ig.get(ref)
  assert.equal(deleted.item.type, 'DELETED')
  assert.equal(deleted.item.revision, 2)
})

test('createClient write operations fail clearly without an identity', async () => {
  const ig = createClient({ store: createMemoryStore(), identity: null })
  await assert.rejects(ig.create({ type: 'NOTE', content: { text: 'hello' } }), /No identity configured/)
  await assert.rejects(ig.sign({ type: 'NOTE', content: { text: 'hello' } }), /No identity configured/)
})

test('createClient auto-loads local/home .instructionGraph config and identity files', { concurrency: false }, async () => {
  const originalCwd = process.cwd()
  const originalHome = process.env.HOME
  const originalFetch = globalThis.fetch

  const homeDir = await mkdtemp(join(os.tmpdir(), 'ig-home-'))
  const projectDir = await mkdtemp(join(os.tmpdir(), 'ig-project-'))
  const localBase = join(projectDir, '.instructionGraph')
  const homeBase = join(homeDir, '.instructionGraph')

  const localKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    .export({ format: 'pem', type: 'pkcs8' }).toString()
  const homeKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    .export({ format: 'pem', type: 'pkcs8' }).toString()

  const requests = []
  globalThis.fetch = async (url) => {
    requests.push(String(url))
    return new Response(JSON.stringify({ items: [], cursor: null, has_more: false }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    await mkdir(join(localBase, 'config'), { recursive: true })
    await mkdir(join(localBase, 'identities', 'local-user'), { recursive: true })
    await mkdir(join(homeBase, 'config'), { recursive: true })
    await mkdir(join(homeBase, 'identities', 'home-user'), { recursive: true })

    await writeFile(join(localBase, 'config', 'hub-url'), 'https://local.example\n')
    await writeFile(join(localBase, 'config', 'active-identity'), 'local-user\n')
    await writeFile(join(homeBase, 'config', 'hub-url'), 'https://home.example\n')
    await writeFile(join(homeBase, 'config', 'default-realm'), 'home-realm\n')
    await writeFile(join(homeBase, 'config', 'active-identity'), 'home-user\n')
    await writeFile(join(localBase, 'identities', 'local-user', 'private.pem'), localKey)
    await writeFile(join(homeBase, 'identities', 'home-user', 'private.pem'), homeKey)

    process.env.HOME = homeDir
    process.chdir(projectDir)

    const ig = createClient()
    const built = await ig.build({ type: 'NOTE', content: { text: 'hi' } })

    assert.deepEqual(built.in, ['home-realm'])
    assert.match(built.pubkey, /^[A-Za-z0-9_-]{44}$/)

    await ig.search({ type: 'NOTE', limit: 1 })
    assert.equal(requests[0], 'https://local.example/search?type=NOTE&limit=1')
  } finally {
    process.chdir(originalCwd)
    process.env.HOME = originalHome
    globalThis.fetch = originalFetch
  }
})

test('createIdentity publishes a well-known IDENTITY object and saves PEM locally', { concurrency: false }, async () => {
  const projectDir = await mkdtemp(join(os.tmpdir(), 'ig-identity-project-'))
  await mkdir(join(projectDir, '.instructionGraph'), { recursive: true })
  const originalCwd = process.cwd()

  try {
    process.chdir(projectDir)
    const store = createMemoryStore()
    const ig = createClient({ store })
    const created = await ig.createIdentity({ name: 'Alice' })

    assert.equal(created.ref, `${created.pubkey}.00000000-0000-0000-0000-000000000001`)
    const identityObject = await store.get(created.ref)
    assert.equal(identityObject.item.type, 'IDENTITY')
    assert.equal(identityObject.item.content.name, 'Alice')

    const pem = await readFile(join(projectDir, '.instructionGraph', 'identities', 'Alice', 'private.pem'), 'utf8')
    assert.match(pem, /BEGIN PRIVATE KEY/)
  } finally {
    process.chdir(originalCwd)
  }
})
