/**
 * Basic JSON Schema validation for TYPE content schemas.
 *
 * Supports: type, required, properties, items, enum.
 * For full JSON Schema validation, use `ajv` as an optional peer dependency.
 */

function inferType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate a value against a JSON Schema subset.
 * @param {*} value
 * @param {object} schema
 * @param {string} [path='content']
 * @returns {string[]} array of error messages (empty = valid)
 */
export function validateSchema(value, schema, path = 'content') {
  if (!schema || typeof schema !== 'object') return []

  const errors = []

  // Type check
  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type]
    const matches = expected.some(t => {
      if (t === 'number') return typeof value === 'number'
      if (t === 'integer') return Number.isInteger(value)
      if (t === 'object') return isPlainObject(value)
      if (t === 'array') return Array.isArray(value)
      if (t === 'null') return value === null
      return typeof value === t
    })
    if (!matches) {
      errors.push(`${path} must be ${expected.join(' or ')}`)
      return errors // type mismatch — don't recurse further
    }
  }

  // Enum check
  if (schema.enum && !schema.enum.some(v => Object.is(v, value))) {
    errors.push(`${path} must be one of ${schema.enum.map(v => JSON.stringify(v)).join(', ')}`)
  }

  // Object: required fields + nested properties
  if (isPlainObject(value)) {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key} is required`)
    }
    for (const [key, propSchema] of Object.entries(schema.properties || {})) {
      if (key in value) {
        errors.push(...validateSchema(value[key], propSchema, `${path}.${key}`))
      }
    }
  }

  // Array: validate each item
  if (Array.isArray(value) && schema.items) {
    value.forEach((entry, i) => {
      errors.push(...validateSchema(entry, schema.items, `${path}[${i}]`))
    })
  }

  return errors
}
