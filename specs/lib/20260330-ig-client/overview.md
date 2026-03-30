# Overview: InstructionGraph JavaScript Library

## Problem Statement

The InstructionGraph / dataverse001 ecosystem currently has two independent client implementations that overlap significantly:

1. **Shell scripts** (~700 LOC in `.instructionGraph/`): `store`, `verify`, `create`, `scan`, `transport-hub-*` — used by CLI agents. Depend on `bash`, `openssl`, `jq`, `curl`.
2. **Browser JS** (~1250 LOC): `dataverse-core.js` + `dataverse-write.js` — served as BLOBs from the graph, used by webapps via a `DV.*` global.

Both implement canonical JSON, ECDSA P-256 signing/verification, hub API interaction, and challenge-response auth — but as separate codebases with different conventions. Adding a feature means patching both. Testing is manual.

## Goal

A single, zero-dependency JavaScript (ESM) library that provides a clean API for interacting with InstructionGraph hubs, usable from both browsers (`<script type="module">`) and Node.js (18+). Replaces both the shell scripts and the browser `DV.*` API with one canonical implementation.

## Scope

### In Scope

- **Protocol primitives**: canonical JSON, object building, ref parsing, envelope creation
- **Crypto**: ECDSA P-256 sign/verify/keygen via Web Crypto API, PEM import, PBKDF2 key derivation (username+password)
- **Generic Store interface**: pluggable persistence (hub, filesystem, sync)
- **Hub client**: get, put, search, inbound queries, challenge-response auth, pagination
- **Filesystem store**: Node.js adapter matching current shell script storage conventions
- **Sync store**: combines local + remote, keeps newer revision
- **High-level client** (`createClient`): auto-config from `.instructionGraph/config/`, read-only and read-write modes
- **Identity management**: create new identities (keygen + IDENTITY object + publish)
- **Automatic TYPE validation**: `buildItem()` validates content against TYPE schema
- **CLI wrapper**: `ig get`, `ig sign`, `ig search`, etc.

### Out of Scope

- Auth UI widget (DOM/CSS panel) — apps build their own UI
- Display utilities (`timeAgo`, `esc`, `shortPk`) — left to consuming apps
- Bundler/build tooling — ships as plain `.js` ESM files
- WebSocket/real-time subscriptions
