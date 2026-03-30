# Design: InstructionGraph JavaScript Library

## Implementation Context

### Source Files to Read

- `../../.instructionGraph/create` — Sign-and-store flow, config resolution, PEM key loading
- `../../.instructionGraph/store` — Verification, canonical storage, revision comparison, backup, tombstone handling
- `../../.instructionGraph/verify` — ECDSA-P256 signature verification with OpenSSL
- `../../.instructionGraph/transport-hub-read` — Sync-read logic: fetch both, compare revisions, keep newer
- `../../.instructionGraph/transport-hub-create` — Conflict detection on create
- `../../.instructionGraph/transport-hub-update` — Sync-first update semantics
- `../../.instructionGraph/base-resolve` — Config overlay: local `.instructionGraph/` > `~/.instructionGraph/`
- `../../.instructionGraph/hub-resolve` — Hub URL resolution chain
- `../../.instructionGraph/scan` — Object extraction from arbitrary data streams

### Existing Browser JS to Port

- `dataverse-core.js` (BLOB `AxyU5_...b178e012...`) — `canonicalJSON`, `api`, `pushToHub`, `resolveAuthor`, `sortPosts`
- `dataverse-write.js` (BLOB `AxyU5_...8e7cc85b...`) — `deriveKeypair`, `importPEM`, P-256 EC math, `p1363ToDer`, `buildItem`, `signAndPush`, `editObject`, `deleteObject`, challenge-response auth

### Hub API (from `server/hub/serving/hub.go`)

- `GET /search?by=&type=&limit=&cursor=&include=inbound_counts`
- `GET /{ref}` — supports `If-None-Match` ETag (revision-based)
- `PUT /{ref}` — store signed object
- `GET /{ref}/inbound?relation=&from=&type=&limit=&cursor=&include=inbound_counts`
- `GET /auth/challenge` → `{ challenge, expires_at }`
- `POST /auth/token` → `{ token, pubkey, expires_at }` (also sets `dv_session` cookie)
- `POST /auth/logout`

## Architecture

### Module dependency graph

```
index.js ─── re-exports everything
  │
  ├── client.js ─── createClient()
  │     ├── object.js ─── buildItem, tombstone
  │     ├── identity.js ─── key derivation, PEM import
  │     └── store/*.js ─── storage backends
  │
  ├── crypto.js ─── sign, verify, generateKeypair
  │     └── canonical.js ─── canonicalJSON
  │
  ├── store/hub.js ─── createHubStore (fetch-based)
  ├── store/fs.js ─── createFsStore (Node fs)
  └── store/sync.js ─── createSyncStore (local + remote)
```

### File layout

```
src/
  canonical.js      # canonicalJSON(value) → string
  crypto.js         # sign, verify, generateKeypair, exportCompressedPubkey
  types.js          # JSDoc typedefs (no runtime code)
  object.js         # buildItem, tombstone, parseRef, makeRef, isEnvelope
  identity.js       # deriveKeypair, importPEM, createSigner
  client.js         # createClient — high-level API
  store/
    interface.js    # JSDoc Store typedef (no runtime code)
    hub.js          # createHubStore
    fs.js           # createFsStore
    sync.js         # createSyncStore
  index.js          # public re-exports
test/
  canonical.test.js
  crypto.test.js
  object.test.js
  hub.test.js
  identity.test.js
  client.test.js
  cross-validate.test.js
cli/
  ig.js             # CLI entry point
```

## Interfaces / Contracts

### Signer (internal contract)

```js
/** @typedef {Object} Signer
 *  @property {string} pubkey — compressed P-256 pubkey, base64url, 44 chars
 *  @property {(data: Uint8Array) => Promise<string>} sign — returns base64 DER signature
 */
```

All identity types normalize to a Signer before use.

### Store interface

