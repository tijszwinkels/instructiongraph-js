/**
 * @instructiongraph/ig — JavaScript library for InstructionGraph hubs.
 *
 * Zero-dependency, ESM, works in browsers and Node.js 18+.
 */

// High-level
export { createClient } from './client.js'

// Stores
export { createHubStore } from './store/hub.js'
export { createSyncStore } from './store/sync.js'
// fs store is Node-only, import separately: import { createFsStore } from '@instructiongraph/ig/store/fs'

// Protocol primitives
export { canonicalJSON } from './canonical.js'
export { sign, verify, generateKeypair, exportCompressedPubkey, p1363ToDer, base64urlEncode, base64urlDecode } from './crypto.js'
export { buildItem, tombstone, parseRef, makeRef, isEnvelope, isoNow } from './object.js'
export { deriveKeypair, importPEM, createSigner, IDENTITY_UUID, ROOT_REF, IDENTITY_TYPE_DEF } from './identity.js'
