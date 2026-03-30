import { canonicalJSON } from '../canonical.js'
import { base64urlToBytes, bytesToBase64url, verifyItemSignature } from '../crypto.js'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
}

function parseTimestamp(envelope) {
  const raw = envelope?.item?.updated_at ?? envelope?.item?.created_at
  const date = new Date(raw)
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid timestamp: ${raw}`)
  }
  return date
}

function compareEnvelopes(left, right) {
  const leftTime = parseTimestamp(left).getTime()
  const rightTime = parseTimestamp(right).getTime()
  if (leftTime !== rightTime) return rightTime - leftTime
  return right.item.ref.localeCompare(left.item.ref)
}

function encodeCursor(envelope) {
  return bytesToBase64url(textEncoder.encode(JSON.stringify({
    t: parseTimestamp(envelope).toISOString(),
    ref: envelope.item.ref,
  })))
}

function decodeCursor(cursor) {
  if (!cursor) return null
  try {
    return JSON.parse(textDecoder.decode(base64urlToBytes(cursor)))
  } catch {
    return null
  }
}

function applyCursor(envelopes, cursor) {
  if (!cursor) return envelopes
  const cursorTime = new Date(cursor.t).getTime()
  if (Number.isNaN(cursorTime)) return envelopes

  let index = 0
  while (index < envelopes.length) {
    const envelope = envelopes[index]
    const envelopeTime = parseTimestamp(envelope).getTime()
    if (envelopeTime < cursorTime || (envelopeTime === cursorTime && envelope.item.ref < cursor.ref)) {
      break
    }
    index += 1
  }
  return envelopes.slice(index)
}

function collectInboundCounts(envelopes) {
  const counts = new Map()
  for (const envelope of envelopes) {
    const relations = envelope.item.relations ?? {}
    for (const [relationName, entries] of Object.entries(relations)) {
      for (const entry of entries ?? []) {
        if (!entry?.ref) continue
        if (!counts.has(entry.ref)) counts.set(entry.ref, {})
        const targetCounts = counts.get(entry.ref)
        targetCounts[relationName] = (targetCounts[relationName] ?? 0) + 1
      }
    }
  }
  return counts
}

function addInboundCounts(items, counts) {
  return items.map((item) => {
    const enriched = clone(item)
    enriched._inbound_counts = counts.get(item.item.ref) ?? {}
    return enriched
  })
}

async function loadNodeModules() {
  try {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    return { fs, path }
  } catch (error) {
    throw new Error(`createFsStore is only available in Node.js: ${error.message}`)
  }
}

async function readJsonFile(fs, filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export function createFsStore(options = {}) {
  const { dataDir = './.instructionGraph/data' } = options
  const node = loadNodeModules()

  async function targetPath(ref) {
    const { path } = await node
    return path.join(dataDir, `${ref}.json`)
  }

  async function listEnvelopes() {
    const { fs, path } = await node
    try {
      const entries = await fs.readdir(dataDir, { withFileTypes: true })
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => path.join(dataDir, entry.name))

      const envelopes = []
      for (const file of files) {
        const envelope = await readJsonFile(fs, file)
        if (envelope?.item?.ref) envelopes.push(envelope)
      }
      envelopes.sort(compareEnvelopes)
      return envelopes
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
  }

  return {
    async get(ref) {
      const { fs } = await node
      return readJsonFile(fs, await targetPath(ref))
    },

    async put(signedObject) {
      if (!signedObject?.item?.ref || !signedObject?.item?.pubkey || !signedObject?.item?.id) {
        return { ok: false, status: 400, error: 'missing item.ref, item.pubkey, or item.id' }
      }

      if (!(await verifyItemSignature(signedObject))) {
        return { ok: false, status: 400, error: 'signature verification failed' }
      }

      let timestamp
      try {
        timestamp = parseTimestamp(signedObject)
      } catch (error) {
        return { ok: false, status: 400, error: error.message }
      }

      const { fs, path } = await node
      await fs.mkdir(dataDir, { recursive: true })

      const ref = signedObject.item.ref
      const filePath = await targetPath(ref)
      const existing = await readJsonFile(fs, filePath)
      const incomingRevision = signedObject.item.revision ?? 0
      const existingRevision = existing?.item?.revision ?? null

      if (existing && incomingRevision <= existingRevision) {
        return {
          ok: false,
          status: 409,
          error: `existing revision ${existingRevision} >= incoming ${incomingRevision}`,
        }
      }

      if (existing) {
        const backupDir = path.join(dataDir, 'bk')
        await fs.mkdir(backupDir, { recursive: true })
        await fs.copyFile(filePath, path.join(backupDir, `${ref}.r${existingRevision}.json`))
      }

      await fs.writeFile(filePath, `${canonicalJSON(signedObject)}\n`, 'utf8')
      await fs.utimes(filePath, timestamp, timestamp)

      if (signedObject.item.type === 'DELETED') {
        const backupDir = path.join(dataDir, 'bk')
        try {
          const backups = await fs.readdir(backupDir)
          for (const backup of backups) {
            if (backup.startsWith(`${ref}.r`) && backup.endsWith('.json')) {
              await fs.rm(path.join(backupDir, backup))
            }
          }
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }

      return {
        ok: true,
        status: existing ? 200 : 201,
        object: signedObject,
      }
    },

    async search(query = {}) {
      const all = await listEnvelopes()
      const filtered = all.filter((envelope) => {
        if (query.by && envelope.item.pubkey !== query.by) return false
        if (query.type && envelope.item.type !== query.type) return false
        return true
      })

      const page = applyCursor(filtered, decodeCursor(query.cursor))
      const limit = query.limit ?? 50
      const hasMore = page.length > limit
      const items = page.slice(0, limit)
      const counts = query.includeInboundCounts ? collectInboundCounts(all) : null

      return {
        items: counts ? addInboundCounts(items, counts) : items,
        cursor: hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]) : null,
        hasMore,
      }
    },

    async inbound(ref, query = {}) {
      const all = await listEnvelopes()
      const filtered = all.filter((envelope) => {
        if (query.from && envelope.item.pubkey !== query.from) return false
        if (query.type && envelope.item.type !== query.type) return false

        const relations = envelope.item.relations ?? {}
        for (const [relationName, entries] of Object.entries(relations)) {
          if (query.relation && relationName !== query.relation) continue
          for (const entry of entries ?? []) {
            if (entry?.ref === ref) return true
          }
        }
        return false
      })

      const page = applyCursor(filtered, decodeCursor(query.cursor))
      const limit = query.limit ?? 50
      const hasMore = page.length > limit
      const items = page.slice(0, limit)
      const counts = query.includeInboundCounts ? collectInboundCounts(all) : null

      return {
        items: counts ? addInboundCounts(items, counts) : items,
        cursor: hasMore && items.length > 0 ? encodeCursor(items[items.length - 1]) : null,
        hasMore,
      }
    },
  }
}
