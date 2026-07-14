/**
 * Client-side merge of a fork branch into an upstream repository the caller
 * owns. The hub never merges — only the owner's key can write the upstream
 * namespace, so merge authority is namespace ownership (README decision 5).
 *
 * Runs in the owner's local git working tree (a clone of upstream with the
 * target branch checked out at its current tip). Steps, per the Q5 memo:
 *   1. fetch the source delta into local git (oids re-verified on read)
 *   2. plain local git: fast-forward, or a merge commit (--no-ff)
 *   3. sign owner-copies of the newly-reachable objects into the upstream
 *      namespace — each carrying `copied_from` → the contributor's original,
 *      and the head/merge commit carrying `merges` → the MERGE_REQUEST when one
 *      is supplied (native-mode form)
 *   4. CAS-update the target GIT_REF (compare the base tip, then revision++)
 *
 * Provenance rationale (memo §3, Option A): git authorship rides inside the
 * commit payload byte-for-byte (same oid), so the owner's envelope signature is
 * hosting attestation, not authorship — exactly what any git server does.
 */

import { parseRef } from '../object.js'
import { openRepo } from './repo.js'
import { fetchToLocal } from './transfer.js'
import { objRef } from './addressing.js'
import {
  catFileBatch, revListObjectsWithPaths, revParse, isAncestor,
  objectExists, runGitWorktree,
} from './gitio.js'

/** Normalize a branch argument to a full refname (refs/heads/<x> by default). */
function fullBranch(name) {
  return name.startsWith('refs/') ? name : `refs/heads/${name}`
}

/** First line of an error message (git errors are multi-line and noisy). */
function firstLine(e) {
  return (e?.stderr?.toString?.() || e?.message || String(e)).split('\n')[0]
}

/**
 * @param {object} o
 * @param {object} o.client - identity-bearing client (must own the upstream)
 * @param {string} o.gitDir - the owner's local GIT_DIR
 * @param {string} o.worktree - the owner's working-tree root (for `git merge`)
 * @param {string} o.sourceRef - fork repo ref to merge from
 * @param {string} [o.sourceBranch] - branch in the fork (default: its default branch)
 * @param {string} [o.upstreamRef] - target repo ref (default: fork's forked_from)
 * @param {string} [o.targetRefname] - branch to advance (default: upstream default branch)
 * @param {'auto'|'ff-only'|'no-ff'} [o.mode='auto']
 * @param {string} [o.message] - merge-commit message
 * @param {string} [o.mergeRequestRef] - MERGE_REQUEST to record via `merges` (native mode)
 * @returns {Promise<object>} summary
 */
