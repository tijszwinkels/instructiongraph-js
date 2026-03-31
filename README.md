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
```

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

## Cross-compatibility

Objects signed by this library verify with the shell `./verify` script from the [dataverse reference implementation](https://dataverse001.net). Objects signed by shell `./create` verify with this library's `verify()`. Filesystem storage matches shell script conventions (canonical JSON, filename format, mtime).
