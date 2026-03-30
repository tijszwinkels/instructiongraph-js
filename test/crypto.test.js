import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

import { canonicalJSON } from '../src/canonical.js'
import {
  generateKeypair,
  signBytes,
  signItem,
  verifyItemSignature,
} from '../src/crypto.js'
import { withShellLock } from '../test-support/shell-lock.js'

const execFile = promisify(execFileCb)
const VERIFY_SCRIPT = '/home/claude/projects/dataverse/.instructionGraph/verify'

test('generateKeypair + signItem + verifyItemSignature round-trip', async () => {
  const { privateKey, pubkey } = await generateKeypair()
  const item = {
    id: '11111111-1111-4111-8111-111111111111',
    in: ['dataverse001'],
    ref: `${pubkey}.11111111-1111-4111-8111-111111111111`,
    pubkey,
    created_at: '2026-03-30T00:00:00Z',
    type: 'NOTE',
    content: { text: 'hello' },
  }

  const signed = await signItem(item, privateKey)
  assert.equal(signed.is, 'instructionGraph001')
  assert.equal(signed.item, item)
  assert.equal(typeof signed.signature, 'string')
  assert.equal(await verifyItemSignature(signed), true)
})

test('verifyItemSignature rejects tampering', async () => {
  const { privateKey, pubkey } = await generateKeypair()
  const item = {
    id: '22222222-2222-4222-8222-222222222222',
    in: ['dataverse001'],
    ref: `${pubkey}.22222222-2222-4222-8222-222222222222`,
    pubkey,
    created_at: '2026-03-30T00:00:00Z',
    type: 'NOTE',
    content: { text: 'before' },
  }

  const signed = await signItem(item, privateKey)
  signed.item.content.text = 'after'
  assert.equal(await verifyItemSignature(signed), false)
})

test('JS signatures verify with existing shell script', async () => {
  const { privateKey, pubkey } = await generateKeypair()
  const item = {
    id: '33333333-3333-4333-8333-333333333333',
    in: ['dataverse001'],
    ref: `${pubkey}.33333333-3333-4333-8333-333333333333`,
    pubkey,
    created_at: '2026-03-30T00:00:00Z',
    type: 'TEST',
    content: { stable: canonicalJSON({ ok: true }) },
  }

  const signed = await signItem(item, privateKey)
  const dir = await mkdtemp(join(tmpdir(), 'ig-crypto-'))
  const file = join(dir, 'signed.json')
  await writeFile(file, JSON.stringify(signed), 'utf8')

  const { stdout } = await withShellLock(() => execFile(VERIFY_SCRIPT, [file]))
  assert.match(stdout, /Verified OK/)
})

test('signBytes returns base64 DER signature', async () => {
  const { privateKey } = await generateKeypair()
  const signature = await signBytes(privateKey, new TextEncoder().encode('hello'))
  const bytes = Buffer.from(signature, 'base64')
  assert.equal(bytes[0], 0x30)
})
