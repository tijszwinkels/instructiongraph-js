/**
 * Test-support: a throwaway ECDSA identity as a PEM, for signing into a local
 * test store. Never used against a real hub.
 */

import { generateKeypair } from '../src/crypto.js'

export async function throwawayIdentity() {
  const kp = await generateKeypair({ extractable: true })
  const pkcs8 = new Uint8Array(await globalThis.crypto.subtle.exportKey('pkcs8', kp.privateKey))
  let b = ''
  for (let i = 0; i < pkcs8.length; i++) b += String.fromCharCode(pkcs8[i])
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(b).match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`
  return { pubkey: kp.pubkey, pem, identity: { type: 'pem', pem } }
}
