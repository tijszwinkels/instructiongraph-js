/**
 * High-level InstructionGraph client.
 *
 * createClient(opts?) → Client with get/search/inbound/build/sign/publish/create/update/delete
 */

import { sign as cryptoSign } from './crypto.js'
import { buildItem, tombstone, makeRef, isoNow } from './object.js'
import { deriveKeypair, importPEM, createSigner, IDENTITY_UUID, ROOT_REF, IDENTITY_TYPE_DEF } from './identity.js'
import { validateSchema } from './validation.js'

/**
 * Resolve an identity config to { pubkey, privateKey }.
 * @param {import('./types.js').IdentityConfig} config
 * @returns {Promise<{ pubkey: string, privateKey: CryptoKey }|null>}
 */
async function resolveIdentity(config) {
  if (!config) return null

  switch (config.type) {
    case 'credentials':
      return deriveKeypair(config.username, config.password)

    case 'pem':
      return importPEM(config.pem)

    case 'pem-file': {
      const { readFileSync } = await import('node:fs')
      const pem = readFileSync(config.path, 'utf-8')
      return importPEM(pem)
    }

    case 'signer':
      // Already a signer — wrap it
      return { pubkey: config.signer.pubkey, privateKey: null, _signer: config.signer }

    default:
      throw new Error(`Unknown identity type: ${config.type}`)
  }
}

/**
 * Create an InstructionGraph client.
 *
 * @param {import('./types.js').ClientOptions} [opts]
 * @returns {object} Client
 */
