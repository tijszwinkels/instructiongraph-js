/**
 * Sync store — combines local (fs) + remote (hub), follows hub proxy semantics.
 *
 * GET:  Hub first, comparing signed items as well as revision numbers.
 *       On 200, cache locally. On 404, serve local + push to hub.
 *       On connectivity errors, fall back to local; conflicts remain errors.
 *
 * PUT:  Write local first, then push to hub. Conflicts fail; offline edits stay local.
 *
 * SEARCH/INBOUND: Merge by ref and revision; equal-revision divergence fails.
 *                 Cache complete signed hub objects, never BLOB projections.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isVisible, LOCAL_REALM, SERVER_PUBLIC_REALM } from './realm-filter.js'
import { sameItem, isRevisionConflict, RevisionConflictError } from './conflict.js'

/**
 * Create a sync store that mirrors hub proxy behavior.
 *
 * @param {object} opts
 * @param {import('../types.js').Store} opts.local  - filesystem store
 * @param {import('../types.js').Store} opts.remote - hub store
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
    return realms.some(r => r !== 'dataverse001' && r !== LOCAL_REALM && r !== SERVER_PUBLIC_REALM)
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

  /** Await caching so conflicts and storage failures reach the caller. */
  async function cacheLocally(obj) {
    if (!obj?.item?.ref) return
    const result = await local.put(obj)
    if (!result.ok) {
      if (result.code === 'REVISION_CONFLICT') {
        throw new RevisionConflictError(await local.get(obj.item.ref), obj, result.conflictPath)
      }
      throw new Error(`Local cache failed for ${obj.item.ref}: ${result.error}`)
    }
  }

  /** Push a single object to hub (fire-and-forget). Skips identity-realm objects when not authenticated. */
  function pushToRemote(obj) {
    if (!obj?.item?.ref) return
    if (!shouldPushToRemote(obj)) return
    remote.put(obj).then(result => {
      if (!result.ok) console.warn(`[sync] remote rejected ${obj.item.ref}: ${result.error || `HTTP ${result.status}`}; local edit retained`)
    }).catch(e => console.warn(`[sync] remote push failed: ${e.message}`))
  }

  async function checkConflict(localObj, incoming) {
    if (localObj && (localObj.item.revision || 0) === (incoming.item.revision || 0) && !sameItem(localObj, incoming)) {
      const path = await local.preserveConflict?.(incoming)
      throw new RevisionConflictError(localObj, incoming, path)
    }
  }

  /** Use one reconciliation rule for search and inbound, including off-page local copies. */
  async function mergeResults(localResult, remoteResult, opts) {
    const byRef = new Map()
    for (const incoming of remoteResult.items) {
      const ref = incoming.item?.ref
      if (!ref || !applyFilter(incoming, opts)) continue
      const localObj = applyFilter(await local.get(ref), opts)
      // Hub list responses omit BLOB data/text. They are projections, not
      // independently verifiable envelopes, and must never replace cached data.
      if (incoming.item.type === 'BLOB' && incoming.item.content &&
          !('data' in incoming.item.content) && !('text' in incoming.item.content)) {
        if (localObj && (localObj.item.revision || 0) === (incoming.item.revision || 0) &&
            localObj.signature !== incoming.signature) {
          const full = applyFilter(await remote.get(ref), opts)
          if (!full) throw new Error(`Cannot compare BLOB revision for ${ref}: full object unavailable`)
          await checkConflict(localObj, full)
        }
        if (!localObj || (incoming.item.revision || 0) >= (localObj.item.revision || 0)) byRef.set(ref, incoming)
        continue
      }
      await checkConflict(localObj, incoming)
      if (!localObj || (incoming.item.revision || 0) > (localObj.item.revision || 0)) {
        await cacheLocally(incoming)
        byRef.set(ref, incoming)
      } else if (sameItem(localObj, incoming)) {
        byRef.set(ref, { ...incoming, item: localObj.item, signature: localObj.signature })
      }
    }
    for (const obj of localResult.items) {
      const ref = obj.item?.ref
      if (!ref || !applyFilter(obj, opts)) continue
      const existing = byRef.get(ref)
      if (!existing || (obj.item.revision || 0) > (existing.item.revision || 0)) byRef.set(ref, obj)
    }
    return { items: [...byRef.values()], cursor: remoteResult.cursor || localResult.cursor || null }
  }

  /** Apply realm filter to a result before returning to caller. */
  function applyFilter(obj, opts) {
    if (!obj || opts?.skipRealmCheck) return obj
    if (!_activePubkey) return obj  // no identity → no filtering
    return isVisible(obj, _activePubkey, _sharedRealms) ? obj : null
  }

  return {
    async get(ref, opts = {}) {
      if (opts.source === 'local') return applyFilter(await local.get(ref, opts), opts)
      if (opts.source === 'remote') return applyFilter(await remote.get(ref), opts)
      // Read the local candidate, then enforce visibility before comparison.
      let localObj = null
      try { localObj = await local.get(ref, { skipRealmCheck: true }) } catch { /* ok */ }

      // Revision-only ETags cannot distinguish independent edits at the same
      // revision. Fetch the item until content-based validators are supported.
      let remoteResult = null
      try {
        remoteResult = await remote.get(ref)
      } catch (e) {
        if (isRevisionConflict(e)) throw e
        // Hub unreachable — fall back to local
        process.stderr.write(`⚠ Hub get failed: ${e.message} — using local copy\n`)
        return applyFilter(localObj, opts)
      }

      // 304 Not Modified — local is current
      if (remoteResult?._notModified) {
        return applyFilter(localObj, opts)
      }

      // Hub returned an object
      if (remoteResult?.item) {
        localObj = applyFilter(localObj, opts)
        remoteResult = applyFilter(remoteResult, opts)
        if (!remoteResult) return localObj
        await checkConflict(localObj, remoteResult)
        const remoteRev = remoteResult.item.revision || 0

        if (localObj) {
          const lRev = localObj.item?.revision || 0
          if (remoteRev > lRev) {
            // Hub is newer — cache locally
            await cacheLocally(remoteResult)
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
        await cacheLocally(remoteResult)
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
      if (!localResult.ok) return { ...localResult, _remoteOk: false, _remoteError: 'Local write rejected; remote push skipped' }

      // Skip remote push for identity-realm objects when not authenticated
      if (!shouldPushToRemote(signedObj)) {
        const reason = isLocalOnly(signedObj)
          ? 'local-realm objects are never pushed'
          : 'not authenticated for identity realm'
        return { ...localResult, _remoteOk: false, _remoteError: reason }
      }

      // Remote push — surface failures visibly
      let remoteResult = null
      try {
        remoteResult = await remote.put(signedObj)
      } catch (e) {
        const ref = signedObj.item?.ref || '?'
        process.stderr.write(`⚠ Hub push failed for ${ref}: ${e.message}\n`)
        if (!isRevisionConflict(e)) return { ...localResult, _remoteOk: false, _remoteError: e.message }
        remoteResult = { ok: false, status: e.status || 409, code: 'REVISION_CONFLICT', error: e.message }
      }

      if (remoteResult && !remoteResult.ok) {
        const ref = signedObj.item?.ref || '?'
        const reason = remoteResult.error || `HTTP ${remoteResult.status}`
        process.stderr.write(`⚠ Hub rejected ${ref}: ${reason}\n`)
        const conflict = isRevisionConflict(remoteResult)
        return { ...localResult, ...(conflict ? {
          ok: false, status: remoteResult.status, code: 'REVISION_CONFLICT',
          error: `${reason}; local edit retained for ${ref}. Fetch both versions before resolving.`,
        } : {}), _remoteOk: false, _remoteError: reason }
      }

      return { ...localResult, _remoteOk: true }
    },

    async search(query = {}) {
      // Support --local / --remote source filtering
      const source = query.source || 'both'
      const _query = { ...query }
      delete _query.source

      if (source === 'local') {
        return local.search(_query)
      }
      if (source === 'remote') {
        try {
          return await remote.search(_query)
        } catch (e) {
          if (isRevisionConflict(e)) throw e
          throw new Error(`Hub search failed: ${e.message}`)
        }
      }

      // Query both in parallel
      const [localResult, remoteResult] = await Promise.all([
        local.search(_query).catch((e) => {
          process.stderr.write(`⚠ Local search error: ${e.message}\n`)
          return { items: [], cursor: null }
        }),
        remote.search(_query).catch((e) => {
          if (isRevisionConflict(e)) throw e
          process.stderr.write(`⚠ Hub search failed: ${e.message} — showing local results only\n`)
          return { items: [], cursor: null }
        })
      ])

      return mergeResults(localResult, remoteResult, _query)
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
          const result = await remote.put(obj)
          if (!result.ok) throw new Error(result.error || `HTTP ${result.status}`)
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
      // Support --local / --remote source filtering
      const source = opts.source || 'both'
      const _opts = { ...opts }
      delete _opts.source

      if (source === 'local') {
        return local.inbound(ref, _opts)
      }
      if (source === 'remote') {
        try {
          return await remote.inbound(ref, _opts)
        } catch (e) {
          if (isRevisionConflict(e)) throw e
          throw new Error(`Hub inbound failed: ${e.message}`)
        }
      }

      // Query both in parallel
      const [localResult, remoteResult] = await Promise.all([
        local.inbound(ref, _opts).catch((e) => {
          process.stderr.write(`⚠ Local inbound error: ${e.message}\n`)
          return { items: [], cursor: null }
        }),
        remote.inbound(ref, _opts).catch((e) => {
          if (isRevisionConflict(e)) throw e
          process.stderr.write(`⚠ Hub inbound failed: ${e.message} — showing local results only\n`)
          return { items: [], cursor: null }
        })
      ])

      return mergeResults(localResult, remoteResult, _opts)
    }
  }
}
