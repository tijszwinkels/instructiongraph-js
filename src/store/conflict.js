import { canonicalJSON } from '../canonical.js'

// Signatures may differ for the same item; transport metadata is unsigned.
export function sameItem(a, b) {
  return canonicalJSON(a.item) === canonicalJSON(b.item)
}

export function isRevisionConflict(error) {
  return error?.code === 'REVISION_CONFLICT' || error?.status === 409 || error?.status === 412
}

export class RevisionConflictError extends Error {
  constructor(local, incoming, conflictPath) {
    const ref = incoming.item.ref
    const revision = incoming.item.revision || 0
    super(`Revision conflict for ${ref} at revision ${revision}; local edit retained. ` +
      (conflictPath ? `Incoming edit saved at ${conflictPath}. ` : '') +
      'Compare both edits and publish a resolved higher revision.')
    this.name = 'RevisionConflictError'
    this.code = 'REVISION_CONFLICT'
    this.ref = ref
    this.revision = revision
    this.local = local
    this.incoming = incoming
    this.conflictPath = conflictPath
  }
}
