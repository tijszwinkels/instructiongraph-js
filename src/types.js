/**
 * @typedef {Object} Signer
 * @property {string} pubkey
 * @property {(data: Uint8Array) => Promise<string>} sign
 */

/**
 * @typedef {Object} Envelope
 * @property {'instructionGraph001'} is
 * @property {string} signature
 * @property {object} item
 */

export {}
