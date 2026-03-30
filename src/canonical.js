/**
 * Canonical JSON: compact, sorted keys.
 * Matches `jq -cS` output. Required for deterministic signatures.
 *
 * @param {*} value
 * @returns {string}
 */
export function canonicalJSON(value) {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJSON).join(',') + ']'
  return '{' + Object.keys(value).sort().map(
    k => JSON.stringify(k) + ':' + canonicalJSON(value[k])
  ).join(',') + '}'
}
