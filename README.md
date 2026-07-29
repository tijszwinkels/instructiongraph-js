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
ig get <ref>                     # Fetch object
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
ig freenet publish <ref>         # Publish to Freenet, poke targets' indexes
ig freenet get <ref> [--rev N]   # Read a head, or one immutable revision
ig freenet inbound <ref>         # Who points at this object (index slot map)
ig freenet verify <ref>          # Check index slots against their snapshots
ig freenet derive <ref>          # Print derived contract ids (contacts nothing)
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

## Freenet backend (`ig freenet`)

Publish signed objects to [Freenet](https://freenet.org) and read them back,
including an **inbound-relations index** — the answer to "who points at this
object?", stored on the network rather than in a server-side database.

Every contract is addressed from the object's ref alone, so there is no index
to consult and nothing to look up:

| contract | holds | address |
|---|---|---|
| head | the current envelope | `params32`, mutable, last-writer-wins on revision |
| snapshot | one immutable revision | `params40`, one contract per `(ref, revision)` |
| index | who points at this object | `params32` **of the target** |

```
params32    = BLAKE3(pubkey_raw_33B)[..16] ‖ uuid_16B
params40    = params32 ‖ revision_be64
contract_id = base58( BLAKE3( BLAKE3(wasm_bytes) ‖ params ) )
```

The contract WASM hashes into the id, which is what keeps the three keyspaces
apart even though all three are derived from the same ref.

```bash
# One-time setup: the node's port and the pinned contract WASMs.
ig freenet config freenet-contracts-dir /path/to/contracts
ig freenet config freenet-port 7509

ig freenet publish <ref>          # or a path to a signed envelope JSON
ig freenet inbound <ref> | jq .   # {"<source-ref>": {"revision": 3, "relations": ["root"]}}
ig freenet verify <ref>           # exit 0 iff every slot verifies
ig freenet derive <ref> --rev 3   # debug addressing without touching the node
```

`publish` runs an ordered flow: snapshot PUT → a **GET-back gate** → head PUT →
one poke per distinct target in `item.relations`. The gate matters: a poke makes
the target's index fetch the source's snapshot, so poking before that snapshot
is confirmed stalls every poke for the node's multi-minute fetch budget and then
fails. If the snapshot is not confirmed, nothing is poked at all.

Everything is idempotent — the snapshot re-PUT is a no-op, the head merge is
LWW, and pokes are LWW — so a partial run is fixed by running it again. Pokes
are independent; `publish` reports each target and exits non-zero if any failed.

Notes and limits:

- **The contract WASMs are pinned artifacts, never rebuilt on the fly.** Their
  bytes define the keyspace: a rebuilt contract addresses a different, empty
  universe, and every existing object then reads as unpublished rather than as
  an error. Hence a configured directory rather than a build step. The
  canonical source of the pinned builds is `artifacts/` in
  [`tijszwinkels/dataverse-freenet`](https://github.com/tijszwinkels/dataverse-freenet);
  point `freenet-contracts-dir` at a checkout of it. There is deliberately no
  default — any default would be a machine-specific path into another repo.
- `ig freenet get --rev N` never falls back to the head. The absence of a
  revision is meaningful; answering with a different revision would be worse
  than answering nothing.
- `inbound` distinguishes "no index exists" (exit 1 — nothing has ever poked
  this target) from "an index with no slots" (exit 0, `{}`).
- **The index is a filter, not proof.** The contract's creation and seeding
  paths accept structure-only states, so a slot is a claim until checked — that
  is what `ig freenet verify` is for. It re-derives each slot from the source's
  own signed snapshot and reports `verified-current`, `verified-stale` (the
  source moved on, or its head is not on the node so currency is unknowable) or
  `unverified`.
- Node calls go through `fdev`, and every one is bounded (`--timeout`,
  `--put-timeout`). An unbounded GET for a contract the node does not hold
  blocks for minutes, which reads as a hung terminal.
- BLAKE3 and base58 are vendored in `src/freenet/` rather than taken as
  dependencies, so the package keeps zero runtime dependencies. They are
  verified against the official BLAKE3 test vectors and against live contract
  ids; signing itself is untouched and stays on Web Crypto.

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
  freenet/
    blake3.js       # BLAKE3-256 (vendored; addressing only)
    base58.js       # base58 encode/decode (vendored)
    addressing.js   # ref → head / snapshot / index contract ids
    contracts.js    # read + hash the pinned contract WASMs
    config.js       # port, fdev path, contracts dir
    fdev.js         # createFdevNode — bounded fdev subprocess client
    relations.js    # one reading of an envelope's relations, shared
    publish.js      # US-3.1 ordered publish + poke flow
    verify.js       # US-3.4 slot verification
  index.js          # public re-exports
cli/
  ig.js             # CLI entry point
  freenet.js        # `ig freenet` command family
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

Combines local filesystem + remote hub. Reads check the hub first (with ETag caching), writes go to both. Falls back to local when the hub is unreachable.

```js
import { createSyncStore } from '@instructiongraph/ig'
const store = createSyncStore({ local: fsStore, remote: hubStore })
```

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

The Freenet end-to-end suite is skipped unless you opt in, since it needs the
pinned contract WASMs and a node of your own:

```bash
export IG_FREENET_E2E_CONTRACTS=/path/to/contracts   # golden-id checks, offline

freenet local --ws-api-address 127.0.0.1 --ws-api-port 7511 \
  --config-dir ~/.cache/ig-freenet-e2e/config \
  --data-dir   ~/.cache/ig-freenet-e2e/data
export IG_FREENET_E2E_PORT=7511                      # + the live flow

node --test test/freenet-e2e.test.js
```

Use a **local-mode node of your own**, never a shared or network node. Every
other Freenet test runs offline against a fake `fdev`
(`test-support/fake-fdev.js`).

## Cross-compatibility

Objects signed by this library verify with the shell `./verify` script from the [dataverse reference implementation](https://dataverse001.net). Objects signed by shell `./create` verify with this library's `verify()`. Filesystem storage matches shell script conventions (canonical JSON, filename format, mtime).
