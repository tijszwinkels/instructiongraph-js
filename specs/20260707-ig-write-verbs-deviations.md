# Deviations & decisions — ig write verbs

Implementation notes for `specs/20260707-ig-write-verbs.md`. Records the calls
made on the spec's open questions (§7) and other judgement points, so a reviewer
can see *why* the code does what it does.

## Open questions (§7)

### 1. Per-object push retry surface (3.3)

No per-object push existed — only `ig server push [--all]` (bulk). Added
**`ig server push --ref <ref>`**: loads that one object from the local store and
PUTs it to the hub (using the saved auth token). This is exactly the retry
command `ig commit --push` prints on exit 4:

```
error: stored <ref> rev N locally, but the hub push failed: <reason>
error: retry the push with: ig server push --ref <ref>
```

`--all` is never suggested (per the spec's explicit instruction).

### 2. `drafts/` in `.gitignore`

**Not** added to `.gitignore`, and no scaffolding advice emitted. Rationale:
`ig` is a library/CLI used from arbitrary working directories, not tied to one
repo; `ig commit` already deletes a consumed draft that lives under `drafts/`,
so drafts are transient by default. Injecting a `.gitignore` line would be a
surprising side effect for a data CLI. Users who want to keep drafts out of
version control can add the line themselves. (Left as a doc-only concern.)

### 3. Placeholder text format for `ig new` stubs

Optimised for a small model to recognise and replace. Rules (`src/scaffold.js`):

| schema             | placeholder                         |
|--------------------|-------------------------------------|
| string             | `"<string: {description}>"`         |
| optional string    | `"<optional string: {description}>"`|
| integer / number   | `0`                                 |
| boolean            | `false`                             |
| enum               | `"<one of: a \| b \| c>"`           |
| array of scalars   | `["<…item placeholder…>"]` (one example element) |
| array of objects   | `[]`                                |
| object w/ props    | recurse into its properties         |
| object, no props   | `{}`                                |

- `{description}` comes from the property's `description`, else `replace me`.
- Optional-ness is only marked inside string/enum placeholders (a `0`/`false`
  can't carry text). Required properties are emitted **before** optional ones,
  in the order the schema's `required` array lists them.
- `name`/`instruction` get `"<replace: …>"` placeholders (both are strings, so
  they satisfy any item-level `required` on those fields as-is).

## Other decisions

### Item-level TYPE schemas

`client.validateType` validates the **whole item** against `content.schema`
(confirmed by `test/client.test.js` — item-level `required` like `instruction`
are checked). So a TYPE's schema is item-level with the content shape under
`properties.content`. `ig new` therefore scaffolds `content` from
`contentSchemaOf(schema)` = `schema.properties.content`, falling back to treating
the schema itself as the content schema for content-only TYPEs.

### `commit` mode routing precedence

1. `--update <ref>` present → **merge** (deep-merge onto ref), overrides `_draft`.
2. else `_draft.mode === 'checkout'` → **checkout** (full-document replace + conflict check).
3. else → **new** (create).

`--update` wins because it is the most explicit signal the caller can give.

### `client.buildUpdate` (library addition)

Factored the fetch+merge+immutable+revision logic out of `client.update` into
`client.buildUpdate(ref, patch) → { item, orig }` (no signing/publishing).
`update()` now delegates to it (behaviour unchanged). This lets the CLI validate,
inspect, dry-run, and report on the computed item — and read the real push
outcome — while still reusing the library's deep-merge/immutable semantics
(spec's "expose, don't reinvent" principle). `orig` is returned so `commit`'s
checkout path can compare the stored revision for the conflict check.

### `pushed | local-only` detection

Read from the sync store's `_remoteOk` (the true hub outcome). A hub-only store
(no local data dir) has no `_remoteOk`, so there a successful `put` counts as
pushed; an offline fs store is always `local-only`.

### `set --delete` / `unrelate` on absent targets → error, not no-op

Both **error** when the target key/relation isn't present, surfacing the state
mismatch rather than silently succeeding (consistent with the spec's stance on
`relate`/`unrelate`, extended to `set --delete`).

### `set` refuses all `relations.*` paths

The spec refuses `relations.author` and "whole-relations edits". Implemented as:
any path whose first segment is `relations` is refused and points at
`ig relate` / `ig unrelate`. Field-level relation edits therefore always go
through the dedicated verbs.

### Realm on `checkout`

An explicit `--realm` overrides the object's realm on any mode. A `_draft.realm`
value is honoured for `new`, but on `checkout` the object keeps its existing
`in` (the checked-out payload carries it) unless `--realm` is passed. Changing an
object's realm on a routine content update is unusual; require the explicit flag.

### Notices vs errors on stderr

Fallback/advisory lines (`using active identity: …`, `TYPE … has no schema …`,
`authenticating to push …`) are printed to stderr prefixed `note:`, distinct
from `error:`. stdout still carries only the machine-usable result.

## Known limitation

`ig set <ref> <path> <value>` where `<value>` begins with `-` is not supported —
the positional parser treats a leading-dash token as a flag. Rare for the target
fields (titles, names, tags); use `ig edit` + `ig commit` for such values. Noted
rather than fixed to keep the arg parser consistent with the rest of the CLI.
