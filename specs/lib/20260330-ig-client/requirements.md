# Requirements: InstructionGraph JavaScript Library

## User Stories

### 1. Read public data from a hub

**As a** webapp or script
**I want** to query a hub for objects without any identity
**So that** I can build read-only views of the graph

#### Acceptance Criteria

- WHEN `createClient({ store: createHubStore({ url }) })` is called without identity THEN reads work
- WHEN `ig.get(ref)` is called THEN the object is fetched from the hub and returned
- WHEN `ig.search({ type: 'POST', limit: 20 })` is called THEN matching objects are returned with pagination
- WHEN `ig.inbound(ref, { relation: 'comments_on' })` is called THEN inbound relations are returned
- WHEN `ig.create(...)` is called without identity THEN it throws with a clear error message

### 2. Sign and publish objects

**As a** user with a private key
**I want** to create, sign, and publish objects to a hub
**So that** I can participate in the graph

#### Acceptance Criteria

- WHEN `ig.create({ type, content, relations })` is called THEN it builds the item, validates against TYPE if `type_def` relation present, signs, and publishes
- WHEN the TYPE schema validation fails THEN `create()` throws before signing, with details about what's wrong
- WHEN `ig.update(ref, { content: { title: 'New' } })` is called THEN it fetches latest, merges the patch, bumps revision, signs, and publishes
- WHEN `ig.delete(ref)` is called THEN it creates and publishes a DELETED tombstone with higher revision

### 3. Auto-configure from local config files

**As a** CLI user or agent
**I want** `createClient()` with no arguments to read `.instructionGraph/config/`
**So that** I don't have to specify hub URL, identity, and realm every time

#### Acceptance Criteria

- WHEN `createClient()` is called with no args THEN it reads `config/hub-url`, `config/active-identity`, `config/default-realm` from `./.instructionGraph/` (falling back to `~/.instructionGraph/`)
- WHEN `config/active-identity` contains `"dataverse-creator-1"` THEN it loads `identities/dataverse-creator-1/private.pem`
- WHEN no config files exist THEN it defaults to hub `https://dataverse001.net`, realm `dataverse001`, identity `default`

### 4. Multiple identity types

**As a** developer
**I want** to provide identity in different formats
**So that** the library works in different environments

#### Acceptance Criteria

- WHEN identity `{ type: 'pem', pem: pemString }` is given THEN the PEM is imported via Web Crypto
- WHEN identity `{ type: 'pem-file', path: '...' }` is given THEN the file is read and imported (Node only)
- WHEN identity `{ type: 'credentials', username, password }` is given THEN a deterministic keypair is derived via PBKDF2 (600k iterations)
- WHEN identity `{ type: 'signer', signer: { pubkey, sign } }` is given THEN it's used directly

### 5. Create new identity

**As a** new user
**I want** to generate a keypair and create an IDENTITY object
**So that** I can start participating

#### Acceptance Criteria

- WHEN `ig.createIdentity({ name: 'Alice' })` is called THEN it generates a P-256 keypair, creates an IDENTITY object with well-known UUID `00000000-0000-0000-0000-000000000001`, signs it, and publishes
- WHEN no name is given THEN a name is auto-generated (e.g. "Agent-7f3a")
- WHEN using local config THEN the private key is saved to `identities/{name}/private.pem`

### 6. Generic store interface

**As a** developer
**I want** a pluggable storage backend
**So that** the same client API works with hub-only, filesystem, or synced storage

#### Acceptance Criteria

- WHEN `createHubStore({ url })` is used THEN all reads/writes go to the hub via HTTP
- WHEN `createFsStore({ dataDir })` is used THEN objects are stored as `{pubkey}.{id}.json` with canonical JSON and correct mtime
- WHEN `createSyncStore({ local, remote })` is used THEN reads fetch from both and keep the newer revision, writes go to both

### 7. Cross-compatibility with existing tools

**As a** user of the current shell scripts
**I want** objects signed by the JS library to verify with `./verify`
**So that** the new library is a drop-in replacement

#### Acceptance Criteria

- WHEN an object is signed by the JS library THEN `./verify` (shell script) reports "Verified OK"
- WHEN an object was signed by the shell `./create` THEN `verify(obj)` in JS returns `true`
- WHEN the JS library stores to filesystem THEN the file format matches what `./store` produces (canonical JSON, correct filename, correct mtime)

### 8. CLI interface

**As a** terminal user
**I want** a `ig` command
**So that** I can interact with the graph from the command line

#### Acceptance Criteria

- WHEN `ig get <ref>` is run THEN the object is fetched (sync-read) and printed as JSON
- WHEN `ig sign <spec.json>` is run THEN the spec is signed and the envelope is printed
- WHEN `ig create <spec.json>` is run THEN it signs and publishes, printing the ref
- WHEN `ig search --type POST` is run THEN matching objects are listed
- WHEN `ig verify <file.json>` is run THEN it exits 0 if valid, 1 if not
- WHEN `ig auth` is run THEN it performs challenge-response auth and stores the token
