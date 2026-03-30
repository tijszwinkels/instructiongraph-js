/**
 * Shared encoding helpers: base64, base64url, bigint ↔ bytes.
 */

/** @param {Uint8Array} bytes @returns {string} base64url (no padding) */
export function base64urlEncode(bytes) {
  let b = ''
  for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i])
  return btoa(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** @param {string} s @returns {Uint8Array} */
export function base64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** @param {Uint8Array} bytes @returns {string} standard base64 */
export function bytesToBase64(bytes) {
  let b = ''
  for (let i = 0; i < bytes.length; i++) b += String.fromCharCode(bytes[i])
  return btoa(b)
}

/** @param {string} s standard base64 @returns {Uint8Array} */
export function base64Decode(s) {
  const bin = atob(s)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** @param {Uint8Array} bytes @returns {bigint} */
export function bytesToBigInt(bytes) {
  let h = '0x'
  for (let i = 0; i < bytes.length; i++) h += bytes[i].toString(16).padStart(2, '0')
  return BigInt(h)
}

/** @param {bigint} n @param {number} len @returns {Uint8Array} */
export function bigIntToBytes(n, len) {
  const hex = n.toString(16).padStart(len * 2, '0')
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16)
  return bytes
}
