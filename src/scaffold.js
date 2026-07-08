/**
 * Scaffold a draft spec from a TYPE definition (`ig new`).
 *
 * Pure functions: turn a TYPE's `content.schema` (JSON Schema subset) into a
 * draft object an author edits, then hands to `ig commit`. Placeholder values
 * are written for a small model to recognise and replace correctly.
 */

import { ROOT_REF } from './identity.js'

const ROOT_INSTRUCTION = "dataverse001 data-format. Read this first if you haven't yet."

/** First concrete (non-null) type in a schema's `type`, or undefined. */
function primaryType(schema) {
  const t = schema?.type
  if (Array.isArray(t)) return t.find(x => x !== 'null')
  return t
}

/**
 * A placeholder value for one property, derived from its schema.
 * @param {object} propSchema
 * @param {object} [opts]
 * @param {boolean} [opts.optional] - mark the placeholder as optional (string/enum only)
 */
export function placeholderFor(propSchema = {}, { optional = false } = {}) {
  const mark = optional ? 'optional ' : ''

  if (Array.isArray(propSchema.enum) && propSchema.enum.length > 0) {
    return `<${optional ? 'optional; ' : ''}one of: ${propSchema.enum.join(' | ')}>`
  }

  switch (primaryType(propSchema)) {
    case 'integer':
    case 'number':
      return 0
    case 'boolean':
      return false
    case 'null':
      return null
    case 'array': {
      // One example element for scalar item schemas; object/array items stay empty (avoid deep nesting).
      const items = propSchema.items
      const itemType = primaryType(items)
      if (items && itemType && itemType !== 'object' && itemType !== 'array') {
        return [placeholderFor(items)]
      }
      return []
    }
    case 'object':
      return propSchema.properties ? scaffoldContent(propSchema) : {}
    case 'string':
    default: {
      const desc = propSchema.description || 'replace me'
      return `<${mark}string: ${desc}>`
    }
  }
}

/**
 * Build a `content` stub from an object schema: every property present,
 * required ones first, each with a type-appropriate placeholder.
 * @param {object} schema
 */
export function scaffoldContent(schema) {
  if (!schema || !schema.properties) return {}
  const required = new Set(schema.required || [])
  const keys = Object.keys(schema.properties)
  // Required first, in the schema author's stated order; then remaining optional properties.
  const requiredInProps = (schema.required || []).filter(k => k in schema.properties)
  const ordered = [...requiredInProps, ...keys.filter(k => !required.has(k))]

  const content = {}
  for (const key of ordered) {
    content[key] = placeholderFor(schema.properties[key], { optional: !required.has(key) })
  }
  // Required keys the schema forgot to describe in `properties` still need to appear.
  for (const key of required) {
    if (!(key in content)) content[key] = '<string: required, replace me>'
  }
  return content
}

/**
 * Pick the sub-schema describing `content`. TYPE schemas are item-level
 * (validated against the whole item), so the content schema normally lives at
 * `properties.content`. Fall back to treating the schema itself as the content
 * schema for TYPEs that describe content directly.
 * @param {object} [schema]
 */
export function contentSchemaOf(schema) {
  if (!schema) return undefined
  if (schema.properties && schema.properties.content) return schema.properties.content
  return schema
}

/**
 * Scaffold a full draft object from a fetched TYPE.
 * @param {object} args
 * @param {object} args.typeObj - the fetched TYPE envelope ({ item: { content: { name, schema } } })
 * @param {string} args.typeRef - the TYPE's ref (for the type_def relation and _draft)
 * @param {string} [args.identityName] - recorded in _draft when supplied
 * @param {string} [args.realm] - recorded in _draft when supplied
 * @returns {object} draft spec (includes a _draft metadata block)
 */
export function buildDraft({ typeObj, typeRef, identityName, realm }) {
  const schema = typeObj?.item?.content?.schema
  const typeName = typeObj?.item?.content?.name || ''

  return {
    type: typeName,
    name: '<replace: short human-readable label>',
    instruction: '<replace: how an agent should interpret and display this object>',
    content: scaffoldContent(contentSchemaOf(schema)),
    relations: {
      type_def: [{ ref: typeRef }],
      root: [{ ref: ROOT_REF, url: `https://dataverse001.net/${ROOT_REF}`, instruction: ROOT_INSTRUCTION }]
    },
    _draft: {
      mode: 'new',
      type_ref: typeRef,
      ...(identityName ? { identity: identityName } : {}),
      ...(realm ? { realm } : {})
    }
  }
}
