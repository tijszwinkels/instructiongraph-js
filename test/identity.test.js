import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deriveKeypair, importPEM, createSigner } from '../src/identity.js'
import { sign, verify } from '../src/crypto.js'
import { readFileSync, existsSync } from 'node:fs'

describe('identity', () => {
  describe('deriveKeypair', () => {
    it('derives deterministic keypair from username + password', async () => {
      const kp1 = await deriveKeypair('testuser', 'testpassword')
      const kp2 = await deriveKeypair('testuser', 'testpassword')
      assert.equal(kp1.pubkey, kp2.pubkey, 'same credentials → same pubkey')
      assert.equal(kp1.pubkey.length, 44)
    })

    it('different username → different pubkey', async () => {
      const kp1 = await deriveKeypair('user-a', 'password')
      const kp2 = await deriveKeypair('user-b', 'password')
      assert.notEqual(kp1.pubkey, kp2.pubkey)
    })

    it('different password → different pubkey', async () => {
      const kp1 = await deriveKeypair('user', 'pass-a')
      const kp2 = await deriveKeypair('user', 'pass-b')
      assert.notEqual(kp1.pubkey, kp2.pubkey)
    })

    it('derived key can sign and verify', async () => {
      const kp = await deriveKeypair('test', 'test')
      const item = { id: '1', type: 'TEST', content: {} }
      const sig = await sign(kp.privateKey, item)
      const valid = await verify(kp.pubkey, sig, item)
      assert.ok(valid)
    })
  })

  describe('importPEM', () => {
    // Test with our local test key if it exists
    const localPem = '/home/claude/projects/dataverse/.instructionGraph/identities/default/private.pem'

    it('imports PKCS#8 PEM and produces valid signer', async () => {
      if (!existsSync(localPem)) {
        console.log('Skipping PEM test — no local key at', localPem)
        return
      }
      const pem = readFileSync(localPem, 'utf-8')
      const kp = await importPEM(pem)
      assert.equal(kp.pubkey.length, 44, 'compressed pubkey should be 44 chars')

      const item = { id: 'pem-test', type: 'TEST', content: {} }
      const sig = await sign(kp.privateKey, item)
      const valid = await verify(kp.pubkey, sig, item)
      assert.ok(valid, 'PEM-imported key should produce valid signatures')
    })

    it('imported PEM pubkey matches shell-derived pubkey', async () => {
      if (!existsSync(localPem)) return
      const pem = readFileSync(localPem, 'utf-8')
      const kp = await importPEM(pem)

      // Derive expected pubkey from the PEM using openssl
      const { execSync } = await import('node:child_process')
      const knownPubkey = execSync(
        `openssl ec -in '${localPem}' -pubout -conv_form compressed -outform DER 2>/dev/null | tail -c 33 | base64 | tr '+/' '-_' | tr -d '='`,
        { encoding: 'utf-8' }
      ).trim()
      assert.equal(kp.pubkey, knownPubkey, 'PEM import should produce same pubkey as openssl')
    })
  })

  describe('createSigner', () => {
    it('wraps keypair into Signer interface', async () => {
      const kp = await deriveKeypair('signer-test', 'password')
      const signer = createSigner(kp)
      assert.equal(signer.pubkey, kp.pubkey)
      assert.equal(typeof signer.sign, 'function')

      // Test the sign function
      const data = new TextEncoder().encode('hello')
      const sig = await signer.sign(data)
      assert.ok(typeof sig === 'string', 'should return base64 string')
    })
  })
})
