# SPEC: ig write verbs — an agent-ergonomic write path

- **Date**: 2026-07-07
- **Status**: approved for implementation
- **Author**: Tijs Zwinkels + Claude (design conversation, 2026-07-07)
- **Repo**: `instructiongraph-js`
- **Origin**: "InstructionGraph as filesystem" design discussion. Conclusion there: reads get
  friendlier projections later (directory/HTTP); **writes move to explicit CLI verbs with forced,
  synchronous, message-carrying feedback**. This spec covers only the write verbs.

## 1. Motivation

LLM agents — especially small models — make avoidable mistakes writing dataverse objects:

1. **Whole-document re-emission.** Today the only update path is `ig create --update` with a *full*
   spec. Re-emitting a whole document to change one field is where errors happen, and the CLI's
   update path **replaces** rather than merges: omitted top-level fields (e.g. `name`) are wiped.
   (Known production gotcha.)
2. **Envelope boilerplate.** Agents hand-type `type_def`/`root` relations, realm, and structure that
   could be generated from the TYPE definition.
3. **No dry-run.** There is no way to validate a spec without signing/publishing it.
4. **No concurrency safety.** Two agents editing the same object silently last-write-win.

## 2. Current state (verified 2026-07-07)

- `ig create <spec.json> [--update] [--identity N] [--realm R] [--push|--no-push]` — builds from a
  full spec. Update path (`cli/ig.js` ~1096–1180, `src/client.js` ~200–225) rebuilds the item from
  the spec's fields: **replace semantics**, preserving only `id`/`created_at` and auto-bumping
  `revision`/`updated_at`.
- `client.update(ref, patch)` (`src/client.js` ~250–283) **already implements deep-merge** semantics
  (`deepMerge`), preserves immutables (`id`, `ref`, `pubkey`, `created_at`), bumps revision, runs
  schema validation. **It is not exposed by the CLI.** The patch-function form
  (`update(ref, item => {...})`) also exists.
- Schema validation exists: `client.validateType(item)` validates `item` against the `type_def`
  TYPE's `content.schema` via `validateSchema` (`src/validation.js`; subset: `type`, `enum`,
  `required`, `properties`, `items`). Skips silently when no `type_def`/schema.
- Store (`src/store/fs.js`): canonical JSON + trailing newline, revision backups in
  `data/bk/{ref}.r{rev}.json`, signature verified on put.
- No scaffold command, no dry-run, no field-level patch, no relation add/remove, no revision-based
  conflict detection.

**Design principle:** the new verbs are thin CLI wiring over existing library primitives
(`client.build/validateType/sign/publish/update`). Prefer exposing what exists over new machinery.

## 3. New commands

### 3.1 `ig new <type-ref> [--identity N] [--realm R] [--out FILE]`

Scaffold a draft spec from a TYPE definition. No graph mutation.

- Fetch the TYPE object (store, then hub). Error if not found or if it has no `content.schema`
  (still scaffold a minimal draft in that case, with a notice).
- Emit a draft JSON file containing:
  - `type` — the TYPE's `content.name`
  - `name`, `instruction` — placeholder strings the author must replace
  - `content` — stubs generated from the schema: every `required` property present; property values
    are placeholders derived from the schema type (`"<string: {description}>"`, `0`, `false`, `[]`,
    `{}`); optional properties included but clearly marked in the placeholder text
  - `relations` — `type_def` → the TYPE ref, `root` → the genesis object (same shape `ig create`'s
    help documents today)
  - `_draft` — metadata block: `{ "mode": "new", "type_ref": ..., "identity": ..., "realm": ... }`
    (identity/realm from flags; omitted keys stay absent — see 3.3 resolution rules)
- Default output: `./drafts/<type-name>-<yyyymmdd-HHMMSS>.json` (create `drafts/` if needed). Never
  overwrite an existing file — append a suffix. Print the path as the only stdout line.

### 3.2 `ig edit <ref> [--identity N] [--out FILE]`

Check out the latest revision of an existing object for editing. No graph mutation.

- Fetch latest (store first, hub fallback). Error if not found.
- Error if `item.pubkey` ≠ the signing identity's pubkey ("can only edit your own objects";
  name the owning identity if it's a locally-known one).
- Write the full item payload (without signature envelope) to a draft file, plus
  `_draft: { "mode": "checkout", "base_ref": <ref>, "base_revision": <revision>, "identity": ... }`.
- Default output: `./drafts/<ref>.json`; same no-overwrite rule. Print the path.

### 3.3 `ig commit <draft.json> [--update <ref>] [--identity N] [--realm R] [--push|--no-push] [--dry-run]`

The single door into the graph for drafts. Pipeline, failing fast with a specific message per stage:

1. **Parse** — JSON syntax errors reported with line/column.
2. **Extract `_draft`** — strip it from the payload; it never gets signed.
3. **Resolve identity/realm** — precedence: CLI flag > `_draft` value. If neither is present for
   identity, fall back to the active identity but **print which identity is being used**; `--realm`
   falls back to the configured default realm the same way. (Keeps parity with `ig create` while
   making the resolution visible.)
4. **Envelope checks** — reject unknown top-level fields (typo protection; list allowed fields in
   the error). Reject specs that set signature-managed fields (`pubkey`, `ref`, `signature`).
5. **Route by mode**:
   - `mode: "new"` (or no `_draft` and no `--update`): create path. If an object with this `id`
     already exists → error pointing at `ig edit`.
   - `mode: "checkout"`: full-document update of `base_ref`. **Conflict check**: if the stored
     revision ≠ `base_revision`, fail (exit 3) with both revisions and the hint to re-run
     `ig edit`. Immutables (`id`, `ref`, `pubkey`, `created_at`) preserved from the original
     regardless of draft contents; `revision = base_revision + 1`.
   - bare spec + `--update <ref>`: **merge** path via `client.update(ref, patch)` — deep-merge onto
     the latest stored revision. Omitted fields are *preserved* (this is the fix for the
     wipes-omitted-fields gotcha). No conflict check (no base revision to compare).
