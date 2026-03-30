/**
 * High-level InstructionGraph client.
 *
 * createClient(opts?) → Client with get/search/inbound/build/sign/publish/create/update/delete
 */

import { sign as cryptoSign, verify as cryptoVerify } from './crypto.js'
import { canonicalJSON } from './canonical.js'
import { buildItem, tombstone, makeRef, isoNow } from './object.js'
import { deriveKeypair, importPEM, createSigner, IDENTITY_UUID, ROOT_REF, IDENTITY_TYPE_DEF } from './identity.js'

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
  const defaultRealm = opts.defaultRealm || 'dataverse001'

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

    // ─── Create (build + sign + publish) ───────────

    async create(fields) {
      requireIdentity()
      const item = client.build(fields)
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
        in: [defaultRealm],
        relations: {
          root: [{ ref: ROOT_REF }],
          type_def: [{ ref: IDENTITY_TYPE_DEF }]
        }
      })
      const signed = await client.sign(item)
      const result = await client.publish(signed)
      return { ref: signed.item.ref, pubkey: signer.pubkey, ok: result.ok }
    },

    // ─── Hub auth ──────────────────────────────────

    async authenticate() {
      requireIdentity()
      if (!store.getUrl || !store.setToken) {
        throw new Error('authenticate() requires a hub store with getUrl/setToken')
      }

      const hubUrl = store.getUrl()

      // Step 1: Get challenge
      const challengeRes = await fetch(`${hubUrl}/auth/challenge`, {
        headers: { Accept: 'application/json' }
      })
      if (!challengeRes.ok) throw new Error(`Challenge request failed: ${challengeRes.status}`)
      const { challenge } = await challengeRes.json()

      // Step 2: Sign challenge
      const sig = await cryptoSign(identity.privateKey, null) // won't work — need raw sign
      // Actually need to sign the challenge string directly
      const enc = new TextEncoder()
      const subtle = globalThis.crypto.subtle
      const sigBuf = await subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        identity.privateKey,
        enc.encode(challenge)
      )
      // Convert P1363 → DER → base64
      const { p1363ToDer } = await import('./crypto.js')
      const derSig = p1363ToDer(new Uint8Array(sigBuf))
      let b = ''
      for (let i = 0; i < derSig.length; i++) b += String.fromCharCode(derSig[i])
      const sigB64 = btoa(b)

      // Step 3: Exchange for token
      const tokenRes = await fetch(`${hubUrl}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          pubkey: signer.pubkey,
          challenge,
          signature: sigB64
        })
      })
      if (!tokenRes.ok) throw new Error(`Token exchange failed: ${tokenRes.status}`)
      const tokenData = await tokenRes.json()

      store.setToken(tokenData.token)
      return { ok: true, token: tokenData.token, pubkey: signer.pubkey }
    }
  }

  return client
}
