/**
 * BLAKE3 + base58 — the two primitives Freenet contract addressing needs and
 * Node's stdlib doesn't provide.
 *
 * BLAKE3 is checked against the OFFICIAL test vectors from the BLAKE3
 * reference repository (test_vectors/test_vectors.json, retrieved 2026-07-28
 * from https://raw.githubusercontent.com/BLAKE3-team/BLAKE3/master/test_vectors/test_vectors.json).
 * The subset kept below spans every structural boundary of the algorithm:
 * empty, sub-block, exact block (64), chunk boundaries (1023/1024/1025), and
 * multi-level merkle trees up to 102400 bytes.
 *
 * Per those vectors, input of length N is the repeating 251-byte pattern
 * 0, 1, 2, ..., 250, 0, 1, ...
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { blake3 } from '../src/freenet/blake3.js'
import { base58Encode, base58Decode } from '../src/freenet/base58.js'

/** The official vectors' input generator: repeating 0..250. */
function patternInput(len) {
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) out[i] = i % 251
  return out
}

const toHex = (bytes) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')

// [input_len, expected 256-bit hash]
const VECTORS = [
  [0, 'af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262'],
  [1, '2d3adedff11b61f14c886e35afa036736dcd87a74d27b5c1510225d0f592e213'],
  [2, '7b7015bb92cf0b318037702a6cdd81dee41224f734684c2c122cd6359cb1ee63'],
  [3, 'e1be4d7a8ab5560aa4199eea339849ba8e293d55ca0a81006726d184519e647f'],
  [63, 'e9bc37a594daad83be9470df7f7b3798297c3d834ce80ba85d6e207627b7db7b'],
  [64, '4eed7141ea4a5cd4b788606bd23f46e212af9cacebacdc7d1f4c6dc7f2511b98'],
  [65, 'de1e5fa0be70df6d2be8fffd0e99ceaa8eb6e8c93a63f2d8d1c30ecb6b263dee'],
  [127, 'd81293fda863f008c09e92fc382a81f5a0b4a1251cba1634016a0f86a6bd640d'],
  [128, 'f17e570564b26578c33bb7f44643f539624b05df1a76c81f30acd548c44b45ef'],
  [129, '683aaae9f3c5ba37eaaf072aed0f9e30bac0865137bae68b1fde4ca2aebdcb12'],
  [1023, '10108970eeda3eb932baac1428c7a2163b0e924c9a9e25b35bba72b28f70bd11'],
  [1024, '42214739f095a406f3fc83deb889744ac00df831c10daa55189b5d121c855af7'],
  [1025, 'd00278ae47eb27b34faecf67b4fe263f82d5412916c1ffd97c8cb7fb814b8444'],
  [2048, 'e776b6028c7cd22a4d0ba182a8bf62205d2ef576467e838ed6f2529b85fba24a'],
  [2049, '5f4d72f40d7a5f82b15ca2b2e44b1de3c2ef86c426c95c1af0b6879522563030'],
  [3072, 'b98cb0ff3623be03326b373de6b9095218513e64f1ee2edd2525c7ad1e5cffd2'],
  [4096, '015094013f57a5277b59d8475c0501042c0b642e531b0a1c8f58d2163229e969'],
  [4097, '9b4052b38f1c5fc8b1f9ff7ac7b27cd242487b3d890d15c96a1c25b8aa0fb995'],
  [8192, 'aae792484c8efe4f19e2ca7d371d8c467ffb10748d8a5a1ae579948f718a2a63'],
  [8193, 'bab6c09cb8ce8cf459261398d2e7aef35700bf488116ceb94a36d0f5f1b7bc3b'],
  [16384, 'f875d6646de28985646f34ee13be9a576fd515f76b5b0a26bb324735041ddde4'],
  [31744, '62b6960e1a44bcc1eb1a611a8d6235b6b4b78f32e7abc4fb4c6cdcce94895c47'],
  [102400, 'bc3e3d41a1146b069abffad3c0d44860cf664390afce4d9661f7902e7943e085'],
]

test('blake3 matches the official BLAKE3 test vectors', () => {
  for (const [len, expected] of VECTORS) {
    assert.equal(toHex(blake3(patternInput(len))), expected, `input_len ${len}`)
  }
})

test('blake3 returns 32 bytes as a Uint8Array', () => {
  const h = blake3(new Uint8Array(0))
  assert.ok(h instanceof Uint8Array)
  assert.equal(h.length, 32)
})

test('blake3 accepts concatenated input the same as a single buffer', () => {
  // Address derivation always hashes code_hash ‖ params; guard the join.
  const a = patternInput(32)
  const b = patternInput(40)
  const joined = new Uint8Array(a.length + b.length)
  joined.set(a, 0)
  joined.set(b, a.length)
  assert.equal(toHex(blake3(joined)).length, 64)
  assert.notEqual(toHex(blake3(joined)), toHex(blake3(a)))
})

test('base58 encodes the Bitcoin alphabet without 0OIl', () => {
  // Vectors from the Bitcoin base58 spec (no checksum, raw payload).
  assert.equal(base58Encode(new Uint8Array([])), '')
  assert.equal(base58Encode(new Uint8Array([0])), '1')
  assert.equal(base58Encode(new Uint8Array([0, 0, 1])), '112')
  assert.equal(base58Encode(new TextEncoder().encode('Hello World!')), '2NEpo7TZRRrLZSi2U')
  assert.equal(
    base58Encode(new TextEncoder().encode('The quick brown fox jumps over the lazy dog.')),
    'USm3fpXnKG5EUBx2ndxBDMPVciP5hGey2Jh4NDv6gmeo1LkMeiKrLJUUBk6Z',
  )
})

test('base58 round-trips arbitrary bytes, leading zeros included', () => {
  const cases = [
    new Uint8Array([]),
    new Uint8Array([0, 0, 0, 5, 200, 255]),
    patternInput(32),
    new Uint8Array(32), // all zeros
  ]
  for (const bytes of cases) {
    assert.deepEqual(base58Decode(base58Encode(bytes)), bytes)
  }
})

test('base58Decode rejects characters outside the alphabet', () => {
  assert.throws(() => base58Decode('abc0def'), /base58/i)
  assert.throws(() => base58Decode('OIl'), /base58/i)
})
