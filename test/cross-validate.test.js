/**
 * Cross-validation: JS ↔ shell script interop.
 *
 * Verifies that:
 * 1. Objects signed by JS verify with the shell `./verify` script
 * 2. Objects signed by the shell `./create` script verify with JS
 * 3. Objects signed by JS can be ingested by the shell `./store` script
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, writeFile, readFile, mkdir, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withShellLock } from '../test-support/shell-lock.js'
import { generateKeypair, sign, verify } from '../src/crypto.js'
import { canonicalJSON } from '../src/canonical.js'
import { importPEM } from '../src/identity.js'
import { buildItem } from '../src/object.js'

const execFile = promisify(execFileCb)
const SHELL_SCRIPTS = '/home/claude/projects/dataverse/.instructionGraph'

describe('cross-validation', () => {
  it('JS-signed objects verify with shell ./verify', async () => {
    const kp = await generateKeypair()
    const item = buildItem({
      pubkey: kp.pubkey, type: 'TEST', id: 'js-to-shell-1',
      content: { source: 'javascript' }, in: ['dataverse001']
    })
    item.created_at = '2026-03-30T10:00:00Z'
    const signature = await sign(kp.privateKey, item)
    const envelope = { is: 'instructionGraph001', signature, item }

    const dir = await mkdtemp(join(tmpdir(), 'ig-xval-'))
    const file = join(dir, 'signed.json')
    await writeFile(file, JSON.stringify(envelope))

    const { stdout } = await withShellLock(() =>
      execFile(join(SHELL_SCRIPTS, 'verify'), [file])
    )
    assert.match(stdout, /Verified OK/)
  })

  it('shell-signed objects verify with JS verify()', async () => {
    // Read an existing shell-signed object from the data dir
    const { readdirSync } = await import('node:fs')
    const dataDir = join(SHELL_SCRIPTS, 'data')
    const files = readdirSync(dataDir).filter(f => f.endsWith('.json'))
    assert.ok(files.length > 0, 'should have at least one shell-signed object')

    const obj = JSON.parse(await readFile(join(dataDir, files[0]), 'utf-8'))
    const valid = await verify(obj.item.pubkey, obj.signature, obj.item)
    assert.ok(valid, `JS verify should pass for: ${files[0]}`)
  })

  it('JS-signed objects are accepted by shell ./store', async () => {
    const kp = await generateKeypair()
    const item = buildItem({
      pubkey: kp.pubkey, type: 'TEST', id: 'js-to-store-1',
      content: { stored: true }, in: ['dataverse001']
    })
    item.created_at = '2026-03-30T11:00:00Z'
    const signature = await sign(kp.privateKey, item)
    const envelope = { is: 'instructionGraph001', signature, item }

    // Set up a temp .instructionGraph with scripts
    const dir = await mkdtemp(join(tmpdir(), 'ig-xval-store-'))
    const igDir = join(dir, '.instructionGraph')
    await mkdir(join(igDir, 'data'), { recursive: true })
    for (const name of ['base-resolve', 'store', 'verify', 'validate']) {
      await copyFile(join(SHELL_SCRIPTS, name), join(igDir, name))
    }

    const inputFile = join(dir, 'input.json')
    await writeFile(inputFile, JSON.stringify(envelope))

    const { stdout } = await withShellLock(() =>
      execFile(join(igDir, 'store'), [inputFile])
    )
    assert.match(stdout, /STORED:/)

    // Verify stored file is canonical JSON
    const storedPath = join(igDir, 'data', `${item.ref}.json`)
    const stored = await readFile(storedPath, 'utf-8')
    assert.equal(stored.trim(), canonicalJSON(envelope))
  })

  it('shell ./create objects verify with JS, and vice versa (PEM round-trip)', async () => {
    // Generate a Node.js keypair, export as PEM
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

    // Import in JS
    const imported = await importPEM(pem)

    // Set up temp .instructionGraph for shell create
    const dir = await mkdtemp(join(tmpdir(), 'ig-xval-create-'))
    const igDir = join(dir, '.instructionGraph')
    const identityDir = join(dir, 'identity')
    await mkdir(join(igDir, 'data'), { recursive: true })
    await mkdir(identityDir, { recursive: true })
    for (const name of ['base-resolve', 'create', 'store', 'verify', 'validate']) {
      await copyFile(join(SHELL_SCRIPTS, name), join(igDir, name))
    }
    await writeFile(join(identityDir, 'private.pem'), pem)

    // Write a spec for shell create
    const spec = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      pubkey: imported.pubkey,
      in: ['dataverse001'],
      created_at: '2026-03-30T12:00:00Z',
      type: 'POST',
      relations: {},
      content: { title: 'Created by shell' }
    }
    const specPath = join(dir, 'spec.json')
    await writeFile(specPath, JSON.stringify(spec))

    const { stdout } = await withShellLock(() =>
      execFile(join(igDir, 'create'), [specPath, identityDir])
    )
    assert.match(stdout, /STORED:/)

    // Read the shell-created object and verify with JS
    const createdPath = join(igDir, 'data', `${imported.pubkey}.${spec.id}.json`)
    const created = JSON.parse(await readFile(createdPath, 'utf-8'))
    const valid = await verify(created.item.pubkey, created.signature, created.item)
    assert.ok(valid, 'JS should verify shell-created object')

    // Also verify PEM-imported pubkey matches
    assert.equal(created.item.pubkey, imported.pubkey)
  })
})
