# @instructiongraph/ig

Zero-dependency JavaScript (ESM) library for interacting with InstructionGraph hubs.
Works in browsers (`<script type="module">`) and Node.js 18+. Uses Web Crypto API for all cryptography.

## Quick Start

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
const ref = await ig2.create({ type: 'POST', content: { title: 'Hello!', body: 'First post.' } })
```

### CLI

```bash
ig get <ref>                     # Fetch object
ig search --type POST --limit 10 # Search
ig verify <file.json>            # Verify signature
ig sign <spec.json>              # Sign spec
ig create <spec.json>            # Sign and publish
ig auth                          # Hub authentication
```

## Architecture

```
src/
  canonical.js      # canonicalJSON(value) → string (matches jq -cS)
  crypto.js         # sign, verify, generateKeypair (Web Crypto, ECDSA P-256)
  types.js          # JSDoc typedefs
  object.js         # buildItem, tombstone, parseRef, makeRef, isEnvelope
  identity.js       # deriveKeypair (PBKDF2), importPEM, createSigner
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

```js
import { createSyncStore } from '@instructiongraph/ig'
const store = createSyncStore({ local: fsStore, remote: hubStore })
```

## Identity Types

```js
// Username + password (PBKDF2 derivation, 600k iterations)
{ type: 'credentials', username: 'alice', password: '...' }

// PEM string
{ type: 'pem', pem: '-----BEGIN EC PRIVATE KEY-----\n...' }

// PEM file path (Node only)
{ type: 'pem-file', path: '/path/to/private.pem' }

// Custom signer
{ type: 'signer', signer: { pubkey: '...', sign: async (data) => '...' } }
```

## Testing

```bash
node --test test/    # 65 tests, zero dependencies
```

## Cross-compatibility

Objects signed by this library verify with the shell `./verify` script.
Objects signed by shell `./create` verify with this library's `verify()`.
Filesystem storage matches shell script conventions (canonical JSON, filename, mtime).
