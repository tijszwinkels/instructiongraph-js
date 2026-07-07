/**
 * Pure item mutations behind `ig set` / `ig relate` / `ig unrelate`, plus the
 * relation-shape checks `ig commit` runs. Each function mutates a plain item in
 * place and throws an Error whose message tells the caller exactly what to fix —
 * these messages are read by the LLM, so they name one concrete action.
 */

// A ref is <pubkey>.<uuid>: a base64url key, a dot, then a canonical UUID.
const REF_RE = /^[A-Za-z0-9_-]{20,}\.[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

// Fields that signing manages; `ig set` must never touch them.
const MANAGED_SET_SEGMENTS = new Set(['id', 'ref', 'pubkey', 'revision', 'created_at', 'updated_at', 'signature'])

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** @returns {boolean} whether `ref` has the <pubkey>.<uuid> shape. */
export function isValidRef(ref) {
  return typeof ref === 'string' && REF_RE.test(ref)
}

/** Throw if `ref` is not a well-formed <pubkey>.<uuid>. */
export function assertValidRef(ref) {
  if (!isValidRef(ref)) {
    throw new Error(`malformed ref '${ref}': expected <pubkey>.<uuid> (a key, a dot, then a UUID)`)
  }
}

/** Throw if `path` targets a field `ig set` may not change. */
export function assertSettablePath(path) {
  if (!path || typeof path !== 'string') throw new Error(`invalid path: '${path}'`)
  const segs = path.split('.')
  if (segs.some(s => s === '')) throw new Error(`invalid path '${path}': empty segment`)
  if (segs[0] === 'relations') {
    throw new Error(`use 'ig relate' / 'ig unrelate' to change relations, not 'ig set'`)
  }
  if (MANAGED_SET_SEGMENTS.has(segs[0])) {
    throw new Error(`'${segs[0]}' is set automatically when signing and can't be changed with 'ig set'`)
  }
}

/** Walk to the parent object of the leaf segment. Optionally create missing objects. */
function navigate(item, path, { create }) {
  const segs = path.split('.')
  let node = item
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]
    if (node[s] === undefined) {
      if (!create) return { parent: null, key: segs[segs.length - 1], segs }
      node[s] = {}
    }
    if (!isPlainObject(node[s])) {
      throw new Error(`can't set '${path}': '${segs.slice(0, i + 1).join('.')}' is not an object`)
    }
    node = node[s]
  }
  return { parent: node, key: segs[segs.length - 1], segs }
}

/** Set `item.<path> = value`, creating intermediate objects as needed. */
export function setAtPath(item, path, value) {
  assertSettablePath(path)
  const { parent, key } = navigate(item, path, { create: true })
  parent[key] = value
  return item
}

/** Delete `item.<path>`. Errors if the key is absent (surfaces a state mismatch). */
export function deleteAtPath(item, path) {
  assertSettablePath(path)
  const { parent, key } = navigate(item, path, { create: false })
  if (!parent || !(key in parent)) {
    throw new Error(`can't delete '${path}': it is not set`)
  }
  delete parent[key]
  return item
}

function assertRelatableName(relname) {
  if (relname === 'author') {
    throw new Error(`the 'author' relation is set automatically when signing and can't be changed`)
  }
}

/**
 * Append `{ ref: target, ... }` to `item.relations[relname]`, deduping by ref.
 * When the target is already present: updates its instruction/url if given,
 * otherwise throws "already related" (silent success would hide a mistake).
 */
export function addRelation(item, relname, target, { instruction, url } = {}) {
  assertRelatableName(relname)
  assertValidRef(target)

  item.relations = item.relations || {}
  const arr = item.relations[relname] || (item.relations[relname] = [])
  const existing = arr.find(e => e && e.ref === target)

  if (existing) {
    if (instruction === undefined && url === undefined) {
      throw new Error(`already related: ${item.ref} already has ${relname} → ${target}. ` +
        `Pass --instruction or --url to update it, or 'ig unrelate' to remove it first.`)
    }
    if (instruction !== undefined) existing.instruction = instruction
    if (url !== undefined) existing.url = url
    return { updated: true }
  }

  arr.push({
    ref: target,
    ...(instruction !== undefined ? { instruction } : {}),
    ...(url !== undefined ? { url } : {})
  })
  return { added: true }
}

/**
 * Remove the `target` entry from `item.relations[relname]`. Errors if it isn't
 * there. Drops the relation key entirely when its array empties.
 */
export function removeRelation(item, relname, target) {
  assertRelatableName(relname)
  assertValidRef(target)

  const arr = item.relations?.[relname]
  const idx = arr ? arr.findIndex(e => e && e.ref === target) : -1
  if (idx === -1) {
    throw new Error(`not related: ${item.ref} has no ${relname} → ${target}. Nothing to remove.`)
  }
  arr.splice(idx, 1)
  if (arr.length === 0) delete item.relations[relname]
  return { removed: true }
}

/**
 * Collect malformed-ref errors across every relation entry (commit stage 7).
 * @returns {string[]} one message per malformed ref, with its JSON path.
 */
export function relationRefErrors(item) {
  const errors = []
  for (const [rel, entries] of Object.entries(item.relations || {})) {
    if (!Array.isArray(entries)) continue
    entries.forEach((e, i) => {
      const ref = e && e.ref
      if (!isValidRef(ref)) {
        errors.push(`relations.${rel}[${i}].ref is malformed: expected <pubkey>.<uuid>` +
          (typeof ref === 'string' ? ` (got '${ref}')` : ''))
      }
    })
  }
  return errors
}
