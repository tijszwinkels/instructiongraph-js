/**
 * Repository store layer: git objects and refs ↔ the ig store, via a client.
 *
 * Immutable git objects (commit/tree/blob/tag) are written once at their
 * computed uuid_v5 address and never revised. GIT_REFs are mutable pointers
 * updated via the revision mechanism (compare-and-swap on the current target).
 * ls-remote is an inbound query for GIT_REF children of the repository anchor.
 *
 * The heavy lifting (payload↔content, oids, addressing) lives in the pure
 * codec/addressing/ref modules; this module wires them to createClient.
 */

import { parseRef, makeRef } from '../object.js'
import { ROOT_REF } from '../identity.js'
import { payloadToContent, contentToPayload } from './codec.js'
import { computeOid } from './oid.js'
import { objId, objRef, refId } from './addressing.js'
import { encodeRefContent, decodeRefContent } from './ref.js'
import { TYPE_REFS, OTYPE_TO_TYPE, OTYPE_INSTRUCTION, REF_INSTRUCTION, repoInstruction } from './typerefs.js'

// Hard ceiling on a single object's raw payload. The hub request cap is ~10 MB
// including base64 (+33%) and the envelope, so ~7 MB of raw bytes is the most
// that reliably round-trips. LFS-style pointers for larger files are future
// work (per the GIT_BLOB / GIT_REPOSITORY types).
const MAX_OBJECT_BYTES = 7 * 1024 * 1024

/**
 * Create the GIT_REPOSITORY anchor object.
 * @param {object} o
 * @param {object} o.client - ig client (with identity)
 * @param {string} o.id - repository uuid (namespace for all children)
 * @param {string} o.name
 * @param {'sha1'|'sha256'} [o.format='sha1']
 * @param {string[]} o.in - realm set inherited by every child
 * @param {string} [o.description]
 * @param {string} [o.defaultBranch]
 * @returns {Promise<string>} the repository ref
 */
export async function initRepo({ client, id, name, format = 'sha1', in: realms, description, defaultBranch }) {
  if (!client?.pubkey) throw new Error('initRepo requires an identity-bearing client')
  const content = { name, object_format: format }
  if (description) content.description = description
  if (defaultBranch) content.default_branch = defaultBranch
  return client.create({
    type: 'GIT_REPOSITORY',
    id,
    in: realms,
    name, // item.name mirrors content.name (normative)
    content,
    instruction: repoInstruction(makeRef(client.pubkey, id)),
    relations: {
      type_def: [{ ref: TYPE_REFS.GIT_REPOSITORY }],
      root: [{ ref: ROOT_REF }],
    },
  })
}

/**
 * Open an existing repository and return object/ref operations bound to it.
 * @param {object} o
 * @param {object} o.client
 * @param {string} o.repoRef - "<owner>.<uuid>"
 */
