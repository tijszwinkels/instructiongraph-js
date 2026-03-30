import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { importCompressedPubkey, signItem, verifyBytes, verifyItemSignature } from '../src/crypto.js'
import { createSigner, deriveKeypair, deriveSalt, importPEM } from '../src/identity.js'
import { withShellLock } from '../test-support/shell-lock.js'

const execFile = promisify(execFileCb)
const VERIFY_SCRIPT = '/home/claude/projects/dataverse/.instructionGraph/verify'

function makeItem(pubkey, id = '99999999-9999-4999-8999-999999999999') {
  return {
    id,
    in: ['dataverse001'],
    ref: `${pubkey}.${id}`,
    pubkey,
    created_at: '2026-03-30T00:00:00Z',
    type: 'NOTE',
    relations: {},
    content: { text: 'identity-test' },
  }
}

test('deriveKeypair is deterministic for the same username/password salt', async () => {
  const salt = await deriveSalt('alice')
  const first = await deriveKeypair('correct horse battery staple', salt)
  const second = await deriveKeypair('correct horse battery staple', salt)

  assert.equal(first.pubkey, second.pubkey)
  assert.match(first.pubkey, /^[A-Za-z0-9_-]{44}$/)

  const signed = await signItem(makeItem(first.pubkey), first.privateKey)
  assert.equal(await verifyItemSignature(signed), true)
})

test('importPEM supports PKCS#8 and SEC1 EC private keys', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pkcs8Pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
  const sec1Pem = privateKey.export({ format: 'pem', type: 'sec1' }).toString()

  const importedPkcs8 = await importPEM(pkcs8Pem)
  const importedSec1 = await importPEM(sec1Pem)

  assert.equal(importedPkcs8.pubkey, importedSec1.pubkey)
  assert.equal(await verifyItemSignature(await signItem(makeItem(importedPkcs8.pubkey), importedPkcs8.privateKey)), true)
  assert.equal(await verifyItemSignature(await signItem(makeItem(importedSec1.pubkey), importedSec1.privateKey)), true)

  const signed = await signItem(makeItem(importedPkcs8.pubkey, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), importedPkcs8.privateKey)
  const dir = await mkdtemp(join(tmpdir(), 'ig-identity-'))
  const file = join(dir, 'signed.json')
  await writeFile(file, JSON.stringify(signed), 'utf8')
  const { stdout } = await withShellLock(() => execFile(VERIFY_SCRIPT, [file]))
  assert.match(stdout, /Verified OK/)
})

test('createSigner supports credentials, pem, pem-file, and signer inputs', async () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const pkcs8Pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()

  const passthrough = { pubkey: 'pk', sign: async () => 'sig' }
  assert.equal(await createSigner({ type: 'signer', signer: passthrough }), passthrough)

  const credentialsA = await createSigner({ type: 'credentials', username: 'alice', password: 'secret' })
  const credentialsB = await createSigner({ type: 'credentials', username: 'alice', password: 'secret' })
  assert.equal(credentialsA.pubkey, credentialsB.pubkey)

  const message = new TextEncoder().encode('challenge-123')
  const signature = await credentialsA.sign(message)
  const publicKey = await importCompressedPubkey(credentialsA.pubkey)
  assert.equal(await verifyBytes(publicKey, message, signature), true)

  const pemSigner = await createSigner({ type: 'pem', pem: pkcs8Pem })
  const dir = await mkdtemp(join(tmpdir(), 'ig-pem-'))
  const pemPath = join(dir, 'private.pem')
  await writeFile(pemPath, pkcs8Pem, 'utf8')
  const pemFileSigner = await createSigner({ type: 'pem-file', path: pemPath })

  assert.equal(pemSigner.pubkey, pemFileSigner.pubkey)
  assert.equal(await verifyBytes(await importCompressedPubkey(pemSigner.pubkey), message, await pemSigner.sign(message)), true)
})
