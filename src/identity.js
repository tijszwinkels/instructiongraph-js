/**
 * Identity management: key derivation, PEM import, signer creation.
 */

import { base64urlEncode, base64urlDecode, bytesToBigInt, bigIntToBytes, bytesToBase64 } from './encoding.js'
import { N, GX, GY, ecMul, compressPoint } from './ec.js'
import { p1363ToDer } from './crypto.js'

const subtle = globalThis.crypto.subtle

// ─── PBKDF2 key derivation ──────────────────────────────────────

/**
 * Derive a deterministic ECDSA P-256 keypair from username + password.
 * Uses PBKDF2 (600k iterations, SHA-256) to derive a seed, then reduces
 * modulo curve order to get the private scalar.
 *
 * @param {string} username
 * @param {string} password
 * @returns {Promise<{ pubkey: string, privateKey: CryptoKey }>}
 */
export async function deriveKeypair(username, password) {
  const enc = new TextEncoder()

  const saltHash = await subtle.digest('SHA-256', enc.encode('dataverse001:' + username))
  const salt = new Uint8Array(saltHash)

  const baseKey = await subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const seedBuf = await subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 600000, hash: 'SHA-256' },
    baseKey, 256
  )

  const d = bytesToBigInt(new Uint8Array(seedBuf)) % (N - 1n) + 1n
  return importScalar(d)
}

// ─── PEM import ──────────────────────────────────────────────────

/**
 * Import an EC private key from PEM format (PKCS#8 or SEC1).
 * @param {string} pemText
 * @returns {Promise<{ pubkey: string, privateKey: CryptoKey }>}
 */
export async function importPEM(pemText) {
  const lines = pemText.trim().split('\n')
  const isSEC1 = lines[0].indexOf('EC PRIVATE KEY') !== -1

  let b64 = ''
  for (const line of lines) {
    if (line.trim().startsWith('-----')) continue
    b64 += line.trim()
  }
  const bin = atob(b64)
  const der = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) der[i] = bin.charCodeAt(i)

  if (!isSEC1) {
    // PKCS#8: use Web Crypto to extract JWK, then compress
    const key = await subtle.importKey(
      'pkcs8', der.buffer,
      { name: 'ECDSA', namedCurve: 'P-256' },
      true, ['sign']
    )
    const jwk = await subtle.exportKey('jwk', key)
    const pubX = bytesToBigInt(base64urlDecode(jwk.x))
    const pubY = bytesToBigInt(base64urlDecode(jwk.y))
    const pubkey = base64urlEncode(compressPoint(pubX, pubY))

    delete jwk.key_ops
    delete jwk.ext
    const privateKey = await subtle.importKey(
      'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
    )
    return { pubkey, privateKey }
  }

  // SEC1: manual ASN.1 parse to extract private scalar
  let pos = 0
  function readTag() {
    const tag = der[pos++]
    let len = der[pos++]
    if (len & 0x80) {
      const numBytes = len & 0x7f
      len = 0
      for (let j = 0; j < numBytes; j++) len = (len << 8) | der[pos++]
    }
    return { tag, len, start: pos }
  }

  readTag() // outer SEQUENCE
  const ver = readTag() // INTEGER version
  pos += ver.len
  const privOctet = readTag() // OCTET STRING
  const d = bytesToBigInt(der.slice(privOctet.start, privOctet.start + privOctet.len))
  return importScalar(d)
}

// ─── Shared: import a private scalar into Web Crypto ─────────────

async function importScalar(d) {
  const dBytes = bigIntToBytes(d, 32)
  const [pubX, pubY] = ecMul(d, GX, GY)
  const pubkey = base64urlEncode(compressPoint(pubX, pubY))

  const jwk = {
    kty: 'EC', crv: 'P-256',
    d: base64urlEncode(dBytes),
    x: base64urlEncode(bigIntToBytes(pubX, 32)),
    y: base64urlEncode(bigIntToBytes(pubY, 32))
  }
  const privateKey = await subtle.importKey(
    'jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']
  )
  return { pubkey, privateKey }
}

// ─── Signer creation ─────────────────────────────────────────────

/**
 * Wrap a keypair into the Signer interface.
 * @param {{ pubkey: string, privateKey: CryptoKey }} keypair
 * @returns {import('./types.js').Signer}
 */
export function createSigner(keypair) {
  return {
    pubkey: keypair.pubkey,
    async sign(data) {
      const sigBuf = await subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keypair.privateKey,
        data
      )
      const der = p1363ToDer(new Uint8Array(sigBuf))
      return bytesToBase64(der)
    }
  }
}

/** Well-known UUID for identity objects */
export const IDENTITY_UUID = '00000000-0000-0000-0000-000000000001'

/** Root node ref */
export const ROOT_REF = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.00000000-0000-0000-0000-000000000000'

/** IDENTITY type def ref */
export const IDENTITY_TYPE_DEF = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.ec1abe1f-faad-45cd-9c18-7a48f6895035'
