/**
 * Filesystem store — local storage matching shell script conventions.
 * Files: {pubkey}.{id}.json, canonical JSON, mtime set to object timestamp.
 * Backups: bk/{pubkey}.{id}.r{revision}.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, renameSync, utimesSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { canonicalJSON } from '../canonical.js'

/**
 * Create a filesystem store.
 * @param {object} opts
 * @param {string} opts.dataDir - directory for object files
 * @returns {import('../types.js').Store}
 */
export function createFsStore({ dataDir }) {
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

  return {
    async get(ref) {
      return readObj(filePath(ref))
    },

    async put(signedObj) {
      const item = signedObj.item
      const ref = item.ref || `${item.pubkey}.${item.id}`
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

      // Write canonical JSON
      writeFileSync(fp, canonicalJSON(signedObj))
      setMtime(fp, item)
      return { ok: true }
    },

    async search(query = {}) {
      const items = []
      try {
        const files = readdirSync(dataDir).filter(f => f.endsWith('.json'))
        for (const f of files) {
          const obj = readObj(join(dataDir, f))
          if (!obj?.item) continue
          if (query.type && obj.item.type !== query.type) continue
          if (query.by && obj.item.pubkey !== query.by) continue
          items.push(obj)
        }
      } catch { /* empty dir is fine */ }

      // Sort newest first
      items.sort((a, b) => {
        const ta = new Date(b.item.updated_at || b.item.created_at || 0).getTime()
        const tb = new Date(a.item.updated_at || a.item.created_at || 0).getTime()
        return ta - tb
      })

      const limit = query.limit || items.length
      return { items: items.slice(0, limit), cursor: null }
    },

    async inbound(ref, opts = {}) {
      // Scan all files for objects referencing this ref in their relations
      const items = []
      try {
        const files = readdirSync(dataDir).filter(f => f.endsWith('.json'))
        for (const f of files) {
          const raw = readFileSync(join(dataDir, f), 'utf-8')
          if (!raw.includes(ref)) continue // fast pre-filter
          const obj = JSON.parse(raw)
          if (!obj?.item?.relations) continue

          // Check if any relation points to ref
          for (const [relName, entries] of Object.entries(obj.item.relations)) {
            if (opts.relation && relName !== opts.relation) continue
            if (Array.isArray(entries) && entries.some(e => e.ref === ref)) {
              if (opts.type && obj.item.type !== opts.type) continue
              if (opts.from && obj.item.pubkey !== opts.from) continue
              items.push(obj)
              break
            }
          }
        }
      } catch { /* empty dir */ }

      const limit = opts.limit || items.length
      return { items: items.slice(0, limit), cursor: null }
    }
  }
}
