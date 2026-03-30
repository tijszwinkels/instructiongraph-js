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

/**
 * Create a sync store that mirrors hub proxy behavior.
 *
 * @param {object} opts
 * @param {import('../types.js').Store} opts.local  - filesystem store
 * @param {import('../types.js').Store} opts.remote - hub store (must support get(ref, {localRevision}))
 * @returns {import('../types.js').Store}
 */
export function createSyncStore({ local, remote }) {

  /** Cache a single object locally (fire-and-forget, won't downgrade). */
  function cacheLocally(obj) {
    if (!obj?.item?.ref) return
    local.put(obj).catch(e => console.warn(`[sync] local cache failed: ${e.message}`))
  }

  /** Push a single object to hub (fire-and-forget). */
  function pushToRemote(obj) {
    if (!obj?.item?.ref) return
    remote.put(obj).catch(e => console.warn(`[sync] remote push failed: ${e.message}`))
  }

  /** Cache an array of objects locally (background, best-effort). */
  function cacheItemsLocally(items) {
    for (const obj of items) {
      if (obj?.item?.ref) cacheLocally(obj)
    }
  }

  return {
    async get(ref) {
      // Get local revision for ETag
      let localObj = null
      try { localObj = await local.get(ref) } catch { /* ok */ }
      const localRev = localObj?.item?.revision

      // Ask hub with ETag (conditional request)
      let remoteResult = null
      try {
        remoteResult = await remote.get(ref, { localRevision: localRev })
      } catch {
        // Hub unreachable — fall back to local
        return localObj
      }

      // 304 Not Modified — local is current
      if (remoteResult?._notModified) {
        return localObj
      }

      // Hub returned an object
      if (remoteResult?.item) {
        const remoteRev = remoteResult.item.revision || 0

        if (localObj) {
          const lRev = localObj.item?.revision || 0
          if (remoteRev > lRev) {
            // Hub is newer — cache locally
            cacheLocally(remoteResult)
            return remoteResult
          }
          if (lRev > remoteRev) {
            // Local is newer — push to hub
            pushToRemote(localObj)
            return localObj
          }
          // Same revision — prefer local (already have it)
          return localObj
        }

        // Hub only — cache locally
        cacheLocally(remoteResult)
        return remoteResult
      }

      // Hub returned null (404) — serve local if we have it, and push
      if (localObj) {
        pushToRemote(localObj)
        return localObj
      }

      return null
    },

    async put(signedObj) {
      // Local first
      const localResult = await local.put(signedObj)

      // Remote: non-fatal
      try {
        await remote.put(signedObj)
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
     * @param {object} [opts]
     * @param {(info: {ref: string, index: number, total: number, status: 'ok'|'error', error?: string}) => void} [opts.onProgress]
     * @returns {Promise<{total: number, pushed: number, errors: number}>}
     */
    async pushAll(opts = {}) {
      const { onProgress } = opts
      const localResult = await local.search({ limit: 100000 })
      const items = localResult.items || []
      let pushed = 0
      let errors = 0

      for (let i = 0; i < items.length; i++) {
        const obj = items[i]
        const ref = obj.item?.ref
        if (!ref) continue

        try {
          await remote.put(obj)
          pushed++
          if (onProgress) onProgress({ ref, index: i, total: items.length, status: 'ok' })
        } catch (e) {
          errors++
          if (onProgress) onProgress({ ref, index: i, total: items.length, status: 'error', error: e.message })
        }
      }

      return { total: items.length, pushed, errors }
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
