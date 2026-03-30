/**
 * Sync store — combines local + remote, keeps newer revision.
 * Port of transport-hub-read semantics.
 */

/**
 * Create a sync store that reads/writes to both local and remote.
 *
 * On get: fetches from both, keeps higher revision, syncs the other direction.
 * On put: writes to local first, then pushes to remote (non-fatal if remote fails).
 *
 * @param {object} opts
 * @param {import('../types.js').Store} opts.local
 * @param {import('../types.js').Store} opts.remote
 * @returns {import('../types.js').Store}
 */
export function createSyncStore({ local, remote }) {
  return {
    async get(ref) {
      // Fetch from both in parallel
      const [localObj, remoteObj] = await Promise.all([
        local.get(ref).catch(() => null),
        remote.get(ref).catch(() => null)
      ])

      if (!localObj && !remoteObj) return null

      if (!localObj) {
        // Remote only → sync to local
        local.put(remoteObj).catch(e => console.warn(`[sync] local put failed: ${e.message}`))
        return remoteObj
      }

      if (!remoteObj) {
        // Local only → sync to remote
        remote.put(localObj).catch(e => console.warn(`[sync] remote put failed: ${e.message}`))
        return localObj
      }

      // Both exist → compare revisions
      const localRev = localObj.item?.revision || 0
      const remoteRev = remoteObj.item?.revision || 0

      if (remoteRev > localRev) {
        local.put(remoteObj).catch(e => console.warn(`[sync] local put failed: ${e.message}`))
        return remoteObj
      }

      if (localRev > remoteRev) {
        remote.put(localObj).catch(e => console.warn(`[sync] remote put failed: ${e.message}`))
        return localObj
      }

      // Same revision → prefer local (already have it)
      return localObj
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
      // Merge results from both, deduplicate by ref, prefer higher revision
      const [localResult, remoteResult] = await Promise.all([
        local.search(query).catch(() => ({ items: [], cursor: null })),
        remote.search(query).catch(() => ({ items: [], cursor: null }))
      ])

      const byRef = new Map()
      for (const item of [...localResult.items, ...remoteResult.items]) {
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

    async inbound(ref, opts = {}) {
      // Prefer remote for inbound (hub has more data), but merge local
      const [localResult, remoteResult] = await Promise.all([
        local.inbound(ref, opts).catch(() => ({ items: [], cursor: null })),
        remote.inbound(ref, opts).catch(() => ({ items: [], cursor: null }))
      ])

      const byRef = new Map()
      for (const item of [...localResult.items, ...remoteResult.items]) {
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