```js
/** @typedef {Object} Store
 *  @property {(ref: string) => Promise<object|null>} get
 *  @property {(signedObj: object) => Promise<{ok: boolean, status?: number}>} put
 *  @property {(query: SearchQuery) => Promise<SearchResult>} search
 *  @property {(ref: string, opts?: InboundQuery) => Promise<SearchResult>} inbound
 */

/** @typedef {Object} SearchQuery
 *  @property {string} [by] — filter by pubkey
 *  @property {string} [type] — filter by type
 *  @property {number} [limit]
 *  @property {string} [cursor]
 *  @property {boolean} [includeInboundCounts]
 */

/** @typedef {Object} SearchResult
 *  @property {object[]} items
 *  @property {string|null} cursor — for next page, null if no more
 */
```

### Client API

```js
createClient(opts?) → Client

// opts:
//   store: Store                     — storage backend (default: hub from config)
//   identity: IdentityConfig|null    — signing identity (default: from config, null = read-only)
//   defaultRealm: string             — default realm (default: from config or 'dataverse001')
//   configDir: string                — override config directory (default: auto-resolve)

// Client methods:
//   get(ref) → Promise<object|null>
//   search(query) → Promise<SearchResult>
//   inbound(ref, opts?) → Promise<SearchResult>
//   build(fields) → object (unsigned item)
//   sign(item) → Promise<object> (signed envelope)
//   publish(signedObj) → Promise<{ok, ref}>
//   create(fields) → Promise<string> (build + validate TYPE + sign + publish → ref)
//   update(ref, patch) → Promise<string> (fetch + merge + sign + publish → ref)
//   delete(ref) → Promise<string> (tombstone + sign + publish → ref)
//   createIdentity(opts?) → Promise<{ref, pubkey}>
```

## Key Implementation Details

### Canonical JSON

Port directly from `DV.canonicalJSON`. Recursive, sorted keys, compact. ~20 lines.

### Signature format bridging

Web Crypto's ECDSA produces IEEE P1363 format (64 bytes: r‖s). The existing shell scripts and hub expect DER format. The `p1363ToDer()` function from `dataverse-write.js` handles this conversion. Port it directly.

### Config resolution (Node only)

Mirror `base-resolve` logic:
1. Look for `./.instructionGraph/config/{name}` (walk up from cwd)
2. Fall back to `~/.instructionGraph/config/{name}`
3. Fall back to defaults: hub=`https://dataverse001.net`, realm=`dataverse001`, identity=`default`

### Sync store semantics

Port from `transport-hub-read`:
- **get(ref)**: Fetch from both local and remote. Compare `item.revision`. Keep the one with higher revision. Push the newer version to the other store.
- **put(obj)**: Store in local first, then push to remote. Remote failures are non-fatal (log warning).

### TYPE validation in buildItem

When `relations.type_def` is present:
1. Fetch the TYPE object from the store
2. Extract `item.content.schema` (JSON Schema)
3. Validate the item's `content` against it
4. On failure, throw with schema violation details

Cache TYPE objects by ref. If store is not provided or TYPE not found, skip validation with a warning.

Note: JSON Schema validation without dependencies is hard. For v1, validate required fields and basic types only (no `ajv`). Document that full schema validation requires `ajv` as optional peer dependency.

## Error Handling

- **No identity configured**: `create/update/delete/sign` throw `Error('No identity configured — createClient needs an identity for write operations')`
- **Hub unreachable**: `get` returns `null`, `put` returns `{ ok: false, error: 'hub unreachable' }`, never throws
- **Signature verification failed**: `verify()` returns `false`, `store.put()` rejects
- **TYPE validation failed**: `buildItem/create` throw with field-level details
- **Revision conflict**: `update` throws `Error('Revision conflict: remote has revision N, expected M')`

## Testing Strategy

Use Node.js built-in test runner (`node --test`). Zero test dependencies.

### TDD order

1. `canonical.test.js` — verify output matches `echo '...' | jq -cS`
2. `crypto.test.js` — keygen, sign, verify round-trip; verify known signatures
3. `cross-validate.test.js` — sign with JS → verify with `../../.instructionGraph/verify`; sign with `../../.instructionGraph/create` → verify with JS
4. `object.test.js` — buildItem fields, ref parsing, tombstone shape
5. `hub.test.js` — integration test against live `https://dataverse001.net`
6. `identity.test.js` — PBKDF2 determinism (same user+pass → same pubkey), PEM round-trip
7. `client.test.js` — full flow: createClient → create → get → update → delete