export async function mergeIntoUpstream({
  client, gitDir, worktree, sourceRef, sourceBranch,
  upstreamRef, targetRefname, mode = 'auto', message, mergeRequestRef,
}) {
  if (!client?.pubkey) throw new Error('merge requires an identity-bearing client')

  const source = await openRepo({ client, repoRef: sourceRef })
  if (!source) throw new Error(`source repository not found: ${sourceRef}`)

  const upRef = upstreamRef || source.forkedFrom?.[0]
  if (!upRef) throw new Error('no upstream to merge into: the source is not a fork — pass --into <upstream-ref>')
  const upstream = await openRepo({ client, repoRef: upRef })
  if (!upstream) throw new Error(`upstream repository not found: ${upRef}`)

  // Only the upstream owner can write its namespace — enforce before touching git.
  const { pubkey: upOwner } = parseRef(upRef)
  if (client.pubkey !== upOwner) {
    throw new Error(
      `cannot merge into ${upRef}: owned by ${upOwner}, active identity is ` +
      `${client.pubkey || '(none)'} — only the owner can merge`
    )
  }

  const targetRaw = targetRefname || upstream.content?.default_branch || 'refs/heads/main'
  const targetRef = fullBranch(targetRaw)
  const srcBranch = fullBranch(sourceBranch || source.content?.default_branch || 'refs/heads/main')

  const srcRefObj = await source.getRef(srcBranch)
  if (!srcRefObj?.targetOid) throw new Error(`source branch not found: ${srcBranch} in ${sourceRef}`)
  const sourceTip = srcRefObj.targetOid

  const base = (await upstream.getRef(targetRef))?.targetOid ?? null

  // Materialize the source tip + ancestors locally (re-verifies every oid), and
  // the base too, so rev-list ^base and git merge have everything they need.
  await fetchToLocal({ repo: source, gitDir, wants: [sourceTip] })
  if (base && !objectExists(gitDir, base)) {
    await fetchToLocal({ repo: upstream, gitDir, wants: [base] })
  }

  // The local checkout must sit at the current upstream tip of the target branch
  // (otherwise the owner's clone is stale and CAS would fail anyway).
  if (base) {
    const localHead = revParse(gitDir, 'HEAD')
    if (localHead !== base) {
      throw new Error(
        `local HEAD ${localHead} is not at the current ${targetRef} tip ${base}; ` +
        `check out the target branch and fetch first`
      )
    }
  }

  if (base && sourceTip === base) {
    return { kind: 'up-to-date', base, newTip: base, copied: [], targetRef, upstreamRef: upRef }
  }

  const canFF = !base || isAncestor(gitDir, base, sourceTip)
  if (mode === 'ff-only' && !canFF) {
    throw new Error(`not a fast-forward (${targetRef} has diverged) — use --no-ff to create a merge commit`)
  }

  // ── plain local git: fast-forward, or a merge commit ──
  let newTip, kind
  if (canFF && mode !== 'no-ff') {
    runGitWorktree(worktree, ['merge', '--ff-only', sourceTip])
    kind = 'fast-forward'
  } else {
    const msg = message || `Merge ${sourceBranch || srcBranch} from ${sourceRef}`
    try {
      runGitWorktree(worktree, ['merge', '--no-ff', '-m', msg, sourceTip])
    } catch (e) {
      try { runGitWorktree(worktree, ['merge', '--abort']) } catch { /* nothing to abort */ }
      throw new Error(
        `merge produced conflicts — resolve them in a working tree (or ask the ` +
        `contributor to rebase) and retry: ${firstLine(e)}`
      )
    }
    kind = 'merge-commit'
  }
  newTip = revParse(gitDir, 'HEAD')

  // ── copy the newly-reachable objects into the upstream namespace ──
  const entries = revListObjectsWithPaths(gitDir, newTip, base ? [base] : [])
  const recs = catFileBatch(gitDir, entries.map(e => e.oid))
  const { pubkey: srcOwner, id: srcId } = parseRef(sourceRef)
  const copied = []
  for (const { oid, path } of entries) {
    const rec = recs.get(oid)
    if (!rec) throw new Error(`local object ${oid} missing after merge`)
    const extra = {}
    // Provenance sugar: point at the contributor's original iff the fork
    // actually stores it (owner-created merge objects have no fork original).
    if (await source.hasObjectLocal(oid)) {
      extra.copied_from = [{ ref: await objRef(srcOwner, srcId, oid) }]
    }
    // The new head/merge commit records which MR it merges (native mode).
    if (oid === newTip && mergeRequestRef) {
      extra.merges = [{ ref: mergeRequestRef }]
    }
    const stored = await upstream.putObject(rec.type, rec.payload, {
      name: path || undefined,
      extraRelations: Object.keys(extra).length ? extra : undefined,
    })
    if (stored !== oid) throw new Error(`oid drift copying ${oid} → ${stored}`)
    copied.push(oid)
  }

  // ── CAS the target ref base → newTip (signed reflog) ──
  await upstream.putRef(targetRef, { targetOid: newTip }, { expectedOldOid: base })

  return {
    kind, base, newTip, copied, targetRef, upstreamRef: upRef,
    sourceRef, sourceTip, mergeRequestRef: mergeRequestRef || null,
  }
}