export async function openRepo({ client, repoRef }) {
  // Returns null only for a genuine not-found; a store/network/auth failure
  // propagates as an exception (callers must not treat those as "empty repo").
  const env = await client.get(repoRef)
  if (!env?.item) return null
  const repo = env.item
  const { pubkey: owner, id: repoId } = parseRef(repoRef)
  const format = repo.content?.object_format || 'sha1'
  const realms = repo.in

  // Child addresses are computed in the OWNER's namespace, but client.create
  // signs and addresses objects under the ACTIVE identity. They only coincide
  // when the active identity IS the owner — which the single-owner-push model
  // requires anyway. Guard every write so a non-owner can never sign objects
  // into their own namespace while the repo addresses them in the owner's
  // (which would "succeed" yet be unreadable). Contributors fork instead.
  function requireOwner(op) {
    if (client.pubkey !== owner) {
      throw new Error(
        `cannot ${op}: repository ${repoRef} is owned by ${owner}, but the active identity is ` +
        `${client.pubkey || '(none)'} — only the owner can write (fork to contribute)`
      )
    }
  }

  /** Assemble graph-sugar relations for a git object from its parsed mirror. */
  async function objectRelations(otype, content) {
    const relations = {
      repository: [{ ref: repoRef }],
      type_def: [{ ref: TYPE_REFS[OTYPE_TO_TYPE[otype]] }],
    }
    if (otype === 'commit' && content.commit) {
      if (content.commit.tree) relations.tree = [{ ref: await objRef(owner, repoId, content.commit.tree) }]
      if (content.commit.parents?.length) {
        relations.parent = await Promise.all(
          content.commit.parents.map(async p => ({ ref: await objRef(owner, repoId, p) }))
        )
      }
    } else if (otype === 'tree' && content.entries) {
      // Skip gitlink (160000) entries: those oids live in a submodule repo,
      // not this namespace, so an objRef here would be wrong.
      const linkable = content.entries.filter(e => e.mode !== '160000')
      if (linkable.length) {
        relations.entry = await Promise.all(
          linkable.map(async e => ({ ref: await objRef(owner, repoId, e.oid), name: e.name }))
        )
      }
    } else if (otype === 'tag' && content.tag?.object) {
      relations.target = [{ ref: await objRef(owner, repoId, content.tag.object) }]
    }
    return relations
  }

  /**
   * Best-effort `item.name` display hint per kind (constant rules, no prose):
   * commit → first message line (~72 chars); tag → tag name; tree → its path
   * (root tree → repo name); blob → first-seen path. Undefined if unknown.
   */
  function objectName(otype, content, name) {
    if (otype === 'commit') {
      const first = (content.commit?.message || '').split('\n', 1)[0].trim()
      return first ? first.slice(0, 72) : undefined
    }
    if (otype === 'tag') return content.tag?.tag || undefined
    if (otype === 'tree') return name || repo.content?.name || undefined
    if (otype === 'blob') return name || undefined
    return name || undefined
  }

  const api = {
    ref: repoRef,
    owner,
    repoId,
    format,
    in: realms,
    content: repo.content,

    /** Fetch a git object by oid; verifies the oid on read. Null if absent. */
    async getObject(oid) {
      const addr = makeRef(owner, await objId(repoId, oid))
      const e = await client.get(addr)
      if (!e?.item || e.item.type === 'DELETED') return null
      const otype = e.item.content.otype
      const payload = contentToPayload(e.item.content)
      const check = await computeOid(otype, payload, format)
      if (check !== oid) throw new Error(`oid mismatch at ${addr}: expected ${oid}, recomputed ${check}`)
      return { otype, payload }
    },

    /** True if the object already exists in the store. */
    async hasObject(oid) {
      const addr = makeRef(owner, await objId(repoId, oid))
      const e = await client.get(addr)
      return !!(e?.item && e.item.type !== 'DELETED')
    },

    /**
     * Write an immutable git object; idempotent. Returns its oid.
     * `name` is a best-effort first-seen path (for tree/blob) supplied by the
     * caller; commit/tag names are derived from the payload.
     */
    async putObject(otype, payload, { name } = {}) {
      requireOwner('write object')
      if (payload.length > MAX_OBJECT_BYTES) {
        throw new Error(
          `${otype} object is ${payload.length} bytes, over the ${MAX_OBJECT_BYTES}-byte cap ` +
          `(LFS-style pointers for large files are future work)`
        )
      }
      const content = await payloadToContent(otype, payload, format)
      const oid = content.oid
      const id = await objId(repoId, oid)
      const addr = makeRef(owner, id)
      const existing = await client.get(addr)
      if (existing?.item && existing.item.type !== 'DELETED') return oid // immutable, already stored
      const relations = await objectRelations(otype, content)
      await client.create({
        type: OTYPE_TO_TYPE[otype], id, in: realms, content, relations,
        name: objectName(otype, content, name),
        instruction: OTYPE_INSTRUCTION[otype],
      })
      return oid
    },

    /** Read a single ref by refname. Null if absent/deleted. */
    async getRef(refname) {
      const addr = makeRef(owner, await refId(repoId, refname))
      const e = await client.get(addr)
      if (!e?.item || e.item.type === 'DELETED') return null
      return { ...decodeRefContent(e.item.content), revision: e.item.revision || 0, addr }
    },

    /**
     * Create or update a ref. Compare-and-swap: if expectedOldOid is provided
     * (may be null for "must not exist / must currently be unset"), the current
     * target_oid must equal it or the update is rejected.
     *
     * The read-compare-write is not atomic at the data layer; under genuinely
     * concurrent writers the last write wins (revision monotonicity is still
     * enforced by the store). This is acceptable for the single-owner, local-
     * first v1 — the GIT_REF type states FF/no-clobber is a writer-side concern,
     * not a data-layer guarantee. Multi-writer atomicity is future work.
     */
    async putRef(refname, { targetOid, symrefTarget, peeledOid } = {}, { expectedOldOid } = {}) {
      requireOwner('update ref')
      const id = await refId(repoId, refname)
      const addr = makeRef(owner, id)
      const e = await client.get(addr)
      const exists = !!e?.item // live or tombstone — determines create vs update
      const live = exists && e.item.type !== 'DELETED' ? decodeRefContent(e.item.content) : null

      if (expectedOldOid !== undefined) {
        const cur = live?.targetOid ?? null
        const want = expectedOldOid ?? null
        if (cur !== want) {
          throw new Error(`compare-and-swap failed for ${refname}: current ${cur}, expected ${want}`)
        }
      }

      const content = encodeRefContent({ refname, targetOid, symrefTarget, peeledOid })
      const relations = {
        repository: [{ ref: repoRef }],
        type_def: [{ ref: TYPE_REFS.GIT_REF }],
      }
      if (targetOid) relations.target = [{ ref: await objRef(owner, repoId, targetOid) }]

      await client.create({
        type: 'GIT_REF', id, in: realms, content, relations,
        name: refname,
        instruction: REF_INSTRUCTION,
      }, { allowUpdate: exists })
      return addr
    },

    /** Delete a ref (tombstone). No-op if it does not exist. */
    async deleteRef(refname) {
      requireOwner('delete ref')
      const addr = makeRef(owner, await refId(repoId, refname))
      const e = await client.get(addr)
      if (!e?.item || e.item.type === 'DELETED') return
      await client.delete(addr)
    },

    /** Enumerate all live refs of the repository (ls-remote). */
    async listRefs() {
      const out = []
      let cursor = null
      do {
        const page = await client.inbound(repoRef, { relation: 'repository', type: 'GIT_REF', cursor, limit: 200 })
        for (const it of page.items || []) {
          if (it.item?.type !== 'GIT_REF') continue
          out.push({ ...decodeRefContent(it.item.content), revision: it.item.revision || 0 })
        }
        cursor = page.cursor
      } while (cursor)
      return out
    },
  }

  return api
}
