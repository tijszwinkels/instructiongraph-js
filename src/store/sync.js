import { base64urlToBytes, bytesToBase64url } from '../crypto.js'

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

function revisionOf(object) {
  return object?.item?.revision ?? 0
}

function timestampOf(object) {
  return new Date(object?.item?.updated_at ?? object?.item?.created_at ?? 0).getTime()
}

function compareObjects(left, right) {
  const leftTime = timestampOf(left)
  const rightTime = timestampOf(right)
  if (leftTime !== rightTime) return rightTime - leftTime
  return right.item.ref.localeCompare(left.item.ref)
}

function pickNewer(left, right) {
  if (!left) return right
  if (!right) return left

  const leftRevision = revisionOf(left)
  const rightRevision = revisionOf(right)
  if (leftRevision !== rightRevision) return leftRevision > rightRevision ? left : right

  const leftTime = timestampOf(left)
  const rightTime = timestampOf(right)
  if (leftTime !== rightTime) return leftTime > rightTime ? left : right

  return left.item.ref >= right.item.ref ? left : right
}

function encodeCursor(object) {
  return bytesToBase64url(textEncoder.encode(JSON.stringify({
    t: new Date(object?.item?.updated_at ?? object?.item?.created_at ?? 0).toISOString(),
    ref: object.item.ref,
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

function applyCursor(items, cursor) {
  if (!cursor) return items
  const cursorTime = new Date(cursor.t).getTime()
  if (Number.isNaN(cursorTime)) return items

  let index = 0
  while (index < items.length) {
    const itemTime = timestampOf(items[index])
    if (itemTime < cursorTime || (itemTime === cursorTime && items[index].item.ref < cursor.ref)) {
      break
    }
    index += 1
  }

  return items.slice(index)
}

async function safeGet(store, ref) {
  try {
    return await store.get(ref)
  } catch {
    return null
  }
}

async function safePut(store, object) {
  try {
    return await store.put(object)
  } catch (error) {
    return { ok: false, status: 0, error: error.message }
  }
}

async function safeList(method, store, ...args) {
  try {
    return await store[method](...args)
  } catch {
    return { items: [], cursor: null, hasMore: false }
  }
}

function mergeItems(...collections) {
  const merged = new Map()
  for (const collection of collections) {
    for (const item of collection ?? []) {
      merged.set(item.item.ref, pickNewer(merged.get(item.item.ref), item))
    }
  }
  return [...merged.values()].sort(compareObjects)
}

export function createSyncStore({ local, remote }) {
  if (!local || !remote) throw new Error('createSyncStore requires both local and remote stores')

  return {
    async get(ref) {
      const [localObject, remoteObject] = await Promise.all([
        safeGet(local, ref),
        safeGet(remote, ref),
      ])

      const newer = pickNewer(localObject, remoteObject)
      if (!newer) return null

      if (newer === localObject && (!remoteObject || newer !== remoteObject)) {
        await safePut(remote, newer)
      }
      if (newer === remoteObject && (!localObject || newer !== localObject)) {
        await safePut(local, newer)
      }

      return newer
    },

    async put(object) {
      const localResult = await safePut(local, object)
      if (!localResult.ok) return localResult

      const remoteResult = await safePut(remote, object)
      return {
        ...localResult,
        remote: remoteResult,
      }
    },

    async search(query = {}) {
      const fanoutLimit = Math.max(query.limit ?? 50, 200)
      const [localResult, remoteResult] = await Promise.all([
        safeList('search', local, { ...query, limit: fanoutLimit, cursor: undefined }),
        safeList('search', remote, { ...query, limit: fanoutLimit, cursor: undefined }),
      ])

      const merged = applyCursor(mergeItems(localResult.items, remoteResult.items), decodeCursor(query.cursor))
      const limit = query.limit ?? 50
      const items = merged.slice(0, limit)

      return {
        items,
        cursor: merged.length > limit && items.length > 0 ? encodeCursor(items[items.length - 1]) : null,
        hasMore: merged.length > limit,
      }
    },

    async inbound(ref, query = {}) {
      const fanoutLimit = Math.max(query.limit ?? 50, 200)
      const [localResult, remoteResult] = await Promise.all([
        safeList('inbound', local, ref, { ...query, limit: fanoutLimit, cursor: undefined }),
        safeList('inbound', remote, ref, { ...query, limit: fanoutLimit, cursor: undefined }),
      ])

      const merged = applyCursor(mergeItems(localResult.items, remoteResult.items), decodeCursor(query.cursor))
      const limit = query.limit ?? 50
      const items = merged.slice(0, limit)

      return {
        items,
        cursor: merged.length > limit && items.length > 0 ? encodeCursor(items[items.length - 1]) : null,
        hasMore: merged.length > limit,
      }
    },
  }
}
