import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'

import { canonicalJSON, generateKeypair, signItem, verifyItemSignature } from '../src/index.js'
import { importPEM } from '../src/identity.js'
import { withShellLock } from '../test-support/shell-lock.js'

const execFile = promisify(execFileCb)
const SOURCE_IG = '/home/claude/projects/dataverse/.instructionGraph'

async function copyInstructionGraphScripts(targetDir) {
  await mkdir(targetDir, { recursive: true })
  for (const name of ['base-resolve', 'create', 'store', 'verify', 'validate']) {
    await copyFile(join(SOURCE_IG, name), join(targetDir, name))
  }
}

test('shell store accepts JS-signed objects and stores canonical JSON', async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), 'ig-cross-store-'))
  const igDir = join(tempDir, '.instructionGraph')
  await copyInstructionGraphScripts(igDir)
  await mkdir(join(igDir, 'data'), { recursive: true })

  const { privateKey, pubkey } = await generateKeypair()
  const signed = await signItem({
    id: '88888888-8888-4888-8888-888888888888',
    ref: `${pubkey}.88888888-8888-4888-8888-888888888888`,
    pubkey,
    in: ['dataverse001'],
    created_at: '2026-03-30T00:00:00Z',
    revision: 0,
    type: 'NOTE',
    relations: {},
    content: { text: 'hello from js' },
  }, privateKey)

  const inputPath = join(tempDir, 'signed.json')
  await writeFile(inputPath, JSON.stringify(signed), 'utf8')

  const { stdout } = await withShellLock(() => execFile(join(igDir, 'store'), [inputPath]))
  assert.match(stdout, /STORED:/)

  const storedPath = join(igDir, 'data', `${signed.item.ref}.json`)
  assert.equal(await readFile(storedPath, 'utf8'), `${canonicalJSON(signed)}\n`)
})

test('JS verify accepts objects created by the shell create script', async () => {
  const tempDir = await mkdtemp(join(os.tmpdir(), 'ig-cross-create-'))
  const igDir = join(tempDir, '.instructionGraph')
  const identityDir = join(tempDir, 'identity')
  await copyInstructionGraphScripts(igDir)
  await mkdir(join(igDir, 'data'), { recursive: true })
  await mkdir(identityDir, { recursive: true })

  const pem = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey
    .export({ format: 'pem', type: 'pkcs8' }).toString()
  await writeFile(join(identityDir, 'private.pem'), pem, 'utf8')

  const imported = await importPEM(pem)
  const id = '99999999-9999-4999-8999-999999999999'
  const specPath = join(tempDir, 'spec.json')
  await writeFile(specPath, JSON.stringify({
    id,
    pubkey: imported.pubkey,
    in: ['dataverse001'],
    created_at: '2026-03-30T00:00:00Z',
    type: 'POST',
    relations: {},
    content: { title: 'Created by shell' },
  }), 'utf8')

  const { stdout } = await withShellLock(() => execFile(join(igDir, 'create'), [specPath, identityDir]))
  assert.match(stdout, /STORED:/)

  const createdPath = join(igDir, 'data', `${imported.pubkey}.${id}.json`)
  const created = JSON.parse(await readFile(createdPath, 'utf8'))
  assert.equal(await verifyItemSignature(created), true)
})
