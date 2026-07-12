/**
 * Object transfer between a local git repo and an ig-hosted repository.
 *
 * fetchToLocal: walk the object DAG from the wanted tips in the ig store and
 * materialize every reachable object as a loose object in the local git repo.
 *
 * pushToRemote: for each src:dst, enumerate the objects reachable from src via
 * git plumbing, store them immutably in the graph, then advance the GIT_REF with
 * a fast-forward / compare-and-swap check.
 *
 * The reachability walking uses the authoritative payloads (parsed here, not the
 * derived mirrors) so it never trusts anything it cannot recompute.
 */

import { parseCommit, parseTree, parseTag } from './codec.js'
import {
  writeLooseObject, catFileBatch, catFile, catFileType,
  revParse, revListObjects, isAncestor, objectExists, isShallow,
} from './gitio.js'

// ─── Fetch (clone / fetch) ────────────────────────────────────────

/**
 * Materialize every object reachable from `wants` into the local loose store.
 * @param {object} o
 * @param {object} o.repo - opened ig repository (repo.js)
 * @param {string} o.gitDir
 * @param {string[]} o.wants - tip oids requested by git
 * @returns {Promise<number>} number of objects written
 */
export async function fetchToLocal({ repo, gitDir, wants }) {
  const visited = new Set()
  const stack = [...wants]
  let written = 0

  while (stack.length) {
    const oid = stack.pop()
    if (visited.has(oid)) continue
    visited.add(oid)

    // If we already have it locally, git guarantees its whole subtree is present.
    if (objectExists(gitDir, oid)) continue

    const obj = await repo.getObject(oid) // verifies the oid on read
    if (!obj) throw new Error(`repository is missing object ${oid}`)
    writeLooseObject(gitDir, oid, obj.otype, obj.payload)
    written++

    if (obj.otype === 'commit') {
      const c = parseCommit(obj.payload)
      if (c.tree) stack.push(c.tree)
      for (const p of c.parents) stack.push(p)
    } else if (obj.otype === 'tree') {
      for (const e of parseTree(obj.payload, repo.format)) {
        if (e.mode === '160000') continue // gitlink → submodule commit, another repo
        stack.push(e.oid)
      }
    } else if (obj.otype === 'tag') {
      const t = parseTag(obj.payload)
      if (t.object) stack.push(t.object)
    }
  }
  return written
}

// ─── Push ─────────────────────────────────────────────────────────

/** Store a list of local oids into the graph (immutable, idempotent). */
async function uploadObjects(repo, gitDir, oids) {
  if (!oids.length) return
  const recs = catFileBatch(gitDir, oids)
  for (const oid of oids) {
    const rec = recs.get(oid)
    if (!rec) throw new Error(`local object ${oid} not found`)
    const stored = await repo.putObject(rec.type, rec.payload)
    if (stored !== oid) throw new Error(`oid drift storing ${oid} → ${stored}`)
  }
}

/** Walk the annotated-tag chain from tip, returning { tagOids, peeled }. */
function peelTagChain(gitDir, tipOid) {
  const tagOids = []
  let cur = tipOid
  while (catFileType(gitDir, cur) === 'tag') {
    tagOids.push(cur)
    const t = parseTag(catFile(gitDir, 'tag', cur))
    if (!t.object) break
    cur = t.object
  }
  return { tagOids, peeled: cur }
}

async function pushOne({ repo, gitDir, push, remoteRefs, localKnownTips }) {
  const { src, dst, force } = push

  // delete
  if (src === '') {
    await repo.deleteRef(dst)
    return { dst, ok: true }
  }

  const tipOid = revParse(gitDir, src)

  // A branch must point at a commit (git rejects non-commit objects on
  // refs/heads/*). Tags may point at any object.
  if (dst.startsWith('refs/heads/') && catFileType(gitDir, tipOid) !== 'commit') {
    return { dst, ok: false, error: `cannot push a non-commit object to a branch (${dst})` }
  }

  const { tagOids, peeled: commitOid } = peelTagChain(gitDir, tipOid)
  const peeledOid = tagOids.length ? commitOid : undefined

  const currentRef = remoteRefs.find(r => r.refname === dst)
  const currentOid = currentRef?.targetOid ?? null

  // nothing to do
  if (currentOid === tipOid) return { dst, ok: true }

  // fast-forward / overwrite protection (writer-side, per the GIT_REF rules)
  if (!force && currentOid) {
    if (dst.startsWith('refs/heads/')) {
      if (!objectExists(gitDir, currentOid) || !isAncestor(gitDir, currentOid, commitOid)) {
        return { dst, ok: false, error: 'non-fast-forward' }
      }
    } else if (dst.startsWith('refs/tags/')) {
      return { dst, ok: false, error: 'tag already exists (use --force)' }
    }
  }

  // enumerate + upload: commit/tree/blob objects first, then the tag chain
  const objOids = revListObjects(gitDir, commitOid, localKnownTips)
  await uploadObjects(repo, gitDir, objOids)
  await uploadObjects(repo, gitDir, [...tagOids].reverse())

  await repo.putRef(dst, { targetOid: tipOid, peeledOid }, { expectedOldOid: currentOid })
  return { dst, ok: true }
}

/**
 * Push a batch of ref updates.
 * @param {object} o
 * @param {object} o.repo
 * @param {string} o.gitDir
 * @param {{src:string,dst:string,force:boolean}[]} o.pushes
 * @returns {Promise<{dst:string,ok:boolean,error?:string}[]>}
 */
export async function pushToRemote({ repo, gitDir, pushes }) {
  // A shallow clone has a truncated history: rev-list stops at the shallow
  // boundary, so uploading a tip would leave its ancestors missing on the
  // remote. Refuse object-bearing pushes (deletes are still fine).
  const shallow = isShallow(gitDir)

  const remoteRefs = await repo.listRefs()
  const localKnownTips = remoteRefs
    .map(r => r.targetOid)
    .filter(oid => oid && objectExists(gitDir, oid))

  const results = []
  for (const push of pushes) {
    if (shallow && push.src !== '') {
      results.push({ dst: push.dst, ok: false, error: 'refusing to push from a shallow repository (would leave an incomplete history on the remote)' })
      continue
    }
    try {
      results.push(await pushOne({ repo, gitDir, push, remoteRefs, localKnownTips }))
    } catch (e) {
      results.push({ dst: push.dst, ok: false, error: (e.message || String(e)).replace(/\n/g, ' ') })
    }
  }
  return results
}
