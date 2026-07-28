/**
 * base58 (Bitcoin alphabet) — how Freenet renders contract instance ids.
 *
 * Vendored for the same reason as blake3.js: this package has no runtime
 * dependencies. Byte-at-a-time long division, so no BigInt and no precision
 * limits. Leading zero bytes map to leading '1's, as the standard requires.
 *
 * Pure and browser-safe.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'

const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]))

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function base58Encode(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('base58Encode expects a Uint8Array')
  if (bytes.length === 0) return ''

  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++

  // log(256)/log(58) ≈ 1.365; 138/100 is the usual safe over-estimate.
  const size = Math.ceil(((bytes.length - zeros) * 138) / 100) + 1
  const digits = new Uint8Array(size)
  let length = 0

  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    let j = 0
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 256 * digits[k]
      digits[k] = carry % 58
      carry = (carry / 58) | 0
    }
    length = j
  }

  let out = '1'.repeat(zeros)
  for (let k = size - length; k < size; k++) out += ALPHABET[digits[k]]
  return out
}

/**
 * @param {string} str
 * @returns {Uint8Array}
 */
export function base58Decode(str) {
  if (typeof str !== 'string') throw new TypeError('base58Decode expects a string')
  if (str.length === 0) return new Uint8Array(0)

  let zeros = 0
  while (zeros < str.length && str[zeros] === '1') zeros++

  // log(58)/log(256) ≈ 0.733.
  const size = Math.ceil(((str.length - zeros) * 733) / 1000) + 1
  const bytes = new Uint8Array(size)
  let length = 0

  for (let i = zeros; i < str.length; i++) {
    let carry = INDEX.get(str[i])
    if (carry === undefined) throw new Error(`Invalid base58 character '${str[i]}' at position ${i}`)
    let j = 0
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 58 * bytes[k]
      bytes[k] = carry % 256
      carry = (carry / 256) | 0
    }
    length = j
  }

  const out = new Uint8Array(zeros + length)
  out.set(bytes.subarray(size - length), zeros)
  return out
}
