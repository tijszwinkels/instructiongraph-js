import { canonicalJSON } from './canonical.js'

const subtle = globalThis.crypto?.subtle
const textEncoder = new TextEncoder()
const COMPRESSED_P256_SPKI_PREFIX = hexToBytes('3039301306072a8648ce3d020106082a8648ce3d030107032200')

function requireSubtle() {
  if (!subtle) throw new Error('Web Crypto API is not available in this runtime')
  return subtle
}

function encodeBase64(binary) {
  if (typeof globalThis.btoa === 'function') return globalThis.btoa(binary)
  if (typeof Buffer !== 'undefined') return Buffer.from(binary, 'binary').toString('base64')
  throw new Error('No base64 encoder available in this runtime')
}

function decodeBase64(value) {
  if (typeof globalThis.atob === 'function') return globalThis.atob(value)
  if (typeof Buffer !== 'undefined') return Buffer.from(value, 'base64').toString('binary')
  throw new Error('No base64 decoder available in this runtime')
}

function bytesToBinary(bytes) {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return binary
}

function binaryToBytes(binary) {
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export function bytesToBase64(bytes) {
  return encodeBase64(bytesToBinary(bytes))
}

export function base64ToBytes(value) {
  return binaryToBytes(decodeBase64(value))
}

export function bytesToBase64url(bytes) {
  return bytesToBase64(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

export function base64urlToBytes(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  return base64ToBytes(value.replace(/-/g, '+').replace(/_/g, '/') + padding)
}

export function hexToBytes(hex) {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`
  const bytes = new Uint8Array(clean.length / 2)
  for (let index = 0; index < clean.length; index += 2) {
    bytes[index / 2] = Number.parseInt(clean.slice(index, index + 2), 16)
  }
  return bytes
}

export function p1363ToDer(signature) {
  const r = signature.slice(0, 32)
  const s = signature.slice(32, 64)

  function encodeInteger(bytes) {
    let offset = 0
    while (offset < bytes.length - 1 && bytes[offset] === 0) offset += 1
    let trimmed = bytes.slice(offset)
    if (trimmed[0] & 0x80) {
      const prefixed = new Uint8Array(trimmed.length + 1)
      prefixed.set(trimmed, 1)
      trimmed = prefixed
    }
    return trimmed
  }

  const rDer = encodeInteger(r)
  const sDer = encodeInteger(s)
  const inner = new Uint8Array(2 + rDer.length + 2 + sDer.length)
  let index = 0
  inner[index++] = 0x02
  inner[index++] = rDer.length
  inner.set(rDer, index)
  index += rDer.length
  inner[index++] = 0x02
  inner[index++] = sDer.length
  inner.set(sDer, index)

  const der = new Uint8Array(2 + inner.length)
  der[0] = 0x30
  der[1] = inner.length
  der.set(inner, 2)
  return der
}

function derIntToPadded(bytes) {
  let value = bytes
  while (value.length > 1 && value[0] === 0) value = value.slice(1)
  if (value.length > 32) throw new Error('Invalid DER integer length for P-256 signature')
  const padded = new Uint8Array(32)
  padded.set(value, 32 - value.length)
  return padded
}

export function derToP1363(signature) {
  const bytes = signature instanceof Uint8Array ? signature : new Uint8Array(signature)
  if (bytes[0] !== 0x30) throw new Error('Invalid DER signature: expected SEQUENCE')
  let index = 2
  if (bytes[index++] !== 0x02) throw new Error('Invalid DER signature: missing r INTEGER')
  const rLength = bytes[index++]
  const r = derIntToPadded(bytes.slice(index, index + rLength))
  index += rLength
  if (bytes[index++] !== 0x02) throw new Error('Invalid DER signature: missing s INTEGER')
  const sLength = bytes[index++]
  const s = derIntToPadded(bytes.slice(index, index + sLength))
  const out = new Uint8Array(64)
  out.set(r, 0)
  out.set(s, 32)
  return out
}

export async function exportCompressedPubkey(publicKey) {
  const jwk = await requireSubtle().exportKey('jwk', publicKey)
  const x = base64urlToBytes(jwk.x)
  const y = base64urlToBytes(jwk.y)
  const compressed = new Uint8Array(33)
  compressed[0] = y[y.length - 1] & 1 ? 0x03 : 0x02
  compressed.set(x, 1)
  return bytesToBase64url(compressed)
}

export async function importCompressedPubkey(pubkey) {
  const compressed = base64urlToBytes(pubkey)
  const spki = new Uint8Array(COMPRESSED_P256_SPKI_PREFIX.length + compressed.length)
  spki.set(COMPRESSED_P256_SPKI_PREFIX)
  spki.set(compressed, COMPRESSED_P256_SPKI_PREFIX.length)
  return requireSubtle().importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
}

export async function generateKeypair() {
  const keypair = await requireSubtle().generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' },
    true,
    ['sign', 'verify'],
  )

  return {
    privateKey: keypair.privateKey,
    publicKey: keypair.publicKey,
    pubkey: await exportCompressedPubkey(keypair.publicKey),
  }
}

export async function signBytes(privateKey, data) {
  const p1363 = new Uint8Array(
    await requireSubtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, data),
  )
  return bytesToBase64(p1363ToDer(p1363))
}

export async function verifyBytes(publicKey, data, signature) {
  const der = typeof signature === 'string' ? base64ToBytes(signature) : signature
  const p1363 = derToP1363(der)
  return requireSubtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, p1363, data)
}

export async function signItem(item, privateKey) {
  return {
    is: 'instructionGraph001',
    signature: await signBytes(privateKey, textEncoder.encode(canonicalJSON(item))),
    item,
  }
}

export async function verifyItemSignature(envelope) {
  try {
    const publicKey = await importCompressedPubkey(envelope.item.pubkey)
    return await verifyBytes(publicKey, textEncoder.encode(canonicalJSON(envelope.item)), envelope.signature)
  } catch {
    return false
  }
}
