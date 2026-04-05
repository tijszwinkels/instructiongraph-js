/**
 * Sync store — combines local (fs) + remote (hub), follows hub proxy semantics.
 *
 * GET:  Hub first (with ETag from local revision). On 304, serve local.
 *       On 200, cache locally. On 404, serve local + push to hub.
 *       On hub error, fall back to local.
 *
 * PUT:  Write local first, then push to hub (non-fatal).
 *
 * SEARCH/INBOUND: Query both, merge results (dedup by ref, higher revision wins).
 *                 Cache all hub results locally.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isVisible, LOCAL_REALM } from './realm-filter.js'

/**
 * Create a sync store that mirrors hub proxy behavior.
 *
 * @param {object} opts
 * @param {import('../types.js').Store} opts.local  - filesystem store
 * @param {import('../types.js').Store} opts.remote - hub store (must support get(ref, {localRevision}))
 * @param {string} [opts.activePubkey] - active identity pubkey for realm filtering
 * @param {string[]} [opts.sharedRealms] - shared realm memberships (loaded from cache)
 * @param {string} [opts.configDir] - config directory for caching shared realms
 * @returns {import('../types.js').Store}
 */
export function createSyncStore({ local, remote, activePubkey = null, sharedRealms = null, configDir = null }) {
  let _sharedRealms = sharedRealms || []
  let _activePubkey = activePubkey

  /** Save shared realm memberships to disk cache. */
  function saveSharedRealms(pubkey, realms) {
    if (!configDir) return
    try {
      mkdirSync(join(configDir, 'config'), { recursive: true })
      writeFileSync(
        join(configDir, 'config', 'shared-realms.json'),
        JSON.stringify({ pubkey, realms, fetched_at: new Date().toISOString() }, null, 2) + '\n'
      )
    } catch (e) {
      console.warn(`[sync] Failed to save shared realms: ${e.message}`)
    }
  }

  /**
   * Check if an object is local-only (has the 'local' realm).
   * Local-realm objects are NEVER pushed to a remote hub.
   */
  function isLocalOnly(obj) {
    const realms = obj?.item?.in || []
    return realms.includes(LOCAL_REALM)
  }

  /**
   * Check if an object has any identity-realm (non-public) realm membership.
   * Identity realms are pubkeys used as realm names — any realm that isn't
   * a well-known public realm like 'dataverse001' or 'local'.
   */
  function hasIdentityRealm(obj) {
    const realms = obj?.item?.in || []
    return realms.some(r => r !== 'dataverse001' && r !== LOCAL_REALM)
  }

  /** Check if we're currently authenticated with the remote. */
  function isAuthenticated() {
    return typeof remote.getToken === 'function' && remote.getToken() != null
  }

  /**
   * Check if an object should be pushed to the remote.
   * Local-realm objects are NEVER pushed.
   * Identity-realm objects are only pushed when authenticated.
   */
  function shouldPushToRemote(obj) {
    if (isLocalOnly(obj)) return false
    if (hasIdentityRealm(obj) && !isAuthenticated()) return false
    return true
  }

  /** Cache a single object locally (fire-and-forget, won't downgrade). */
  function cacheLocally(obj) {
    if (!obj?.item?.ref) return
    local.put(obj).catch(e => console.warn(`[sync] local cache failed: ${e.message}`))
  }

  /** Push a single object to hub (fire-and-forget). Skips identity-realm objects when not authenticated. */
  function pushToRemote(obj) {
    if (!obj?.item?.ref) return
    if (!shouldPushToRemote(obj)) return
    remote.put(obj).catch(e => console.warn(`[sync] remote push failed: ${e.message}`))
  }

  /** Cache an array of objects locally (background, best-effort). */
  function cacheItemsLocally(items) {
    for (const obj of items) {
      if (obj?.item?.ref) cacheLocally(obj)
    }
  }

  /** Apply realm filter to a result before returning to caller. */
  function applyFilter(obj, opts) {
    if (!obj || opts?.skipRealmCheck) return obj
    if (!_activePubkey) return obj  // no identity → no filtering
    return isVisible(obj, _activePubkey, _sharedRealms) ? obj : null
  }

  return {
    async get(ref, opts = {}) {
      // Internal reads skip realm check to get revision for ETag comparison.
      // applyFilter() is called on every return path to enforce visibility.
      let localObj = null
      try { localObj = await local.get(ref, { skipRealmCheck: true }) } catch { /* ok */ }
      const localRev = localObj?.item?.revision

      // Ask hub with ETag (conditional request)
      let remoteResult = null
      try {
        remoteResult = await remote.get(ref, { localRevision: localRev })
      } catch {
        // Hub unreachable — fall back to local
        return applyFilter(localObj, opts)
      }

      // 304 Not Modified — local is current
      if (remoteResult?._notModified) {
        return applyFilter(localObj, opts)
      }

      // Hub returned an object
      if (remoteResult?.item) {
        const remoteRev = remoteResult.item.revision || 0

        if (localObj) {
          const lRev = localObj.item?.revision || 0
          if (remoteRev > lRev) {
            // Hub is newer — cache locally
            cacheLocally(remoteResult)
            return applyFilter(remoteResult, opts)
          }
          if (lRev > remoteRev) {
            // Local is newer — push to hub
            pushToRemote(localObj)
            return applyFilter(localObj, opts)
          }
          // Same revision — prefer local (already have it)
          return applyFilter(localObj, opts)
        }

        // Hub only — cache locally
        cacheLocally(remoteResult)
        return applyFilter(remoteResult, opts)
      }

      // Hub returned null (404) — serve local if we have it, and push
      if (localObj) {
        pushToRemote(localObj)
        return applyFilter(localObj, opts)
      }

      return null
    },

    async put(signedObj) {
      // Local first
      const localResult = await local.put(signedObj)

      // Skip remote push for identity-realm objects when not authenticated
      if (!shouldPushToRemote(signedObj)) {
        return localResult
      }

      // Remote: non-fatal
      try {
        const remoteResult = await remote.put(signedObj)
        if (remoteResult && !remoteResult.ok && remoteResult.status === 403) {
          console.warn(`[sync] Server rejected object (403).`)
        }
      } catch (e) {
        console.warn(`[sync] remote put failed (non-fatal): ${e.message}`)
      }

      return localResult
    },

    async search(query = {}) {
      // Query both in parallel
      const [localResult, remoteResult] = await Promise.all([
        local.search(query).catch(() => ({ items: [], cursor: null })),
        remote.search(query).catch(() => ({ items: [], cursor: null }))
      ])

      // Cache hub results locally (background)
      if (remoteResult.items.length > 0) {
        cacheItemsLocally(remoteResult.items)
      }

      // Merge: dedup by ref, prefer higher revision
      const byRef = new Map()
      for (const item of [...remoteResult.items, ...localResult.items]) {
        const ref = item.item?.ref
        if (!ref) continue
        const existing = byRef.get(ref)
        if (!existing || (item.item.revision || 0) > (existing.item.revision || 0)) {
          byRef.set(ref, item)
        }
      }

      return {
        items: Array.from(byRef.values()),
        cursor: remoteResult.cursor || localResult.cursor || null
      }
    },

    /**
     * Push all local objects to the remote hub.
     * Skips identity-realm objects when not authenticated.
     * @param {object} [opts]
     * @param {string[]} [opts.realms] - Only push objects belonging to at least one of these realms. If omitted, push all (subject to auth gating).
     * @param {(info: {ref: string, index: number, total: number, status: 'ok'|'error'|'skipped', error?: string}) => void} [opts.onProgress]
     * @returns {Promise<{total: number, pushed: number, skipped: number, errors: number}>}
     */
    async pushAll(opts = {}) {
      const { onProgress, realms } = opts
      const allLocal = await local.search({ limit: 100000, skipRealmCheck: true })
      const items = allLocal.items || []
      const total = items.length
      let pushed = 0
      let skipped = 0
      let errors = 0

      const realmSet = realms ? new Set(realms) : null

      for (let i = 0; i < items.length; i++) {
        const obj = items[i]
        const ref = obj.item?.ref
        if (!ref) continue

        // Filter by realm if specified
        if (realmSet) {
          const objRealms = obj.item?.in || []
          if (!objRealms.some(r => realmSet.has(r))) {
            skipped++
            if (onProgress) onProgress({ ref, index: i, total, status: 'skipped' })
            continue
          }
        }

        if (!shouldPushToRemote(obj)) {
          skipped++
          if (onProgress) onProgress({ ref, index: i, total, status: 'skipped' })
          continue
        }

        try {
          await remote.put(obj)
          pushed++
          if (onProgress) onProgress({ ref, index: i, total, status: 'ok' })
        } catch (e) {
          errors++
          if (onProgress) onProgress({ ref, index: i, total, status: 'error', error: e.message })
        }
      }

      return { total, pushed, skipped, errors }
    },

    // ─── Auth: delegate to remote (hub) store ─────────

    async authenticate(signer) {
      if (typeof remote.authenticate !== 'function') {
        throw new Error('Remote store does not support authenticate()')
      }
      const result = await remote.authenticate(signer)
      // Update shared realm cache from auth response
      if (result.sharedRealms) {
        _sharedRealms = result.sharedRealms
        _activePubkey = signer.pubkey
        saveSharedRealms(signer.pubkey, result.sharedRealms)
      }
      return result
    },

    async logout() {
      if (typeof remote.logout !== 'function') {
        throw new Error('Remote store does not support logout()')
      }
      return remote.logout()
    },

    getToken() {
      return typeof remote.getToken === 'function' ? remote.getToken() : null
    },

    /** Get current shared realm memberships. */
    getSharedRealms() {
      return _sharedRealms
    },

    /** Update realm filter context (call after identity is resolved). */
    setRealmContext(pubkey, realms) {
      if (pubkey !== undefined) _activePubkey = pubkey
      if (realms !== undefined) _sharedRealms = realms
    },

    setToken(t) {
      if (typeof remote.setToken === 'function') remote.setToken(t)
    },

    async inbound(ref, opts = {}) {
      // Query both in parallel
      const [localResult, remoteResult] = await Promise.all([
        local.inbound(ref, opts).catch(() => ({ items: [], cursor: null })),
        remote.inbound(ref, opts).catch(() => ({ items: [], cursor: null }))
      ])

      // Cache hub results locally (background)
      if (remoteResult.items.length > 0) {
        cacheItemsLocally(remoteResult.items)
      }

      // Merge: dedup by ref, prefer higher revision
      const byRef = new Map()
      for (const item of [...remoteResult.items, ...localResult.items]) {
        const itemRef = item.item?.ref
        if (!itemRef) continue
        const existing = byRef.get(itemRef)
        if (!existing || (item.item.revision || 0) > (existing.item.revision || 0)) {
          byRef.set(itemRef, item)
        }
      }

      return {
        items: Array.from(byRef.values()),
        cursor: remoteResult.cursor || localResult.cursor || null
      }
    }
  }
}
