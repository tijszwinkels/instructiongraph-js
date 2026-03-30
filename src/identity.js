import { base64ToBytes, base64urlToBytes, bytesToBase64url, signBytes } from './crypto.js'

const subtle = globalThis.crypto?.subtle
const textEncoder = new TextEncoder()

const P256_P = 0xFFFFFFFF00000001000000000000000000000000FFFFFFFFFFFFFFFFFFFFFFFFn
const P256_A = P256_P - 3n
const P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551n
const P256_GX = 0x6B17D1F2E12C4247F8BCE6E563A440F277037D812DEB33A0F4A13945D898C296n
const P256_GY = 0x4FE342E2FE1A7F9B8EE7EB4A7C0F9E162BCE33576B315ECECBB6406837BF51F5n

function requireSubtle() {
  if (!subtle) throw new Error('Web Crypto API is not available in this runtime')
  return subtle
}

function modP(value) {
  return ((value % P256_P) + P256_P) % P256_P
}

function modInv(value, modulus) {
  let oldR = ((value % modulus) + modulus) % modulus
  let r = modulus
  let oldS = 1n
  let s = 0n

  while (r !== 0n) {
    const q = oldR / r
    ;[oldR, r] = [r, oldR - q * r]
    ;[oldS, s] = [s, oldS - q * s]
  }

  return ((oldS % modulus) + modulus) % modulus
}

function ecAdd(x1, y1, x2, y2) {
  if (x1 === null) return [x2, y2]
  if (x2 === null) return [x1, y1]

  let lambda
  if (x1 === x2 && y1 === y2) {
    if (y1 === 0n) return [null, null]
    lambda = modP((3n * x1 * x1 + P256_A) * modInv(2n * y1, P256_P))
  } else if (x1 === x2) {
    return [null, null]
  } else {
    lambda = modP((y2 - y1) * modInv(((x2 - x1) % P256_P + P256_P) % P256_P, P256_P))
  }

  const x3 = modP(lambda * lambda - x1 - x2)
  const y3 = modP(lambda * (x1 - x3) - y1)
  return [x3, y3]
}

function ecMul(k, x, y) {
  let rx = null
  let ry = null
  let qx = x
  let qy = y
  let scalar = k

  while (scalar > 0n) {
    if (scalar & 1n) [rx, ry] = ecAdd(rx, ry, qx, qy)
    ;[qx, qy] = ecAdd(qx, qy, qx, qy)
    scalar >>= 1n
  }

  return [rx, ry]
}

function bytesToBigInt(bytes) {
  let value = 0n
  for (const byte of bytes) value = (value << 8n) | BigInt(byte)
  return value
}

function bigIntToBytes(value, length) {
  const bytes = new Uint8Array(length)
  let remaining = value
  for (let index = length - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn)
    remaining >>= 8n
  }
  return bytes
}

function compressPoint(x, y) {
  const compressed = new Uint8Array(33)
  compressed[0] = y & 1n ? 0x03 : 0x02
  compressed.set(bigIntToBytes(x, 32), 1)
  return compressed
}

export async function deriveSalt(username) {
  const digest = await requireSubtle().digest('SHA-256', textEncoder.encode(`dataverse001:${username}`))
  return new Uint8Array(digest)
}

export async function deriveKeypair(passphrase, salt) {
  const baseKey = await requireSubtle().importKey(
    'raw',
    textEncoder.encode(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  )

  const seed = new Uint8Array(await requireSubtle().deriveBits(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    baseKey,
    256,
  ))

  const d = (bytesToBigInt(seed) % (P256_N - 1n)) + 1n
  const [x, y] = ecMul(d, P256_GX, P256_GY)
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: bytesToBase64url(bigIntToBytes(d, 32)),
    x: bytesToBase64url(bigIntToBytes(x, 32)),
    y: bytesToBase64url(bigIntToBytes(y, 32)),
  }

  const privateKey = await requireSubtle().importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )

  return {
    privateKey,
    pubkey: bytesToBase64url(compressPoint(x, y)),
  }
}

export async function importPEM(pemText) {
  const lines = pemText.trim().split(/\r?\n/)
  const isSec1 = lines[0]?.includes('EC PRIVATE KEY')
  let base64 = ''
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('-----')) continue
    base64 += trimmed
  }

  const der = base64ToBytes(base64)

  if (!isSec1) {
    const extractable = await requireSubtle().importKey(
      'pkcs8',
      der.buffer.slice(der.byteOffset, der.byteOffset + der.byteLength),
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign'],
    )

    const jwk = await requireSubtle().exportKey('jwk', extractable)
    const pubkey = bytesToBase64url(compressPoint(
      bytesToBigInt(base64urlToBytes(jwk.x)),
      bytesToBigInt(base64urlToBytes(jwk.y)),
    ))

    delete jwk.key_ops
    delete jwk.ext

    const privateKey = await requireSubtle().importKey(
      'jwk',
      jwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign'],
    )

    return { privateKey, pubkey }
  }

  let position = 0
  function readTag() {
    const tag = der[position++]
    let length = der[position++]
    if (length & 0x80) {
      const byteCount = length & 0x7f
      length = 0
      for (let index = 0; index < byteCount; index += 1) {
        length = (length << 8) | der[position++]
      }
    }
    return { tag, length, start: position }
  }

  readTag()
  const version = readTag()
  position += version.length
  const privateOctet = readTag()
  const scalarBytes = der.slice(privateOctet.start, privateOctet.start + privateOctet.length)
  const scalar = bytesToBigInt(scalarBytes)
  const [x, y] = ecMul(scalar, P256_GX, P256_GY)
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: bytesToBase64url(bigIntToBytes(scalar, 32)),
    x: bytesToBase64url(bigIntToBytes(x, 32)),
    y: bytesToBase64url(bigIntToBytes(y, 32)),
  }

  const privateKey = await requireSubtle().importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  )

  return {
    privateKey,
    pubkey: bytesToBase64url(compressPoint(x, y)),
  }
}

async function readPemFile(path) {
  try {
    const { readFile } = await import('node:fs/promises')
    return await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`pem-file identities are only available in Node.js: ${error.message}`)
  }
}

export async function createSigner(identity) {
  if (!identity || typeof identity !== 'object') {
    throw new Error('Identity configuration is required')
  }

  switch (identity.type) {
    case 'signer':
      return identity.signer
    case 'pem': {
      const imported = await importPEM(identity.pem)
      return {
        ...imported,
        sign: (data) => signBytes(imported.privateKey, data),
      }
    }
    case 'pem-file': {
      const pem = await readPemFile(identity.path)
      return createSigner({ type: 'pem', pem })
    }
    case 'credentials': {
      const salt = await deriveSalt(identity.username)
      const derived = await deriveKeypair(identity.password, salt)
      return {
        ...derived,
        sign: (data) => signBytes(derived.privateKey, data),
      }
    }
    default:
      throw new Error(`Unsupported identity type: ${identity.type}`)
  }
}
