const DEFAULT_REALM = 'dataverse001'

export function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

export function makeRef({ pubkey, id }) {
  return `${pubkey}.${id}`
}

export function parseRef(ref) {
  const dot = ref.indexOf('.')
  if (dot === -1) throw new Error(`Invalid ref: ${ref}`)
  return {
    pubkey: ref.slice(0, dot),
    id: ref.slice(dot + 1),
  }
}

export function isEnvelope(value) {
  return Boolean(value && value.is === 'instructionGraph001' && value.item && typeof value.signature === 'string')
}

export function buildItem(fields, options = {}) {
  const now = options.now ?? isoNow()
  const item = {
    id: fields.id ?? crypto.randomUUID(),
    in: fields.in ?? [DEFAULT_REALM],
    pubkey: fields.pubkey,
    created_at: fields.created_at ?? now,
    type: fields.type,
    relations: fields.relations ?? {},
    content: fields.content ?? {},
  }

  item.ref = fields.ref ?? makeRef(item)

  if (fields.name !== undefined) item.name = fields.name
  if (fields.instruction !== undefined) item.instruction = fields.instruction
  if (fields.updated_at !== undefined) item.updated_at = fields.updated_at
  if (fields.revision !== undefined) item.revision = fields.revision
  if (fields.rights !== undefined) item.rights = fields.rights

  return item
}

export function tombstone(item, options = {}) {
  return {
    id: item.id,
    ref: item.ref ?? makeRef(item),
    pubkey: item.pubkey,
    in: item.in,
    created_at: item.created_at,
    updated_at: options.now ?? isoNow(),
    revision: (item.revision ?? 0) + 1,
    type: 'DELETED',
    relations: {},
    content: {},
  }
}
