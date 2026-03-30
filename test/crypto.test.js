import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { sign, verify, generateKeypair, exportCompressedPubkey, p1363ToDer } from '../src/crypto.js'

describe('crypto', () => {
  it('generateKeypair returns pubkey (44 chars base64url) and privateKey', async () => {
    const kp = await generateKeypair()
    assert.ok(kp.pubkey, 'should have pubkey')
    assert.equal(kp.pubkey.length, 44, 'compressed pubkey should be 44 chars')
    assert.ok(/^[A-Za-z0-9_-]+$/.test(kp.pubkey), 'pubkey should be base64url')
    assert.ok(kp.privateKey, 'should have privateKey CryptoKey')
  })

  it('sign + verify round-trip', async () => {
    const kp = await generateKeypair()
    const item = { id: 'test-123', type: 'TEST', content: { hello: 'world' } }
    const signature = await sign(kp.privateKey, item)

    assert.ok(typeof signature === 'string', 'signature should be base64 string')

    const valid = await verify(kp.pubkey, signature, item)
    assert.ok(valid, 'signature should verify')
  })

  it('verify rejects tampered data', async () => {
    const kp = await generateKeypair()
    const item = { id: 'test-123', type: 'TEST', content: { hello: 'world' } }
    const signature = await sign(kp.privateKey, item)

    const tampered = { ...item, content: { hello: 'tampered' } }
    const valid = await verify(kp.pubkey, signature, tampered)
    assert.ok(!valid, 'tampered data should not verify')
  })

  it('verify rejects wrong pubkey', async () => {
    const kp1 = await generateKeypair()
    const kp2 = await generateKeypair()
    const item = { id: 'test-123', type: 'TEST' }
    const signature = await sign(kp1.privateKey, item)

    const valid = await verify(kp2.pubkey, signature, item)
    assert.ok(!valid, 'wrong pubkey should not verify')
  })

  it('signature is DER-encoded (matches shell verify)', async () => {
    const kp = await generateKeypair()
    const item = { id: 'test-123', type: 'TEST', content: { data: 'cross-validate' } }
    const signature = await sign(kp.privateKey, item)

    // DER signatures start with 0x30 (SEQUENCE tag)
    const sigBytes = Buffer.from(signature, 'base64')
    assert.equal(sigBytes[0], 0x30, 'DER signature should start with 0x30')
  })

  it('p1363ToDer converts correctly', () => {
    // 64-byte P1363 → DER SEQUENCE
    const p1363 = new Uint8Array(64)
    p1363[0] = 0x01 // r starts with small value (no padding needed)
    p1363[31] = 0x42
    p1363[32] = 0x01 // s starts with small value
    p1363[63] = 0x43
    const der = p1363ToDer(p1363)
    assert.equal(der[0], 0x30, 'DER starts with SEQUENCE')
    assert.equal(der[2], 0x02, 'first INTEGER tag')
  })

  // Cross-validation tests are in cross-validate.test.js
})
