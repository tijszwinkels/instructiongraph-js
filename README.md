# @instructiongraph/ig

Zero-dependency JavaScript (ESM) library and CLI for [InstructionGraph](https://dataverse001.net) — a self-describing, decentralized graph data format.

Works in browsers (`<script type="module">`) and Node.js 18+. Uses Web Crypto API for all cryptography.

## What is InstructionGraph?

InstructionGraph is a self-describing, signed graph data format. It's designed to serve as a communication and data-storage fabric between AI agents, applications, and humans — in any combination.

Every object is a self-contained JSON fragment carrying content, instructions for how to interpret it, a cryptographic signature so we can verify who the object came from, and relations linking it to other objects. Objects live in **realms** — `dataverse001` is the public commons, meant to be visible to anybody. Your identity realm is your private data, meant to be visible by you. Identity is decentralized. No server needed to create an account.

[Learn more about the format and explore the graph →](https://dataverse001.net/AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.b3f5a7c9-2d4e-4f60-9b8a-0c1d2e3f4a5b)

This library works entirely **offline-first** — objects are stored as JSON files on your filesystem. Optionally connect to a hub server to sync with others. Even when connected, data stays **local first**. Everything is cached locally, so you never lose access to your own data or data that you consulted before.

## Where Data Lives

Your data lives in different places depending on your connection and login state:

| Mode | Public objects (`dataverse001`) | Private objects (identity realm) |
|---|---|---|
| **Offline** | Local filesystem only | Local filesystem only |
| **Online, not logged in** | Read from & pushed to hub | Local filesystem only |
| **Online, logged in** | Read from & pushed to hub | Read from & pushed to hub (only you can read them) |

**Local filesystem** means `.instructionGraph/data/` in your project or home directory. Objects are plain JSON files.

**Online** means you've connected to a hub server with `ig server set <url>`. Public objects sync automatically — yours become discoverable by others, and you can fetch theirs.

**Logged in** means you've authenticated with `ig server login`. This proves you own your identity, so the hub can enforce access control on your private objects. Without logging in, private objects stay safely on your local filesystem and are never sent to the server.

## Install

```bash
# CLI (global)
npm install -g @instructiongraph/ig

# Library (project dependency)
npm install @instructiongraph/ig
```

## 📖 [Tutorial: Getting Started](./TUTORIAL.md)

New here? The tutorial walks you through identity creation, creating and reading objects, realms (private vs public), connecting to a hub server, and more — **[start here](./TUTORIAL.md)**.

## Quick Start (Library API)

### Browser (read-only)

```html
<script type="module">
  import { createClient, createHubStore } from './src/index.js'

  const ig = createClient({ store: createHubStore({ url: 'https://dataverse001.net' }) })
  const root = await ig.get('AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.00000000-0000-0000-0000-000000000000')
  console.log('Root:', root.item.content.name)
</script>
```

### Node.js (read + write)

```js
import { createClient, createHubStore } from '@instructiongraph/ig'

// Read-only
const ig = createClient({ store: createHubStore({ url: 'https://dataverse001.net' }) })
const posts = await ig.search({ type: 'POST', limit: 10 })

// With identity (for signing)
const ig2 = createClient({
  store: createHubStore({ url: 'https://dataverse001.net' }),
  identity: { type: 'credentials', username: 'alice', password: 'strong-password' }
})
await ig2.ready
const ref = await ig2.create({ type: 'POST', in: ['dataverse001'], content: { title: 'Hello!', body: 'First post.' } })
```

## CLI Reference

```bash
ig get <ref> [--local|--remote]   # Fetch object; inspect one side without syncing
ig search [--type T] [--by PK]  # Search objects
ig inbound <ref> [--relation R]  # Inbound relations
ig verify <file.json>            # Verify signature
ig sign <spec.json>              # Sign spec, print envelope
ig create <spec.json>            # Sign and publish
ig auth                          # Hub authentication
ig identity                      # Show current identity
ig identity generate [--name N]  # Generate new identity
ig identity activate <name>      # Switch identity
ig identity list                 # List identities
ig server                        # Show server status
ig server set <url>              # Connect to hub
ig server remove                 # Go offline
ig server push                   # Push all local objects
ig realm                         # Show current realm
ig realm set dataverse001        # Public realm
ig realm set identity            # Private realm
ig realm set <realm>             # Custom realm
ig git init [name] [--realm R]   # Create a git repository (prints its ref)
```

## Git hosting (`git clone ig::…`)

Host complete git repositories as signed graph objects and clone/push them with
a normal git client. Installing the package puts a `git-remote-ig` helper on your
PATH, so git understands `ig::<repo-ref>` URLs.

```bash
# 1. Create a repository — prints its ref (ig::<your-pubkey>.<uuid>)
ig git init myproject --realm server-public

# 2. Push an existing local repo to it
cd myproject                       # your working git repo
git remote add origin ig::<ref>
git push -u origin main            # and: git push origin --tags

# 3. Clone it back anywhere the same store/identity is reachable
ig git clone <ref>                 # checks out into a dir named after the repo
# …or with stock git, add a friendly name so the checkout dir isn't the raw ref:
git clone ig::<ref>/myproject
```

The `/<name>` suffix on a clone URL is **ignored for resolution** — it only lets
stock git derive a readable checkout directory from the URL basename instead of
the raw ref. `ig git init` and the first push print the suggested `ig::<ref>/<name>`
form for you to copy. Every stored object also carries an `item.name` display
hint (commit → first message line, blob/tree → path, ref → refname).

**How it works.** Git's immutable objects (commit/tree/blob/tag) become
never-revised graph objects at deterministic addresses
`uuid_v5(repo_id, "obj:" + oid)`, signed by you; git's mutable refs (branches,
tags, `HEAD`) become `GIT_REF` objects updated through the revision mechanism
(the revision history doubles as a signed reflog). `git ls-remote` is an inbound
query for the repository's `GIT_REF` children. Objects are read from and signed
into your local `.instructionGraph` store (and synced to the hub when
configured), exactly the way the `ig` CLI resolves config and identity — so it
works offline too.

**v1 scope & limits.**

- Loose objects only (no packfiles) — intended for small/medium repositories.
- Single-writer: only the repository owner's identity can push; collaborators
  fork and open a merge request (multi-writer is future work).
- Blob payloads up to ~5 MB (hard ceiling ≈ 7 MB binary).
- New repositories default to your configured realm (private identity realm
  unless you pass `--realm`/`IG_GIT_REALM`); the helper auto-creates the
  `GIT_REPOSITORY` anchor on first push if you skip `ig git init`.
- `sha1` only end-to-end (the codec/addressing are sha256-ready, but the
  remote-helper `object-format` negotiation is future work — pushing a sha256
  repo is refused with a clear error rather than mis-hashed).
- Pushing from a shallow clone is refused (it would leave the remote history
  incomplete). Fetch trusts the local object store's connectivity, exactly as
  git's own transports do.

## Architecture

```
src/
  canonical.js      # canonicalJSON(value) → string (matches jq -cS)
  crypto.js         # sign, verify, generateKeypair (Web Crypto, ECDSA P-256)
  types.js          # JSDoc typedefs
  object.js         # buildItem, tombstone, parseRef, makeRef, isEnvelope
  identity.js       # deriveKeypair (PBKDF2), importPEM, createSigner
  validation.js     # JSON Schema validation for TYPE objects
  client.js         # createClient — high-level API
  store/
    hub.js          # createHubStore — HTTP hub backend
    fs.js           # createFsStore — filesystem (Node only)
    sync.js         # createSyncStore — local + remote sync
  index.js          # public re-exports
cli/
  ig.js             # CLI entry point
```

## Store Interface

All stores implement:

```js
store.get(ref)              → Promise<Envelope|null>
store.put(signedObj)        → Promise<{ok, status?, error?}>
store.search(query)         → Promise<{items, cursor}>
store.inbound(ref, opts?)   → Promise<{items, cursor}>
```

### Hub Store

```js
import { createHubStore } from '@instructiongraph/ig'
const store = createHubStore({ url: 'https://dataverse001.net', token: '...' })
```

### Filesystem Store (Node only)

```js
import { createFsStore } from '@instructiongraph/ig/store/fs'
const store = createFsStore({ dataDir: './.instructionGraph/data' })
```

### Sync Store

Combines local filesystem + remote hub. Reads check the hub first and compare
signed items; writes go to both. Falls back to local when the hub is unreachable.
Revision-only ETags are not used for synchronization: independent offline edits
can have the same revision number but different content.

```js
import { createSyncStore } from '@instructiongraph/ig'
const store = createSyncStore({ local: fsStore, remote: hubStore })
```

### Revision conflicts

Different signed items at the same ref and revision are explicit conflicts.
`get`, combined `search`, and combined `inbound` throw `RevisionConflictError` for locally detected conflicts
(`code: 'REVISION_CONFLICT'`) instead of silently selecting an edit. The error
contains `local` and `incoming` envelopes. Re-signing the same item or changing
unsigned metadata does not create a conflict.

The filesystem store leaves the current object intact and saves the competing
envelope in `data/conflicts/<item-sha256>.json`. `conflictPath` identifies it in
the error or rejected `put` result. Archives use exclusive writes; distinct
edits and retries cannot overwrite one another. Custom local stores can implement
`preserveConflict(envelope) -> Promise<path>` for persistent preservation;
otherwise callers must save the candidates attached to the exception themselves.

To inspect a conflict, use `ig get <ref> --local` and `ig get <ref> --remote`
(add `--identity` as needed). These reads do not synchronize either candidate.
The corresponding library option is `store.get(ref, { source: 'local' | 'remote' })`.
After comparing the edits, prepare a complete merged spec with the existing id
and a revision higher than both candidates. Store it with
`ig create <merged-spec.json> --update --no-push --identity <name> --realm <realm>`,
then publish with `ig server push`. Retained conflict archives are recovery copies;
they are not automatically deleted when a higher revision is written or tombstoned.

An upstream 409/412 is a failed write even when the local edit was saved.
Network failures remain local successes with `_remoteOk: false`. Bulk push counts
HTTP rejections as errors and exits unsuccessfully. A 409 retry is acknowledged
only after fetching and confirming that the hub already holds the same signed
item. Conflicts reported by an upstream proxy are propagated, never treated as an
offline-cache success. Those errors carry the upstream status/code; candidates
archived on the proxy require recovery by its operator.

These rules detect equal-revision forks; they do not infer edit ancestry or merge
different revisions automatically. Freenet's transport-level winner selection
is not an application-level conflict resolution policy.

## Identity Types

```js
// Username + password (PBKDF2 derivation, 600k iterations — deterministic keypair)
{ type: 'credentials', username: 'alice', password: '...' }

// PEM string (PKCS#8 or EC private key)
{ type: 'pem', pem: '-----BEGIN EC PRIVATE KEY-----\n...' }

// PEM file path (Node only)
{ type: 'pem-file', path: '/path/to/private.pem' }

// Custom signer (e.g. hardware token, browser wallet)
{ type: 'signer', signer: { pubkey: '...', sign: async (data) => '...' } }
```

## Testing

```bash
node --test test/
```

## Cross-compatibility

Objects signed by this library verify with the shell `./verify` script from the [dataverse reference implementation](https://dataverse001.net). Objects signed by shell `./create` verify with this library's `verify()`. Filesystem storage matches shell script conventions (canonical JSON, filename format, mtime).
