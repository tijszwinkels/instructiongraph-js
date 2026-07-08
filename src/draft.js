/**
 * Draft parsing and envelope checks behind `ig commit` / `ig validate`.
 *
 * A draft is a plain spec object, optionally carrying a `_draft` metadata block
 * (mode + provenance) that is stripped before signing and never persisted.
 */

// Top-level fields a draft may carry into the signed item. Mirrors what
// buildItem accepts, minus the signature-managed fields below.
export const ALLOWED_TOP_LEVEL = new Set([
  'type', 'name', 'instruction', 'content', 'relations', 'in',
  'id', 'created_at', 'updated_at', 'revision', 'rights'
])

// Fields the signer derives; a draft must not set them.
const SIGNATURE_MANAGED = ['pubkey', 'ref', 'signature']

/** Line/column (1-based) for a character offset into `text`. */
function lineColFromPos(text, pos) {
  let line = 1
  let col = 1
  for (let i = 0; i < pos && i < text.length; i++) {
    if (text[i] === '\n') { line++; col = 1 } else { col++ }
  }
  return { line, col }
}

/**
 * Parse draft JSON, reporting syntax errors with line/column.
 * @param {string} text
 * @returns {object}
 */
export function parseDraftJSON(text) {
  try {
    return JSON.parse(text)
  } catch (e) {
    const msg = e.message
    if (/line \d+ column \d+/.test(msg)) throw new Error(`invalid JSON: ${msg}`)
    const posMatch = /position (\d+)/.exec(msg)
    if (posMatch) {
      const { line, col } = lineColFromPos(text, Number(posMatch[1]))
      throw new Error(`invalid JSON at line ${line} column ${col}: ${msg}`)
    }
    throw new Error(`invalid JSON: ${msg}`)
  }
}

/**
 * Split a parsed draft into its `_draft` metadata and the payload to sign.
 * @param {object} parsed
 * @returns {{ draft: object|null, payload: object }}
 */
export function extractDraft(parsed) {
  const { _draft = null, ...payload } = parsed
  return { draft: _draft, payload }
}

/**
 * Collect envelope errors: unknown top-level fields (typo protection) and
 * signature-managed fields that must not appear in a draft.
 * @param {object} payload
 * @returns {string[]}
 */
export function envelopeErrors(payload) {
  const errors = []
  for (const key of Object.keys(payload)) {
    if (SIGNATURE_MANAGED.includes(key)) {
      errors.push(`remove '${key}': it is set automatically when signing, not written in the draft`)
    } else if (!ALLOWED_TOP_LEVEL.has(key)) {
      errors.push(`unknown field '${key}'. allowed fields: ${[...ALLOWED_TOP_LEVEL].join(', ')}`)
    }
  }
  return errors
}

/**
 * Resolve which identity/realm a commit uses. Precedence: CLI flag > _draft >
 * fallback (active identity / configured default realm). The source is returned
 * so the caller can surface fallbacks visibly.
 * @param {object} args
 * @param {object|null} args.draft
 * @param {string} [args.flagIdentity]
 * @param {string} [args.flagRealm]
 * @param {string} [args.activeIdentity]
 * @param {string} [args.defaultRealm]
 */
export function resolveCommitTarget({ draft, flagIdentity, flagRealm, activeIdentity, defaultRealm }) {
  const pick = (flag, fromDraft, fallback) => {
    if (flag != null) return { value: flag, source: 'flag' }
    if (fromDraft != null) return { value: fromDraft, source: 'draft' }
    return { value: fallback, source: 'fallback' }
  }
  const id = pick(flagIdentity, draft?.identity, activeIdentity)
  const rlm = pick(flagRealm, draft?.realm, defaultRealm)
  return {
    identity: id.value, identitySource: id.source,
    realm: rlm.value, realmSource: rlm.source
  }
}
