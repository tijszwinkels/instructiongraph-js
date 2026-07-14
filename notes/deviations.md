# fork/merge — design notes & deviations from the Q5 memo

Implementation notes for `ig git fork` / `ig git merge` (branch `feat/ig-fork-merge`,
stacked on `feat/git-remote-ig`). Companion to the normative memo
`~/projects/dataverse/specs/20260712-git-on-instructiongraph/open-question-5-merge-request-flow.md`.

**Bottom line:** the memo's flow survived contact with the Phase 1 codebase intact.
No core mechanic changed. Below are the small, deliberate decisions where the code
had to pick something the memo left implicit, plus one memo-sanctioned looseness.

## 1. The resolver fallthrough is the whole of Step 2's "real work" — confirmed

Phase 1's push path already sends only the delta: `pushToRemote` derives
`localKnownTips` from the fork's mirrored refs and excludes their closure via
`git rev-list ^tip`. So once a *clone* of a thin fork can resolve upstream objects,
delta push into a fork needs **zero** new push code. The net-new work was:
`openRepo().getObject/hasObject` walking the `forked_from` chain (depth-first, array
order, cycle-guarded), the O(1) fork anchor, and the merge provenance. Evidence:
`test/git-fork.test.js` (fallthrough) and the thin-fork assertion in
`test/git-fork-merge-e2e.test.js` (fork stores C2 but not C1).

## 2. Relation sugar on fork delta-objects may dangle (memo-sanctioned)

A fork's delta commit/tree carries `parent`/`tree`/`entry` relations computed in the
**fork's** namespace, even when the target actually lives upstream (structural
sharing). Those sugar links 404 on a naive follow. This is exactly the memo's
"parsed mirrors / relation sugar are derived, never authoritative; may dangle after
fork GC" stance (§2, README decision 3). The authoritative mechanism is the
address-computed resolver (§1), which re-hashes every payload — so correctness never
depends on the sugar. Left as-is by design; not worth an extra `hasObject` probe per
relation at write time.

## 3. `ig git merge` runs from the owner's working clone (matches "plain local git")

The memo says merge is computed client-side by the owner with plain local git. The
command therefore operates on the owner's checked-out clone of upstream (cwd = a work
tree), fetches the fork delta into it, runs real `git merge --ff-only` / `--no-ff`,
then signs owner-copies + CAS-updates the ref. Pragmatic precondition the memo did
not spell out: **local HEAD of the target branch must equal the current upstream tip**
(else the clone is stale and the CAS would fail anyway) — we fail early with a clear
message instead. Conflicts abort the merge and tell the owner to resolve in a work
tree / ask for a rebase (the memo's documented polite path); automated conflict
resolution is out of v1 scope.

## 4. HEAD stays implicit on forks (consistency with Phase 1)

A fork is exactly **one anchor + one GIT_REF** (the mirrored default branch). HEAD is
not stored as a GIT_REF — it is synthesized from `content.default_branch`, the same
convention the rest of the system already uses (stock git never pushes HEAD, and
`git-remote-ig`'s `list` synthesizes the `@refs/heads/… HEAD` line). Keeps the fork
truly O(1).

## 5. `copied_from` is set only where the fork actually stores the object

Per memo §3, every owner-copy of a *contributor* object carries `copied_from` → the
fork-namespace original. We gate this on `source.hasObjectLocal(oid)` (fork namespace,
no fallthrough), so:
- fork delta objects (C2/T2/B2) → `copied_from` set;
- the owner-created **merge commit** M and its merged root tree → **no** `copied_from`
  (they have no fork original), only `merges` → MR.
This keeps `copied_from` from ever dangling onto owner-authored objects. Verified in
`test/git-merge.test.js` (`--no-ff` case).

## 6. Fork realm defaults to inheriting upstream's realm

Per the memo's realm guidance (§2: "public upstream ⇒ public fork; shared-realm
upstream ⇒ same shared realm"), `ig git fork` defaults the fork's `in` to the
upstream's realm set so the upstream owner can still read the fork to merge it;
`--realm` overrides. **Open question left unresolved** (memo open item 1): whether a
shared-realm *member* may sign objects *into* that realm is a hub write-side semantics
question we did not test here. The common v1 case (public upstream) is unaffected.

## 7. `copied_from` on multi-level fork chains merged cross-chain (known gap)

`copied_from` is gated on `source.hasObjectLocal(oid)` — the *immediate* source
fork's namespace, no fallthrough. For the flows the CLI actually produces this is
exact: a direct fork C of upstream U, merged into U (the `forked_from` default), has
its entire delta in C's namespace, so every copied object is attributed. The gap is
narrow and deliberate: if you merge a **grandchild** fork straight into the
grandparent (`U ← B ← C`, `ig git merge C --into U`), objects that C inherited from B
(bytes stored only in B's namespace) are copied into U **without** `copied_from`.
Chosen over the alternative (gating on `hasObject` *with* fallthrough), which would
point `copied_from` at C's namespace where the object does not exist — a dangling,
mis-attributing link, strictly worse than an omitted one. Accurate cross-chain
attribution needs the resolver to report *which* namespace served each object;
deferred as not worth the machinery for v1 (copied_from is optional provenance sugar,
memo §3). Surfaced by codex adversarial review 2026-07-14.

## 8. `base === null` merge (target branch absent) is not hardened

When the upstream target branch does not exist yet (`base === null`), the stale-clone
guard (local HEAD must equal the upstream tip) is skipped and the ref is created via
`putRef(..., expectedOldOid: null)`. This is the intended path for merging into a
fresh/empty upstream — now covered by a regression test (`test/git-merge.test.js`,
"merge bootstraps content into an empty upstream"). Merging into a non-existent branch
from a local checkout with an *unrelated* non-empty history is left to git's own
`refusing to merge unrelated histories` protection rather than an explicit pre-check.
The normal flow (merge into an existing upstream branch) always has `base` non-null and
is fully guarded. Noted by review 2026-07-14; low severity, left as-is for v1.

## 9. Merge form (b) — MERGE_REQUEST as source — is plumbed but not exposed

`mergeIntoUpstream({ mergeRequestRef })` sets `merges` → the MR on the head/merge
commit (native-mode form b), and `test/git-merge.test.js` exercises it directly. It is
**not** wired to a CLI flag yet: form (b) needs the AgentFlow-owned `MERGE_REQUEST`
type extended with `source_repository`/`target_repository` relations + `base_oid`/
`head_oid` (memo §2, open item 2). Per the task brief, that type re-sign is gated on
owner (Tijs) approval — so the CLI implements form (a) (fork ref + branch) only, and
form (b) is a small follow-up once the type lands.
