/**
 * Hub store — HTTP-based storage backend for instructionGraph hubs.
 * Owns its own authentication state (challenge-response → bearer token).
 * Supports ETag-based conditional requests (revision-based, matching hub server).
 */

import { canonicalJSON } from '../canonical.js'
import { LOCAL_REALM } from './realm-filter.js'

/**
 * Create a hub store.
 * @param {object} opts
 * @param {string} opts.url - Hub base URL (e.g. 'https://dataverse001.net')
 * @param {string} [opts.token] - Bearer token for authenticated requests
 * @returns {import('../types.js').Store}
 */
export function createHubStore({ url, token = null }) {
  const baseUrl = url.replace(/\/$/, '')
  let bearerToken = token

  function headers(extra = {}) {
    const h = { Accept: 'application/json', ...extra }
    if (bearerToken) h.Authorization = `Bearer ${bearerToken}`
    return h
  }

  return {
    /**
     * Set or update the bearer token (e.g. after auth).
     * @param {string|null} t
     */
    setToken(t) { bearerToken = t },

    /** @returns {string|null} */
    getToken() { return bearerToken },

    /** @returns {string} */
    getUrl() { return baseUrl },

    /**
     * Get an object from the hub.
     * @param {string} ref
     * @param {object} [opts]
     * @param {number} [opts.localRevision] - If set, sends If-None-Match ETag.
     *   Returns { _notModified: true } on 304.
     */
    async get(ref, opts = {}) {
      try {
        const h = headers()
        if (opts.localRevision != null) {
          h['If-None-Match'] = `"${opts.localRevision}"`
        }
        const res = await fetch(`${baseUrl}/${ref}`, { headers: h })
        if (res.status === 304) return { _notModified: true }
        if (res.status === 404) return null
        if (!res.ok) {
          console.warn(`[hub] GET /${ref} failed: ${res.status}`)
          return null
        }
        return await res.json()
      } catch (e) {
        console.warn(`[hub] GET /${ref} error: ${e.message}`)
        return null
      }
    },

    async put(signedObj) {
      // Defense-in-depth: local realm objects must NEVER be sent to a hub,
      // regardless of how the caller wired their store.
      const realms = signedObj.item?.in || []
      if (realms.includes(LOCAL_REALM)) {
        console.warn(`[hub] Refusing to upload local-realm object ${signedObj.item?.ref}`)
        return { ok: false, error: 'local-realm objects cannot be uploaded to a hub' }
      }

      const ref = signedObj.item?.ref || `${signedObj.item?.pubkey}.${signedObj.item?.id}`
      try {
        const res = await fetch(`${baseUrl}/${ref}`, {
          method: 'PUT',
          headers: headers({ 'Content-Type': 'application/json' }),
          body: canonicalJSON(signedObj)
        })
        return { ok: res.ok || res.status === 201, status: res.status }
      } catch (e) {
        console.warn(`[hub] PUT /${ref} error: ${e.message}`)
        return { ok: false, error: e.message }
      }
    },

    async search(query = {}) {
      const params = new URLSearchParams()
      if (query.by) params.set('by', query.by)
      if (query.type) params.set('type', query.type)
      if (query.limit) params.set('limit', String(query.limit))
      if (query.cursor) params.set('cursor', query.cursor)
      if (query.includeInboundCounts) params.set('include', 'inbound_counts')

      try {
        const res = await fetch(`${baseUrl}/search?${params}`, { headers: headers() })
        if (!res.ok) {
          console.warn(`[hub] search failed: ${res.status}`)
          return { items: [], cursor: null }
        }
        const data = await res.json()
        return {
          items: data.items || [],
          cursor: data.cursor || null
        }
      } catch (e) {
        console.warn(`[hub] search error: ${e.message}`)
        return { items: [], cursor: null }
      }
    },

    async inbound(ref, opts = {}) {
      const params = new URLSearchParams()
      if (opts.relation) params.set('relation', opts.relation)
      if (opts.from) params.set('from', opts.from)
      if (opts.type) params.set('type', opts.type)
      if (opts.limit) params.set('limit', String(opts.limit))
      if (opts.cursor) params.set('cursor', opts.cursor)
      if (opts.includeInboundCounts) params.set('include', 'inbound_counts')

      try {
        const qs = params.toString()
        const res = await fetch(`${baseUrl}/${ref}/inbound${qs ? '?' + qs : ''}`, { headers: headers() })
        if (!res.ok) {
          console.warn(`[hub] inbound /${ref} failed: ${res.status}`)
          return { items: [], cursor: null }
        }
        const data = await res.json()
        return {
          items: data.items || [],
          cursor: data.cursor || null
        }
      } catch (e) {
        console.warn(`[hub] inbound error: ${e.message}`)
        return { items: [], cursor: null }
      }
    },

    // ─── Authentication ─────────────────────────────

    /**
     * Fetch a challenge from the hub.
     * @returns {Promise<{challenge: string, expires_at: string}>}
     */
    async getChallenge() {
      const res = await fetch(`${baseUrl}/auth/challenge`, {
        headers: { Accept: 'application/json' }
      })
      if (!res.ok) throw new Error(`Challenge request failed: ${res.status}`)
      return res.json()
    },

    /**
     * Authenticate with the hub using a signer's challenge-response.
     * Sets the bearer token on success.
     * @param {import('../types.js').Signer} signer
     * @returns {Promise<{token: string, pubkey: string, expires_at: string}>}
     */
    async authenticate(signer) {
      const { challenge } = await this.getChallenge()
      const enc = new TextEncoder()
      const signature = await signer.sign(enc.encode(challenge))
      const res = await fetch(`${baseUrl}/auth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ pubkey: signer.pubkey, challenge, signature })
      })
      if (!res.ok) throw new Error(`Token exchange failed: ${res.status}`)
      const data = await res.json()
      bearerToken = data.token

      // Fetch shared realm memberships
      let sharedRealms = []
      try {
        const realmsRes = await fetch(`${baseUrl}/auth/realms`, { headers: headers() })
        if (realmsRes.ok) {
          const realmsData = await realmsRes.json()
          sharedRealms = realmsData.realms || []
        }
      } catch { /* best effort */ }

      return { ok: true, sharedRealms, ...data }
    },

    /**
     * Log out and clear the bearer token.
     * @returns {Promise<{ok: boolean}>}
     */
    async logout() {
      try {
        await fetch(`${baseUrl}/auth/logout`, {
          method: 'POST',
          headers: headers()
        })
      } catch { /* best effort */ }
      bearerToken = null
      return { ok: true }
    }
  }
}
