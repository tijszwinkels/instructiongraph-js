/**
 * Object building, ref parsing, and envelope utilities.
 */

/**
 * Parse a composite ref "pubkey.uuid" into { pubkey, id }.
 * @param {string} ref
 * @returns {{ pubkey: string, id: string }}
 */
export function parseRef(ref) {
  if (!ref || typeof ref !== 'string') throw new Error(`Invalid ref: ${ref}`)
  const dot = ref.indexOf('.')
  if (dot === -1) throw new Error(`Invalid ref (no dot separator): ${ref}`)
  return { pubkey: ref.slice(0, dot), id: ref.slice(dot + 1) }
}

/**
 * Create a composite ref from pubkey and id.
 * @param {string} pubkey
 * @param {string} id
 * @returns {string}
 */
export function makeRef(pubkey, id) {
  return `${pubkey}.${id}`
}

/**
 * Check if an object is a valid instructionGraph001 envelope.
 * @param {*} obj
 * @returns {boolean}
 */
export function isEnvelope(obj) {
  return !!(obj && obj.is === 'instructionGraph001' && obj.signature && obj.item)
}

/**
 * ISO 8601 timestamp without milliseconds.
 * @returns {string}
 */
export function isoNow() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/**
 * Build an unsigned item.
 *
 * @param {object} fields
 * @param {string} fields.pubkey - signer's compressed pubkey
 * @param {string} fields.type - e.g. 'POST', 'COMMENT'
 * @param {object} fields.content - free-form payload
 * @param {string} [fields.id] - explicit UUID (auto-generated if omitted)
 * @param {string[]} [fields.in] - realms (default: [pubkey] — private to owner)
 * @param {string} [fields.identityRef] - auto-adds author relation
 * @param {Object<string, import('./types.js').RelationEntry[]>} [fields.relations]
 * @param {string} [fields.name]
 * @param {string} [fields.instruction]
 * @param {object} [fields.rights]
 * @param {string} [fields.defaultRealm] - used if no `in` provided (default: pubkey realm)
 * @returns {import('./types.js').Item}
 */
export function buildItem(fields) {
  const {
    pubkey, type, content,
    id = crypto.randomUUID(),
    in: realms,
    identityRef,
    relations: providedRelations = {},
    name, instruction, rights,
    defaultRealm,
  } = fields

  const ref = makeRef(pubkey, id)
  // Private by default: use pubkey as realm (only owner can read).
  // Pass in: ['dataverse001'] explicitly to publish publicly.
  const resolvedRealms = realms || [defaultRealm || pubkey]

  // Build relations: author first, then merge provided
  const relations = {}
  if (identityRef) {
    relations.author = [{ ref: identityRef }]
  }
  for (const [key, entries] of Object.entries(providedRelations)) {
    relations[key] = entries
  }

  /** @type {import('./types.js').Item} */
  const item = {
    id,
    pubkey,
    ref,
    in: resolvedRealms,
    created_at: isoNow(),
    type,
    relations,
    content
  }

  if (name !== undefined) item.name = name
  if (instruction !== undefined) item.instruction = instruction
  if (rights !== undefined) item.rights = rights

  return item
}

/**
 * Create a DELETED tombstone item from an existing item.
 * @param {import('./types.js').Item} original
 * @returns {import('./types.js').Item}
 */
export function tombstone(original) {
  return {
    id: original.id,
    pubkey: original.pubkey,
    ref: original.ref,
    in: original.in,
    created_at: original.created_at,
    updated_at: isoNow(),
    revision: (original.revision || 0) + 1,
    type: 'DELETED',
    relations: {},
    content: {}
  }
}
