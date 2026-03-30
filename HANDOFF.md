# Handoff: InstructionGraph JS Library

## What is this?

A zero-dependency JavaScript (ESM) library for interacting with InstructionGraph hubs. Works in both browsers (`<script type="module">`) and Node.js 18+. Uses Web Crypto API for all cryptography.

This replaces both the shell scripts in `.instructionGraph/` and the browser `DV.*` globals (`dataverse-core.js` / `dataverse-write.js`) with one canonical implementation.

## Where are the specs?

Read these in order:

1. `specs/lib/20260330-ig-client/overview.md` — problem, goal, scope
2. `specs/lib/20260330-ig-client/requirements.md` — user stories + acceptance criteria
3. `specs/lib/20260330-ig-client/design.md` — architecture, interfaces, implementation details

## Existing code to port from

The existing implementations live in the parent `dataverse` repo:

- **Shell scripts**: `../.instructionGraph/create`, `store`, `verify`, `scan`, `transport-hub-*`, `base-resolve`, `hub-resolve`
- **Browser JS**: Stored as BLOBs in the InstructionGraph. To read them:
  ```bash
  # dataverse-core.js
  jq -r '.item.content.text' ../.instructionGraph/data/AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.b178e012-3910-415a-be34-353fc411de99.json

  # dataverse-write.js
  jq -r '.item.content.text' ../.instructionGraph/data/AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.8e7cc85b-b011-45fb-bbde-4661e85000f9.json
  ```
- **Hub server (Go)**: `../server/hub/` — especially `serving/hub.go` for routes, `object/verify.go` for crypto, `auth/auth.go` for challenge-response

## How to implement

### Prerequisites

- Node.js 18+ (for `fetch`, `crypto.subtle`, `crypto.randomUUID`)
- The `dataverse` repo checked out at `..` (for cross-validation tests and porting reference)

### Implementation order (TDD)

Follow the design doc's testing strategy. For each module:
1. Write a failing test
2. Implement until it passes
3. Cross-validate against existing shell scripts where applicable

```
Step 1:  src/canonical.js + test — canonicalJSON, cross-validate with `jq -cS`
Step 2:  src/crypto.js + test — sign, verify, keygen (Web Crypto), cross-validate with ../verify
Step 3:  src/types.js — JSDoc typedefs only, no runtime code
Step 4:  src/object.js + test — buildItem, parseRef, makeRef, tombstone
Step 5:  src/store/hub.js + test — createHubStore, test against live hub
Step 6:  src/identity.js + test — deriveKeypair (PBKDF2), importPEM, port from dataverse-write.js
Step 7:  src/store/fs.js + test — createFsStore, filesystem conventions
Step 8:  src/store/sync.js + test — createSyncStore, revision comparison
Step 9:  src/client.js + test — createClient, auto-config, full integration
Step 10: src/index.js — re-exports
Step 11: cli/ig.js — thin CLI wrapper
Step 12: Cross-validation test suite — JS ↔ shell script interop
```

### Key gotchas

1. **Signature format**: Web Crypto ECDSA produces IEEE P1363 (r‖s, 64 bytes). The hub and shell scripts expect DER format. You must convert with `p1363ToDer()` — port from `dataverse-write.js`.

2. **Compressed pubkey**: Web Crypto doesn't export compressed EC points. You need the P-256 EC math (`ecMul`, `ecAdd`, `compressPoint`) from `dataverse-write.js` for PBKDF2 derivation. For PEM/keygen, export JWK and compute compression from x,y coordinates.

3. **Config resolution**: The shell scripts use `base-resolve` with overlay (local `.instructionGraph/` → `~/.instructionGraph/`). The Node client must replicate this exactly.

4. **IDENTITY well-known UUID**: `00000000-0000-0000-0000-000000000001` — by convention, every pubkey's identity lives at this UUID.

5. **TYPE validation**: When `buildItem` sees a `type_def` relation, it should fetch the TYPE and validate. For v1, do basic field validation without a full JSON Schema engine. Document `ajv` as optional peer dep for full validation.

### Running tests

```bash
node --test test/
```

Uses Node's built-in test runner. Zero test dependencies.

### Smoke test in browser

Create a simple HTML file:
```html
<script type="module">
  import { createClient, createHubStore } from './src/index.js'
  const ig = createClient({ store: createHubStore({ url: 'https://dataverse001.net' }) })
  const root = await ig.get('AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.00000000-0000-0000-0000-000000000000')
  console.log('Root:', root.item.content.name)
</script>
```