export function createClient(opts = {}) {
  const store = opts.store
  // No hardcoded default realm — buildItem defaults to pubkey (private).
  // Pass defaultRealm or in: ['dataverse001'] explicitly for public objects.
  const defaultRealm = opts.defaultRealm || null
  const typeCache = new Map()

  let identity = null // { pubkey, privateKey } or null
  let signer = null // { pubkey, sign } or null

  // Async identity resolution
  const ready = (async () => {
    if (opts.identity) {
      const resolved = await resolveIdentity(opts.identity)
      if (resolved) {
        identity = resolved
        signer = resolved._signer || createSigner(resolved)
      }
    }
  })()

  function requireIdentity() {
    if (!signer) {
      throw new Error('No identity configured — createClient needs an identity for write operations')
    }
  }

  const client = {
    /** Resolves when identity is loaded */
    ready,

    /** The current signer (available after ready) */
    get signer() { return signer },

    /** The current pubkey (available after ready) */
    get pubkey() { return signer?.pubkey || null },

    // ─── Read operations ───────────────────────────

    async get(ref) {
      return store.get(ref)
    },

    async search(query) {
      return store.search(query)
    },

    async inbound(ref, inboundOpts) {
      return store.inbound(ref, inboundOpts)
    },

    // ─── Build (no signing) ────────────────────────

    build(fields) {
      requireIdentity()
      const identityRef = makeRef(signer.pubkey, IDENTITY_UUID)
      return buildItem({
        pubkey: signer.pubkey,
        defaultRealm,
        identityRef,
        ...fields
      })
    },

    // ─── Sign ──────────────────────────────────────

    async sign(item) {
      requireIdentity()
      const signature = await cryptoSign(identity.privateKey, item)
      return { is: 'instructionGraph001', signature, item }
    },

    // ─── Publish ───────────────────────────────────

    async publish(signedObj) {
      const result = await store.put(signedObj)
      return { ...result, ref: signedObj.item.ref }
    },

    // ─── TYPE validation ───────────────────────────

    /**
     * Validate item content against its TYPE schema (if type_def relation exists).
     * Fetches the TYPE object from the store and caches it.
     * Skips silently if no type_def, no schema, or store unavailable.
     * @param {object} item
     */
    async validateType(item) {
      const typeRef = item.relations?.type_def?.[0]?.ref
      if (!typeRef || !store?.get) return

      let typeObj = typeCache.get(typeRef)
      if (typeObj === undefined) {
        typeObj = await store.get(typeRef).catch(() => null)
        typeCache.set(typeRef, typeObj ?? null)
      }

      const schema = typeObj?.item?.content?.schema
      if (!schema) return

      const errors = validateSchema(item.content ?? {}, schema)
      if (errors.length > 0) {
        throw new Error(`TYPE validation failed: ${errors.join('; ')}`)
      }
    },

    // ─── Create (build + validate + sign + publish) ─

    async create(fields) {
      requireIdentity()
      const item = client.build(fields)
      await client.validateType(item)
      const signed = await client.sign(item)
      const result = await client.publish(signed)
      if (!result.ok) throw new Error(`Publish failed: ${result.error || `status ${result.status}`}`)
      return signed.item.ref
    },

    // ─── Update (fetch + merge + sign + publish) ───

    async update(ref, patch) {
      requireIdentity()
      const current = await store.get(ref)
      if (!current?.item) throw new Error(`Object not found: ${ref}`)
      if (current.item.pubkey !== signer.pubkey) throw new Error('Can only update your own objects')

      const orig = current.item
      let updated

      if (typeof patch === 'function') {
        updated = patch(JSON.parse(JSON.stringify(orig)))
        if (!updated) throw new Error('Update callback must return the modified item')
      } else {
        // Merge content
        updated = { ...orig }
        if (patch.content) {
          updated.content = { ...orig.content, ...patch.content }
        }
        if (patch.relations) {
          updated.relations = { ...orig.relations, ...patch.relations }
        }
        if (patch.name !== undefined) updated.name = patch.name
        if (patch.instruction !== undefined) updated.instruction = patch.instruction
      }

      updated.updated_at = isoNow()
      updated.revision = (orig.revision || 0) + 1

      await client.validateType(updated)
      const signed = await client.sign(updated)
      const result = await client.publish(signed)
      if (!result.ok) throw new Error(`Publish failed: ${result.error || `status ${result.status}`}`)
      return signed.item.ref
    },

    // ─── Delete (tombstone) ────────────────────────

    async delete(ref) {
      requireIdentity()
      const current = await store.get(ref)
      if (!current?.item) throw new Error(`Object not found: ${ref}`)
      if (current.item.pubkey !== signer.pubkey) throw new Error('Can only delete your own objects')

      const ts = tombstone(current.item)
      // Tombstone needs our pubkey/ref to be signed correctly
      const signed = await client.sign(ts)
      const result = await client.publish(signed)
      if (!result.ok) throw new Error(`Publish failed: ${result.error || `status ${result.status}`}`)
      return signed.item.ref
    },

    // ─── Identity creation ─────────────────────────

    async createIdentity(identityOpts = {}) {
      requireIdentity()
      const name = identityOpts.name || `Agent-${signer.pubkey.slice(0, 4)}`
      const item = buildItem({
        pubkey: signer.pubkey,
        id: IDENTITY_UUID,
        type: 'IDENTITY',
        instruction: 'Identity object for a dataverse participant. The pubkey field is the compressed raw EC point used to verify signatures. Display name from content.name.',
        content: { name },
        in: ['dataverse001'],  // Identity objects are always public
        relations: {
          root: [{ ref: ROOT_REF }],
          type_def: [{ ref: IDENTITY_TYPE_DEF }]
        }
      })
      const signed = await client.sign(item)
      const result = await client.publish(signed)
      return { ref: signed.item.ref, pubkey: signer.pubkey, ok: result.ok }
    },

    // ─── Hub auth (delegates to store) ─────────────

    async authenticate() {
      requireIdentity()
      if (typeof store.authenticate !== 'function') {
        throw new Error('authenticate() requires a store with an authenticate method (e.g. hub store)')
      }
      return store.authenticate(signer)
    },

    async logout() {
      if (typeof store.logout !== 'function') {
        throw new Error('logout() requires a store with a logout method (e.g. hub store)')
      }
      return store.logout()
    }
  }

  return client
}
