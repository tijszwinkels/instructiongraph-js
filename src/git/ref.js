/**
 * GIT_REF content codec: the mutable half of a repository (branches, tags,
 * HEAD). Exactly one of target_oid (direct) or symref_target (symbolic).
 * Pure and browser-safe.
 */

/**
 * Build a GIT_REF `content` block.
 * @param {{refname:string, targetOid?:string, symrefTarget?:string, peeledOid?:string}} ref
 * @returns {object} content
 */
export function encodeRefContent({ refname, targetOid, symrefTarget, peeledOid }) {
  if (!refname) throw new Error('GIT_REF requires a refname')
  const hasTarget = typeof targetOid === 'string'
  const hasSymref = typeof symrefTarget === 'string'
  if (hasTarget === hasSymref) {
    throw new Error('GIT_REF requires exactly one of target_oid or symref_target')
  }
  const content = { refname }
  if (hasTarget) content.target_oid = targetOid
  else content.symref_target = symrefTarget
  if (peeledOid) content.peeled_oid = peeledOid
  return content
}

/**
 * Decode a GIT_REF `content` block into a normalized shape.
 * @param {object} content
 * @returns {{refname:string, targetOid?:string, symrefTarget?:string, peeledOid?:string}}
 */
export function decodeRefContent(content) {
  const out = { refname: content.refname }
  if (typeof content.target_oid === 'string') out.targetOid = content.target_oid
  if (typeof content.symref_target === 'string') out.symrefTarget = content.symref_target
  if (typeof content.peeled_oid === 'string') out.peeledOid = content.peeled_oid
  return out
}