6. **Schema validation** — `validateType`; report **all** errors, one per line, with JSON paths.
7. **Relation checks** — every ref in `relations` must match the `<pubkey>.<uuid>` shape; malformed
   refs are errors. (Unresolvable-but-well-formed refs are allowed — the graph is open.)
8. **`--dry-run` stops here** — print `valid: <would create|update ref> …` and exit 0. Nothing is
   signed, stored, or pushed.
9. **Sign → store → push** — existing create/update/publish machinery, including `bk/` backups.
   Push behavior and flags identical to `ig create` today.
10. **Report** — success prints exactly one stdout line:
    `committed <ref> rev <N> (pushed | local-only)`. On success, delete the draft file if it lives
    under `drafts/` (it's consumed); otherwise leave it.

**Push failure** is not a validation failure: the object is signed and stored locally. Exit 4 with a
message stating that, plus the exact retry command (implementer: verify what per-object push exists —
if only `ig server push` bulk exists, add a `--ref <ref>` filter to it as part of this work; never
suggest `--all`).

### 3.4 `ig validate <draft.json> [--update <ref>]`

Alias for `ig commit --dry-run`. Exists because "validate" is what agents will reach for.

### 3.5 `ig set <ref> <path> [<value>] [--json] [--delete] [--identity N]`

Single-field patch — the workhorse verb. Load latest → apply one change → validate → sign → store →
push (same tail as commit).

- `<path>` is dot-notation into the item: `content.title`, `content.tags`, `name`, `instruction`.
- Refuse envelope/signature-managed paths (`id`, `ref`, `pubkey`, `revision`, `created_at`,
  `updated_at`, `signature`, `relations.author`) and whole-`relations` edits (point at
  `ig relate`/`ig unrelate`).
- `<value>` is a string by default; `--json` parses it as JSON (numbers, booleans, arrays, objects,
  null); `--delete` removes the key (no value argument).
- Implement via `client.update(ref, item => …)` (patch-function form) so merge/immutable/revision
  semantics come from the library.
- Success output: `committed <ref> rev <N> (pushed | local-only)`.

### 3.6 `ig relate <ref> <relname> <target-ref> [--instruction TEXT] [--url URL]` / `ig unrelate <ref> <relname> <target-ref>`

Relation add/remove as first-class operations (a relation edit = new signed revision of the source).

- `relate`: append `{ ref: target, ...(instruction), ...(url) }` to `relations.<relname>`, creating
  the array if needed. **Dedupe by target ref**: if the target is already present, update its
  `instruction`/`url` when flags are given, otherwise error "already related" (exit 1) — silent
  success would hide agent confusion.
- `unrelate`: remove the entry; if absent, error stating the relation didn't exist (defensive:
  communicate the state mismatch, don't no-op). Remove the `relations.<relname>` key entirely when
  the array empties.
- `relname` `author` is refused (signature-managed).
- Both validate the target ref shape; both go through the same validate/sign/store/push tail.

## 4. Error contract (all verbs)

- Exit codes: `0` success · `1` validation/parse/semantic error · `2` usage error · `3` revision
  conflict · `4` stored-locally-but-push-failed.
- All diagnostics to **stderr**, prefixed `error:` (one per line for multi-error validation);
  stdout carries only machine-usable results (paths, `committed …` lines).
- Every error message must say *what to do next* (the fix, the command to run, or the field to
  change). These messages are the product — they are what the LLM reads. Write them for a small
  model: concrete, one action, no jargon.

## 5. Out of scope

- `ig create` behavior is **unchanged** (backward compat). Its `--help` gains a pointer to the new
  verbs.
- Filesystem/HTTP projections of the graph, daemons, mounts — separate future work.
- Hub/server changes (except the optional per-object push filter noted in 3.3).
- New TYPE-authoring helpers.

## 6. Testing requirements

TDD throughout: write the failing test first, watch it fail, make it pass. `node --test`, following
existing `test/*.test.js` + `test-support/` isolation patterns. **Never touch the developer's real
store or a live hub** — temp-dir stores only.

Minimum coverage, per verb:

- `new`: scaffold contains all schema-required properties; placeholders typed per schema; `type_def`
  + `root` relations present; no-overwrite naming; TYPE without schema → minimal draft + notice.
- `edit`: checkout carries correct `base_revision`; foreign-owned object refused.
- `commit`: happy create; happy checkout-update; **regression: merge path preserves omitted
  top-level fields** (the `--update` gotcha, red first against `create --update` semantics);
  conflict → exit 3; unknown top-level field → exit 1 naming it; multi-error validation lists all;
  `--dry-run` leaves store untouched (assert no file, no `bk/` entry); push failure → object in
  store + exit 4; `_draft` never appears in the signed item.
- `set`: nested path set; `--json` types; `--delete`; refused paths; revision increments by exactly 1.
- `relate`/`unrelate`: add creates array; dedupe error; instruction update on existing; unrelate
  missing → error; empty array key removed; `author` refused.
- Cross-cutting: exit codes as specified; stdout/stderr separation (assert stdout is exactly the
  documented line).

## 7. Open questions (implementer decides, records in a deviations note)

1. Exact per-object push retry surface (3.3) if none exists.
2. Whether `drafts/` should land in the repo's `.gitignore` scaffolding advice.
3. Placeholder text format for `ig new` stubs — optimize for "a small model replaces it correctly".
