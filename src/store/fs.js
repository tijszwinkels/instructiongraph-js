/**
 * Filesystem store — local storage matching shell script conventions.
 * Files: {pubkey}.{id}.json, canonical JSON + trailing newline, mtime set to object timestamp.
 * Backups: bk/{pubkey}.{id}.r{revision}.json
 *
 * Verifies signatures on put (rejects tampered objects).
 * Supports cursor-based pagination for search/inbound.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, utimesSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJSON } from '../canonical.js'
import { verify } from '../crypto.js'

// ─── Cursor helpers ──────────────────────────────────────────────

function objectTimestamp(obj) {
  return new Date(obj.item.updated_at || obj.item.created_at || 0).getTime()
}

/** Encode a cursor from the last item in a page. */
function encodeCursor(obj) {
  return Buffer.from(JSON.stringify({
    t: new Date(objectTimestamp(obj)).toISOString(),
    ref: obj.item.ref
  })).toString('base64url')
}

/** Decode a cursor string → { t, ref } or null. */
function decodeCursor(cursor) {
  if (!cursor) return null
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString())
  } catch {
    return null
  }
}

/** Skip items until we pass the cursor position. */
function applyCursor(items, cursor) {
  if (!cursor) return items
  const cursorTime = new Date(cursor.t).getTime()
  if (isNaN(cursorTime)) return items

  let i = 0
  while (i < items.length) {
    const t = objectTimestamp(items[i])
    if (t < cursorTime || (t === cursorTime && items[i].item.ref < cursor.ref)) break
    i++
  }
  return items.slice(i)
}

// ─── Store ───────────────────────────────────────────────────────

/**
 * Create a filesystem store.
 * @param {object} opts
 * @param {string} opts.dataDir - directory for object files
 * @returns {import('../types.js').Store}
 */
export function createFsStore({ dataDir, filter = null }) {
  mkdirSync(dataDir, { recursive: true })

  function filePath(ref) {
    return join(dataDir, `${ref}.json`)
  }

  function setMtime(filepath, item) {
    const ts = item.updated_at || item.created_at
    if (ts) {
      const d = new Date(ts)
      utimesSync(filepath, d, d)
    }
  }

  function readObj(filepath) {
    try {
      return JSON.parse(readFileSync(filepath, 'utf-8'))
    } catch {
      return null
    }
  }

  function backup(ref, revision) {
    const bkDir = join(dataDir, 'bk')
    mkdirSync(bkDir, { recursive: true })
    const src = filePath(ref)
    const dst = join(bkDir, `${ref}.r${revision || 0}.json`)
    renameSync(src, dst)
  }

  /** Read and filter all envelopes, sorted newest-first. */
  function listAll() {
    const items = []
    try {
      const files = readdirSync(dataDir).filter(f => f.endsWith('.json'))
      for (const f of files) {
        const obj = readObj(join(dataDir, f))
        if (obj?.item) items.push(obj)
      }
    } catch { /* empty dir */ }
    items.sort((a, b) => objectTimestamp(b) - objectTimestamp(a))
    return items
  }

  /** Paginate a sorted array of items. */
  function paginate(items, query) {
    const page = applyCursor(items, decodeCursor(query.cursor))
    const limit = query.limit || 50
    const sliced = page.slice(0, limit)
    const hasMore = page.length > limit
    return {
      items: sliced,
      cursor: hasMore && sliced.length > 0 ? encodeCursor(sliced[sliced.length - 1]) : null
    }
  }

  return {
    async get(ref, opts = {}) {
      const obj = readObj(filePath(ref))
      if (obj && filter && !opts.skipRealmCheck && !filter(obj)) return null
      return obj
    },

    async put(signedObj) {
      const item = signedObj.item
      if (!item?.ref || !item?.pubkey || !item?.id) {
        return { ok: false, error: 'missing item.ref, item.pubkey, or item.id' }
      }

      // Verify signature before storing
      const valid = await verify(item.pubkey, signedObj.signature, item)
      if (!valid) {
        return { ok: false, error: 'signature verification failed' }
      }

      const ref = item.ref
      const fp = filePath(ref)

      // Check existing revision
      if (existsSync(fp)) {
        const existing = readObj(fp)
        if (existing) {
          const existingRev = existing.item?.revision || 0
          const newRev = item.revision || 0
          if (newRev < existingRev) {
            return { ok: false, error: `Existing revision ${existingRev} > incoming ${newRev}` }
          }
          if (newRev === existingRev && canonicalJSON(existing) === canonicalJSON(signedObj)) {
            return { ok: true } // identical, no-op
          }
          // Backup old version
          backup(ref, existingRev)
        }
      }

      // Handle DELETED tombstone: purge backups
      if (item.type === 'DELETED') {
        const bkDir = join(dataDir, 'bk')
        if (existsSync(bkDir)) {
          try {
            const files = readdirSync(bkDir).filter(f => f.startsWith(ref))
            for (const f of files) unlinkSync(join(bkDir, f))
          } catch { /* best effort */ }
        }
      }

      // Write canonical JSON with trailing newline (matches shell store)
      writeFileSync(fp, canonicalJSON(signedObj) + '\n')
      setMtime(fp, item)
      return { ok: true }
    },

    async search(query = {}) {
      const all = listAll()
      const filtered = all.filter(obj => {
        if (filter && !query.skipRealmCheck && !filter(obj)) return false
        if (query.type && obj.item.type !== query.type) return false
        if (query.by && obj.item.pubkey !== query.by) return false
        return true
      })
      return paginate(filtered, query)
    },

    async inbound(ref, opts = {}) {
      const all = listAll()
      const filtered = all.filter(obj => {
        if (!obj.item?.relations) return false
        if (filter && !opts.skipRealmCheck && !filter(obj)) return false
        if (opts.type && obj.item.type !== opts.type) return false
        if (opts.from && obj.item.pubkey !== opts.from) return false

        for (const [relName, entries] of Object.entries(obj.item.relations)) {
          if (opts.relation && relName !== opts.relation) continue
          if (Array.isArray(entries) && entries.some(e => e.ref === ref)) return true
        }
        return false
      })
      return paginate(filtered, opts)
    }
  }
}
