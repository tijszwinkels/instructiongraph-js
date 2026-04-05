#!/usr/bin/env node

/**
 * ig - CLI for InstructionGraph.
 *
 * Usage:
 *   ig get <ref>              Fetch and print object
 *   ig search [--type T] [--by PK] [--limit N]
 *   ig inbound <ref> [--relation R] [--type T]
 *   ig verify <file.json>     Verify signature
 *   ig sign <spec.json>       Sign a spec and print envelope
 *   ig create <spec.json>     Sign and publish
 *   ig server login            Log in with your active identity
 *   ig identity               Show current identity
 *   ig server                 Show/set/remove hub server
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { canonicalJSON } from '../src/canonical.js'
import { verify } from '../src/crypto.js'
import { isEnvelope } from '../src/object.js'
import { createClient } from '../src/client.js'
import { createHubStore } from '../src/store/hub.js'
import { createFsStore } from '../src/store/fs.js'
import { createSyncStore } from '../src/store/sync.js'
import { isVisible, loadSharedRealms } from '../src/store/realm-filter.js'
import { generateKeypair } from '../src/crypto.js'

const args = process.argv.slice(2)
const cmd = args[0]

function hasHelp(argv = args) {
  return argv.includes('--help') || argv.includes('-h')
}

function flag(name) {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1) return undefined
  return args[idx + 1]
}

function die(msg) {
  console.error(`Error: ${msg}`)
  process.exit(1)
}

function usage() {
  console.log(`ig - InstructionGraph CLI

InstructionGraph is a novel, self-describing graph data format designed for
exchanging data, concepts, and applications between LLMs. Each node carries
instructions plus relations, so agents and humans can follow the graph to
understand, render, and extend it.

Learn more:
  Readme:      https://github.com/tijszwinkels/instructiongraph-js#readme
  Tutorial:    https://github.com/tijszwinkels/instructiongraph-js/blob/main/TUTORIAL.md
  Data format: https://dataverse001.net/AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.b3f5a7c9-2d4e-4f60-9b8a-0c1d2e3f4a5b

Usage:
  ig <command> [options]

Commands:
  ig status                        Show full configuration status
  ig get <ref> [--identity N]      Fetch object (auth as identity for private)
  ig search [options]              Search objects
  ig inbound <ref> [options]       Inbound relations
  ig verify <file.json>            Verify signature
  ig sign <spec.json>              Sign spec, print envelope
  ig create <spec.json> [options]  Sign and publish
  ig identity                      Show current identity
  ig identity generate [--name N]  Generate a new identity
                       [--project]  Use ./.instructionGraph instead of ~/
                       [--activate] Set as active identity
  ig identity activate <name>      Activate an existing identity
  ig identity list                 List available identities
  ig server                        Show current server
  ig server set <url>              Connect to a hub server
  ig server login                  Log in with your active identity
  ig server logout                 Log out
  ig server push [--all]            Push local objects to server
  ig server remove                 Disconnect (go offline)
  ig realm                              Show current default realm
  ig realm set identity                 Go private (identity realm)
  ig realm set dataverse001             Go public
  ig realm set local                    Local only (never synced)
  ig realm set <realm>                  Set a specific realm

Run 'ig <command> --help' for command-specific help.`)
  process.exit(0)
}

function commandUsage(command) {
  const docs = {
    get: `Usage: ig get <ref> [--identity N] [--raw]\n\nFetch an object by ref and print its JSON envelope.\n\nFlags:\n  --identity N  Authenticate as identity N to access private objects\n  --raw         Skip realm filtering (show objects from any realm)`,
    search: `Usage: ig search [--type T] [--by PK] [--limit N] [--cursor C] [--counts] [--json] [--raw]\n\nSearch objects on the configured hub/store.\n\nFlags:\n  --type T     Filter by object type\n  --by PK      Filter by pubkey\n  --limit N    Max results (default: 20)\n  --cursor C   Pagination cursor from previous result\n  --counts     Include inbound relation counts\n  --json       Output raw JSON array\n  --raw        Skip realm filtering (show objects from any realm)`,
    inbound: `Usage: ig inbound <ref> [--relation R] [--type T] [--from PK] [--limit N] [--cursor C] [--counts] [--json] [--raw]\n\nList objects that point to the target ref.\n\nFlags:\n  --relation R  Filter by relation name\n  --type T      Filter by source object type\n  --from PK     Filter by source object pubkey\n  --limit N     Max results (default: 20)\n  --cursor C    Pagination cursor from previous result\n  --counts      Include inbound relation counts\n  --json        Output raw JSON array\n  --raw         Skip realm filtering (show objects from any realm)`,
    verify: `Usage: ig verify <file.json>\n\nVerify an instructionGraph001 envelope on disk.`,
    sign: `Usage: ig sign <spec.json>\n\nBuild and sign a spec, then print the canonical envelope JSON.`,
    create: `Usage: ig create <spec.json> [--update] [--identity N] [--realm R] [--push] [--no-push]\n\nBuild, sign, and publish a spec to the configured store.\n\nSpec format (JSON):\n  All fields are optional. Auto-filled: id, pubkey, ref, in, created_at,\n  relations.author. Recommended:\n    type         Object type (e.g. POST, NOTE, COMMENT)\n    name         Short human-readable label\n    instruction  How agents should interpret/display this object\n    content      Free-form payload (e.g. { "title": "...", "body": "..." })\n  Other fields:\n    id           UUID (auto-generated if omitted)\n    in           Realm array (default: your active realm)\n    relations    Named arrays of { ref } links to other objects\n    rights       { license, ai_training_allowed }\n\n  The instruction field is key — it makes objects self-describing so any\n  agent (human or LLM) can understand them without external docs.\n\n  If using a type, add a type_def relation so the schema is validated:\n    "relations": { "type_def": [{ "ref": "<pubkey>.<type-uuid>" }] }\n\n  Structural objects should include a root relation for discoverability:\n    "relations": { "root": [{ "ref": "AxyU5_...00000000-...",\n      "url": "https://dataverse001.net/AxyU5_...00000000-..." }] }\n\nExample:\n  {\n    "type": "POST",\n    "name": "Hello",\n    "instruction": "A post. Display title and body.",\n    "content": { "title": "Hello!", "body": "First post!" }\n  }\n\nFlags:\n  --update      Allow updating existing objects (auto-increments revision,\n                sets updated_at). Without this, fails if object exists.\n  --identity N  Sign with identity N instead of active identity\n  --realm R     Override default realm (e.g. dataverse001, identity)\n  --push        Push to server (auto-login if needed for identity realm)\n  --no-push     Store locally only, skip server push`,

    identity: `Usage: ig identity [generate|activate|list] [options]\n\nShow or manage the active identity.\n\nSubcommands:\n  ig identity generate [--name N] [--project] [--activate]\n  ig identity activate <name>\n  ig identity list\n\nEnvironment:\n  INSTRUCTIONGRAPH_DIR  Override config directory location`,
    server: `Usage: ig server [set <url> | login | logout | remove | push]\n\nShow, configure, or remove the hub server connection.\n\nSubcommands:\n  ig server              Show current server status and auth\n  ig server set <url>    Connect to a hub server for sync\n  ig server login        Log in with your active identity\n  ig server logout       Log out from the hub\n  ig server remove       Disconnect and go offline\n  ig server push [--all]  Push local objects (default: your realms only)\n\nWithout a server, all data stays on local filesystem only.\nWith a server, objects sync between local storage and the hub.\nLogin uses your active identity (see ig identity).`,
    realm: `Usage: ig realm [set <realm|identity|dataverse001|local>]\n\nShow or set the default realm used for new objects.\n\n  ig realm set identity       Use current identity\'s realm (private)\n  ig realm set dataverse001   Use the public dataverse realm\n  ig realm set local          Local only \u2014 never synced to any server\n  ig realm set <pubkey>       Use any specific realm`
  }

  if (!docs[command]) die(`Unknown command: ${command}\nRun 'ig --help' for usage.`)
  console.log(docs[command])
  process.exit(0)
}

// ─── Config resolution ───────────────────────────────────────────

function homeConfigDir() {
  return join(process.env.HOME || '~', '.instructionGraph')
}

function findConfigDir() {
  // 1. Env var override
  if (process.env.INSTRUCTIONGRAPH_DIR) return process.env.INSTRUCTIONGRAPH_DIR

  // 2. Walk up from cwd for project-local .instructionGraph/
  let dir = process.cwd()
  while (dir !== '/') {
    const igDir = join(dir, '.instructionGraph')
    if (existsSync(join(igDir, 'config')) || existsSync(join(igDir, 'data')) || existsSync(join(igDir, 'identities'))) return igDir
    dir = resolve(dir, '..')
  }

  // 3. Default: ~/.instructionGraph (always - never null)
  return homeConfigDir()
}

function readConfig(configDir, name, defaultVal) {
  const localPath = join(configDir, 'config', name)
  if (existsSync(localPath)) return readFileSync(localPath, 'utf-8').trim()

  // Fall back to home config if configDir is project-local
  // Skip fallback when INSTRUCTIONGRAPH_DIR is set (fully self-contained)
  if (!process.env.INSTRUCTIONGRAPH_DIR) {
    const home = homeConfigDir()
    if (configDir !== home) {
      const homePath = join(home, 'config', name)
      if (existsSync(homePath)) return readFileSync(homePath, 'utf-8').trim()
    }
  }
  return defaultVal
}

function resolveIdentityConfig(configDir) {
  const identityName = readConfig(configDir, 'active-identity', 'default')

  // Check configDir first, then home (if different)
  // Skip fallback when INSTRUCTIONGRAPH_DIR is set (fully self-contained)
  const candidates = [join(configDir, 'identities', identityName, 'private.pem')]
  if (!process.env.INSTRUCTIONGRAPH_DIR) {
    const home = homeConfigDir()
    if (configDir !== home) {
      candidates.push(join(home, 'identities', identityName, 'private.pem'))
    }
  }

  for (const pemPath of candidates) {
    if (existsSync(pemPath)) {
      return { type: 'pem-file', path: pemPath, name: identityName }
    }
  }
  return null
}

function writeConfig(configDir, name, value) {
  const configPath = join(configDir, 'config')
  mkdirSync(configPath, { recursive: true })
  writeFileSync(join(configPath, name), `${value}\n`)
}

function resolveIdentityPemPath(configDir, identityName) {
  const candidates = [join(configDir, 'identities', identityName, 'private.pem')]
  if (!process.env.INSTRUCTIONGRAPH_DIR) {
    const home = homeConfigDir()
    if (configDir !== home) {
      candidates.push(join(home, 'identities', identityName, 'private.pem'))
    }
  }
  return candidates.find(existsSync) || null
}

/** List identities only in the given configDir (no home fallback). */
function listLocalIdentityNames(configDir) {
  const dir = join(configDir, 'identities')
  const names = []
  if (!existsSync(dir)) return names
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (existsSync(join(dir, entry.name, 'private.pem'))) names.push(entry.name)
  }
  return names.sort()
}

function listIdentityNames(configDir) {
  const dirs = [join(configDir, 'identities')]
  if (!process.env.INSTRUCTIONGRAPH_DIR) {
    const home = homeConfigDir()
    if (configDir !== home) dirs.push(join(home, 'identities'))
  }

  const names = new Set()
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      if (existsSync(join(dir, entry.name, 'private.pem'))) names.add(entry.name)
    }
  }
  return [...names].sort()
}

/**
 * @param {object} [overrides]
 * @param {string} [overrides.identityName] - Use a specific identity instead of active
 * @param {string} [overrides.realm] - Override the default realm
 * @param {string} [overrides.token] - Override the auth token
 * @param {boolean} [overrides.authenticate] - Authenticate with hub on connect
 * @param {boolean} [overrides.skipRealmCheck] - Disable realm filtering (--raw)
 */
async function makeClient(overrides = {}) {
  const configDir = findConfigDir()
  const hubUrl = readConfig(configDir, 'hub-url', null)  // null = no server configured
  const defaultRealm = overrides.realm || readConfig(configDir, 'default-realm', null)
  const dataDir = join(configDir, 'data')
  const hasLocal = existsSync(dataDir)

  let store
  let hub = null
  let isOnline = false

  // Load persisted auth token if available
  const savedToken = overrides.token ?? readConfig(configDir, 'auth-token', null)

  // Load shared realm cache (1h TTL)
  // Note: actual pubkey matching happens after identity is resolved (below)
  const REALM_CACHE_TTL_MS = 60 * 60 * 1000
  const srCache = loadSharedRealms(configDir)
  let sharedRealms = [] // populated after identity is resolved, if cache pubkey matches
  const cacheExpired = srCache?.fetched_at
    ? (Date.now() - new Date(srCache.fetched_at).getTime()) > REALM_CACHE_TTL_MS
    : true

  // Realm filter: uses mutable state, resolved after identity loads
  const filterState = { pubkey: null, realms: sharedRealms, enabled: !overrides.skipRealmCheck }
  const realmFilter = (obj) => {
    if (!filterState.enabled || !filterState.pubkey) return true
    return isVisible(obj, filterState.pubkey, filterState.realms)
  }

  if (hubUrl && hasLocal) {
    // Both: sync store (local primary, hub sync)
    const local = createFsStore({ dataDir, filter: realmFilter })
    hub = createHubStore({ url: hubUrl, token: savedToken })
    store = createSyncStore({ local, remote: hub, sharedRealms, configDir })
    isOnline = true
  } else if (hubUrl) {
    // Hub only (no local data dir yet)
    hub = createHubStore({ url: hubUrl, token: savedToken })
    store = hub
    isOnline = true
  } else if (hasLocal) {
    // Local only (offline mode)
    store = createFsStore({ dataDir, filter: realmFilter })
  } else {
    // Nothing configured
    die(
      'No InstructionGraph configured.\n' +
      'Run \'ig identity generate\' to get started.'
    )
  }

  // Resolve identity: override or active
  let identity
  if (overrides.identityName) {
    const pemPath = resolveIdentityPemPath(configDir, overrides.identityName)
    if (!pemPath) die(`Identity not found: ${overrides.identityName}`)
    identity = { type: 'pem-file', path: pemPath, name: overrides.identityName }
  } else {
    identity = resolveIdentityConfig(configDir)
  }

  const client = createClient({ store, identity, defaultRealm })
  if (identity) await client.ready

  // Activate realm filter now that identity is resolved
  filterState.pubkey = client.pubkey
  // Only use cached shared realms if they belong to the active identity
  // AND the cache is still fresh (1h TTL).
  if (srCache?.pubkey && srCache.pubkey === client.pubkey && !cacheExpired) {
    sharedRealms = srCache.realms || []
    filterState.realms = sharedRealms
  }
  // Update sync store's realm context for its own filtering
  if (store.setRealmContext) {
    store.setRealmContext(client.pubkey, sharedRealms)
  }

  // Auto-authenticate if requested (e.g. ig get --identity).
  // This is the only safe time to refresh shared realms, because we know
  // the token was minted for the active identity in this session.
  if (overrides.authenticate && isOnline && hub) {
    if (!client.signer) die('Cannot authenticate — no identity configured.')
    const authResult = await client.authenticate()
    if (!authResult.ok) die(`Authentication failed for identity: ${overrides.identityName || 'active'}`)
    if (authResult.sharedRealms) {
      sharedRealms = authResult.sharedRealms
      filterState.realms = authResult.sharedRealms
      if (store.setRealmContext) {
        store.setRealmContext(client.pubkey, authResult.sharedRealms)
      }
    }
  }

  return { client, configDir, isOnline, hubUrl, hub, store }
}

// ─── Identity generation ─────────────────────────────────────────

async function identityGenerate() {
  // Determine target directory: --project → ./.instructionGraph, else default
  let configDir
  if (args.includes('--project')) {
    configDir = join(process.cwd(), '.instructionGraph')
  } else if (process.env.INSTRUCTIONGRAPH_DIR) {
    configDir = process.env.INSTRUCTIONGRAPH_DIR
  } else {
    configDir = homeConfigDir()
  }

  const name = flag('name') || 'default'
  const identityDir = join(configDir, 'identities', name)
  const pemPath = join(identityDir, 'private.pem')

  if (existsSync(pemPath)) {
    die(`Identity "${name}" already exists at ${pemPath}`)
  }

  // Bootstrap: create full directory structure if this is the first identity
  const isFirstSetup = !existsSync(configDir)
  mkdirSync(join(configDir, 'data'), { recursive: true })
  mkdirSync(join(configDir, 'config'), { recursive: true })
  mkdirSync(identityDir, { recursive: true })

  // Generate extractable keypair so we can export to PEM
  const kp = await generateKeypair({ extractable: true })

  // Export private key as PKCS#8 PEM
  const pkcs8 = new Uint8Array(
    await globalThis.crypto.subtle.exportKey('pkcs8', kp.privateKey)
  )
  let b = ''
  for (let i = 0; i < pkcs8.length; i++) b += String.fromCharCode(pkcs8[i])
  const b64 = btoa(b).match(/.{1,64}/g).join('\n')
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`

  writeFileSync(pemPath, pem, { mode: 0o600 })

  if (isFirstSetup) {
    console.log(`Initialized InstructionGraph at ${configDir}`)
    console.log(`  Created: ${join(configDir, 'data/')}`)
    console.log(`  Created: ${join(configDir, 'config/')}`)
    console.log(`  Created: ${join(configDir, 'identities/')}`)

    // Bootstrap root node into data/
    try {
      const { bootstrapRootNode } = await import('../src/bootstrap.js')
      const hubUrl = readConfig(configDir, 'hub-url', null)
      await bootstrapRootNode(join(configDir, 'data'), hubUrl)
    } catch (e) {
      console.warn(`Note: could not bootstrap root node (${e.message})`)
    }
  }

  console.log(`Generated identity: ${name}`)
  console.log(`Pubkey: ${kp.pubkey}`)
  console.log(`PEM saved: ${pemPath}`)

  // Auto-activate first identity in this configDir, or when --activate is passed
  const localIdentities = listLocalIdentityNames(configDir)
  if (args.includes('--activate') || localIdentities.length <= 1) {
    writeConfig(configDir, 'active-identity', name)
    if (args.includes('--activate') || isFirstSetup) {
      console.log('Set as active identity')
    }
  }

  // Nudge: if no server configured, explain offline mode
  const hubUrl = readConfig(configDir, 'hub-url', null)
  if (!hubUrl) {
    console.log('')
    console.log('You are currently offline - objects stay on local filesystem only.')
    console.log('To sync with a hub server:')
    console.log('  ig server set https://dataverse001.net')
  }
}

async function identityActivate() {
  const name = args[2]
  if (!name) die('Usage: ig identity activate <name>')

  const configDir = findConfigDir()
  const pemPath = resolveIdentityPemPath(configDir, name)
  if (!pemPath) die(`Identity not found: ${name}`)

  const { importPEM } = await import('../src/identity.js')
  const kp = await importPEM(readFileSync(pemPath, 'utf-8'))

  writeConfig(configDir, 'active-identity', name)
  console.log(`Activated identity: ${name}`)
  console.log(`Pubkey: ${kp.pubkey}`)

  // If the default realm is an identity realm (explicit or implicit), follow the new identity
  const currentRealm = readConfig(configDir, 'default-realm', null)
  const isIdentityRealm = currentRealm === null  // implicit: identity realm by default
    || (currentRealm !== 'dataverse001' && currentRealm !== kp.pubkey)
  if (isIdentityRealm) {
    writeConfig(configDir, 'default-realm', kp.pubkey)
    console.log(`Updated default realm to identity realm: ${kp.pubkey}`)
  }

  // Re-login if there's an existing server session
  const savedToken = readConfig(configDir, 'auth-token', null)
  const hubUrl = readConfig(configDir, 'hub-url', null)
  if (savedToken && hubUrl) {
    console.log('Re-authenticating with server...')
    try {
      // Build a fresh client with the new identity and authenticate
      const dataDir = join(configDir, 'data')
      const { createHubStore } = await import('../src/store/hub.js')
      const { createFsStore } = await import('../src/store/fs.js')
      const { createSyncStore } = await import('../src/store/sync.js')
      const { createClient } = await import('../src/client.js')

      const local = existsSync(dataDir) ? createFsStore({ dataDir }) : null
      const hub = createHubStore({ url: hubUrl })
      const store = local ? createSyncStore({ local, remote: hub }) : hub
      const identity = { type: 'pem-file', path: pemPath, name }
      const client = createClient({ store, identity })
      await client.ready

      const result = await client.authenticate()
      if (result.ok) {
        writeConfig(configDir, 'auth-token', result.token)
        console.log(`Logged in as ${kp.pubkey}`)
      } else {
        // Clear stale token
        const tokenPath = join(configDir, 'config', 'auth-token')
        if (existsSync(tokenPath)) unlinkSync(tokenPath)
        console.warn('Re-login failed. Run \'ig server login\' to authenticate.')
      }
    } catch (e) {
      console.warn(`Re-login failed: ${e.message}`)
      console.warn('Run \'ig server login\' to authenticate manually.')
    }
  }
}

function identityList() {
  const configDir = findConfigDir()
  const activeName = readConfig(configDir, 'active-identity', 'default')
  const names = listIdentityNames(configDir)

  if (names.length === 0) {
    console.log('No identities found')
    return
  }

  for (const name of names) {
    console.log(name === activeName ? `* ${name}` : `  ${name}`)
  }
}

async function showRealm() {
  const configDir = findConfigDir()
  const configuredRealm = readConfig(configDir, 'default-realm', null)

  if (configuredRealm) {
    if (configuredRealm === 'dataverse001') {
      console.log(`Current realm: dataverse001 (public)`)
      console.log('New objects will be visible to everyone.')
    } else if (configuredRealm === 'local') {
      console.log(`Current realm: local (local only — never synced)`)
      console.log('New objects stay on the local filesystem only.')
      console.log('They are never uploaded to a server, even when logged in.')
    } else {
      console.log(`Current realm: ${configuredRealm}`)
    }
  } else {
    // No explicit realm - check if we have an identity (identity realm default)
    const identityConfig = resolveIdentityConfig(configDir)
    if (identityConfig) {
      const { importPEM } = await import('../src/identity.js')
      const pem = readFileSync(identityConfig.path, 'utf-8')
      const kp = await importPEM(pem)
      console.log(`Current realm: ${kp.pubkey} (identity realm - private)`)
      console.log('New objects will only be visible to you.')
    } else {
      console.log('Current realm: <no identity configured>')
    }
  }

  console.log('')
  console.log('The realm controls who can see your objects:')
  console.log('  dataverse001     Public - visible to everyone')
  console.log('  <your pubkey>    Private - only visible to you (identity realm)')
  console.log('  local            Local only - never uploaded to any server')
  console.log('')
  console.log('When connected to a server, public and private objects are uploaded.')
  console.log('Private objects are only accessible to you after you log in.')
  console.log('Local objects are NEVER uploaded, even when logged in.')
  console.log('')
  console.log('To switch:')
  console.log('  ig realm set dataverse001        Go public')
  console.log('  ig realm set identity            Go private (use current identity realm)')
  console.log('  ig realm set local               Local only (never synced)')
}

async function setRealm() {
  let realm = args[2]
  if (!realm) die('Usage: ig realm set <realm|identity|dataverse001>')

  const configDir = findConfigDir()

  if (realm === 'identity') {
    const identityConfig = resolveIdentityConfig(configDir)
    if (!identityConfig) die('No identity configured. Run \'ig identity generate\' first.')
    const { importPEM } = await import('../src/identity.js')
    const kp = await importPEM(readFileSync(identityConfig.path, 'utf-8'))
    realm = kp.pubkey
  }

  writeConfig(configDir, 'default-realm', realm)

  if (realm === 'dataverse001') {
    console.log('Set default realm: dataverse001 (public)')
    console.log('New objects will be visible to everyone.')
  } else if (realm === 'local') {
    console.log('Set default realm: local (local only)')
    console.log('New objects stay on the local filesystem only.')
    console.log('They are never uploaded to a server, even when logged in.')
  } else {
    console.log(`Set default realm: ${realm} (identity realm - private)`)
    console.log('New objects will only be visible to you.')
  }
}

// ─── Server management ───────────────────────────────────────────

function showServer() {
  const configDir = findConfigDir()
  const hubUrl = readConfig(configDir, 'hub-url', null)

  if (hubUrl) {
    console.log(`Server: ${hubUrl}`)
    console.log('Objects sync between local filesystem and the hub.')
    console.log('')

    const savedToken = readConfig(configDir, 'auth-token', null)
    if (savedToken) {
      console.log('\x1b[32m●\x1b[0m Authenticated')
      console.log('  You can read and write both public and private objects.')
    } else {
      console.log('\x1b[33m○\x1b[0m Not authenticated')
      console.log('  You can read and write public objects (realm: dataverse001).')
      console.log('  Private objects (identity realm) stay local until you log in.')
      console.log('  Run \'ig server login\' to sync private objects with the server.')
    }
  } else {
    console.log('No server configured (offline mode).')
    console.log('Objects are stored on local filesystem only.')
    console.log('')
    console.log('To connect to a hub server:')
    console.log('  ig server set https://dataverse001.net')
    console.log('')
    console.log('What does connecting do?')
    console.log('  \u2022 Your public objects (realm: dataverse001) become discoverable by others')
    console.log('  \u2022 You can discover and fetch objects created by others')
    console.log('  \u2022 Local copies are always kept \u2014 you keep working if the server goes down')
    console.log('  \u2022 Private objects (identity realm) stay local until you log in')
    console.log('    with \'ig server login\', then they sync with the server too')
  }
}

async function showStatus() {
  const configDir = findConfigDir()
  const home = homeConfigDir()
  const isProjectLocal = configDir !== home

  // ─── Storage ───
  console.log('\x1b[1mStorage\x1b[0m')
  console.log(`  Config: ${join(configDir, 'config')}`)
  const dataDir = join(configDir, 'data')
  if (existsSync(dataDir)) {
    const files = readdirSync(dataDir).filter(f => f.endsWith('.json'))
    console.log(`  Data:   ${dataDir} (${files.length} object${files.length === 1 ? '' : 's'})`)
  } else {
    console.log(`  Data:   ${dataDir} \x1b[33m(not created)\x1b[0m`)
  }
  const identitiesDir = join(configDir, 'identities')
  console.log(`  Keys:   ${identitiesDir}${existsSync(identitiesDir) ? '' : ' \x1b[2m(not found)\x1b[0m'}`)
  console.log('')

  // ─── Identities ───
  console.log('\x1b[1mIdentities\x1b[0m')
  const allNames = listIdentityNames(configDir)
  if (allNames.length === 0) {
    console.log('  \x1b[33mNo identities found\x1b[0m')
    console.log('  Run \'ig identity generate\' to create one.')
  } else {
    const activeName = readConfig(configDir, 'active-identity', 'default')
    for (const name of allNames) {
      const pemPath = resolveIdentityPemPath(configDir, name)
      const isActive = name === activeName && pemPath
      let line = isActive ? `  \x1b[32m● ${name}\x1b[0m` : `  ○ ${name}`
      if (pemPath) {
        try {
          const { importPEM } = await import('../src/identity.js')
          const pem = readFileSync(pemPath, 'utf-8')
          const kp = await importPEM(pem)
          line += `  ${kp.pubkey}`
        } catch {
          line += '  \x1b[33m(could not read key)\x1b[0m'
        }
      } else {
        line += '  \x1b[33m(PEM not found)\x1b[0m'
      }
      console.log(line)
    }
    if (!resolveIdentityPemPath(configDir, activeName)) {
      console.log(`  \x1b[33mActive identity "${activeName}" not found.\x1b[0m`)
      console.log(`  Run 'ig identity activate <name>' to fix.`)
    }
  }
  console.log('')

  // ─── Realm ───
  console.log('\x1b[1mDefault Realm\x1b[0m')
  const defaultRealm = readConfig(configDir, 'default-realm', null)
  if (defaultRealm) {
    const realmLabel = defaultRealm === 'dataverse001' ? '(public)' :
      defaultRealm === 'local' ? '(local only \u2014 never synced)' :
      defaultRealm.length === 44 ? '(identity realm \u2014 private)' : ''
    console.log(`  ${defaultRealm}${realmLabel ? ` \x1b[2m${realmLabel}\x1b[0m` : ''}`)
  } else {
    // Derive from active identity like makeClient does
    const activeName = readConfig(configDir, 'active-identity', 'default')
    const pemPath = resolveIdentityPemPath(configDir, activeName)
    if (pemPath) {
      try {
        const { importPEM } = await import('../src/identity.js')
        const pem = readFileSync(pemPath, 'utf-8')
        const kp = await importPEM(pem)
        console.log(`  ${kp.pubkey} \x1b[2m(identity realm — private by default)\x1b[0m`)
      } catch {
        console.log('  \x1b[33m(could not determine — no active identity)\x1b[0m')
      }
    } else {
      console.log('  \x1b[33m(not set — no active identity)\x1b[0m')
      console.log('  Run \'ig realm set <realm>\' to configure.')
    }
  }
  console.log('')

  // ─── Server ───
  console.log('\x1b[1mServer\x1b[0m')
  const hubUrl = readConfig(configDir, 'hub-url', null)
  if (hubUrl) {
    console.log(`  URL: ${hubUrl}`)
    const savedToken = readConfig(configDir, 'auth-token', null)
    if (savedToken) {
      console.log('  Auth: \x1b[32m● logged in\x1b[0m')
    } else {
      console.log('  Auth: \x1b[33m○ not logged in\x1b[0m')
      console.log('  Run \'ig server login\' to sync private objects.')
    }
  } else {
    console.log('  \x1b[33m○ offline\x1b[0m (no server configured)')
    console.log('  Run \'ig server set <url>\' to connect.')
  }
}

function setServer() {
  const url = args[2]
  if (!url) die('Usage: ig server set <url>')

  try { new URL(url) } catch { die(`Invalid URL: ${url}`) }

  const configDir = findConfigDir()
  writeConfig(configDir, 'hub-url', url)
  console.log(`Connected to ${url}`)
  console.log('Objects will now sync between local filesystem and the hub.')
  console.log('')
  console.log('Public objects (realm: dataverse001) will be visible to everyone.')
  console.log('Private objects (identity realm) stay local until you log in with \'ig server login\'.')
  console.log('')
  console.log('If you have existing local objects, push them to the server:')
  console.log('  ig server push')
}

async function serverPush() {
  const pushAll = args.includes('--all')
  const configDir = findConfigDir()
  const hubUrl = readConfig(configDir, 'hub-url', null)
  if (!hubUrl) die('No server configured. Run \'ig server set <url>\' first.')

  const dataDir = join(configDir, 'data')
  if (!existsSync(dataDir)) die('No local data directory found.')

  const local = createFsStore({ dataDir })
  const hub = createHubStore({ url: hubUrl })
  const sync = createSyncStore({ local, remote: hub })

  // Authenticate if we have a saved token (needed for private objects)
  const savedToken = readConfig(configDir, 'auth-token', null)
  if (savedToken) {
    hub.setToken(savedToken)
  }

  // Determine which realms to push
  let realms = null  // null = all realms (--all)
  let pubkey = null
  if (!pushAll) {
    realms = ['dataverse001']
    const identityConfig = resolveIdentityConfig(configDir)
    if (identityConfig) {
      try {
        const { importPEM } = await import('../src/identity.js')
        const pem = readFileSync(identityConfig.path, 'utf-8')
        const kp = await importPEM(pem)
        pubkey = kp.pubkey
        realms.push(pubkey)
      } catch { /* ignore — push public only */ }
    }
    console.log(`Pushing objects in realms: ${realms.join(', ')}...`)
    if (!savedToken && pubkey) {
      console.log('(Not logged in — private objects will be skipped. Run \'ig server login\' first.)')
    }
  } else {
    console.log(`Pushing all local objects to ${hubUrl}...`)
    if (!savedToken) {
      console.log('(Not logged in — private objects will be skipped. Run \'ig server login\' first.)')
    }
  }

  const result = await sync.pushAll({
    realms,
    onProgress({ ref, index, total, status, error }) {
      const n = `[${index + 1}/${total}]`
      if (status === 'ok') {
        process.stderr.write(`${n} \x1b[32m✓\x1b[0m ${ref}\n`)
      } else if (status === 'skipped') {
        process.stderr.write(`${n} \x1b[33m⊘\x1b[0m ${ref} (skipped)\n`)
      } else {
        process.stderr.write(`${n} \x1b[31m✗\x1b[0m ${ref}: ${error}\n`)
      }
    }
  })

  console.log('')
  const parts = [`${result.pushed} pushed`]
  if (result.skipped) parts.push(`${result.skipped} skipped`)
  if (result.errors) parts.push(`${result.errors} errors`)
  parts.push(`${result.total} total`)
  console.log(`Done. ${parts.join(', ')}.`)
}

function removeServer() {
  const configDir = findConfigDir()
  const configPath = join(configDir, 'config', 'hub-url')

  if (!existsSync(configPath)) {
    console.log('No server configured (already offline).')
    return
  }

  unlinkSync(configPath)

  // Clear auth token too
  const tokenPath = join(configDir, 'config', 'auth-token')
  if (existsSync(tokenPath)) unlinkSync(tokenPath)

  console.log('Server removed. Now in offline mode.')
  console.log('Your local objects are still on disk \u2014 nothing was deleted.')
}

async function serverLogin() {
  const ctx = await makeClient()
  if (!ctx.isOnline) die('No server configured. Run \'ig server set <url>\' first.')
  printStatus(ctx)
  const result = await ctx.client.authenticate()
  if (result.ok) {
    writeConfig(ctx.configDir, 'auth-token', result.token)
    console.log(`Logged in as ${result.pubkey}`)
    console.log('')
    console.log('Private objects that were local-only can now sync with the server.')
    console.log('Run \'ig server push\' to upload them.')
  } else {
    die('Login failed')
  }
}

async function serverLogout() {
  const configDir = findConfigDir()
  const hubUrl = readConfig(configDir, 'hub-url', null)
  if (!hubUrl) die('No server configured.')

  const tokenPath = join(configDir, 'config', 'auth-token')
  if (!existsSync(tokenPath)) {
    console.log('Not logged in.')
    return
  }

  // Best-effort: notify the hub
  const token = readFileSync(tokenPath, 'utf-8').trim()
  try {
    await fetch(`${hubUrl}/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    })
  } catch { /* hub unreachable - still clear local token */ }

  unlinkSync(tokenPath)
  console.log('Logged out.')
}

// ─── Status ──────────────────────────────────────────────────────

/** Print online/offline status to stderr (doesn't interfere with JSON on stdout). */
function printStatus({ isOnline, hubUrl }) {
  if (isOnline) {
    process.stderr.write(`\x1b[32m\u25cf\x1b[0m ${hubUrl}\n`)
  } else {
    process.stderr.write(`\x1b[33m\u25cb\x1b[0m offline \x1b[2m(ig server set <url> to connect)\x1b[0m\n`)
  }
}

// ─── Commands ────────────────────────────────────────────────────

/** Commands that skip makeClient and status line. */
const QUIET_COMMANDS = new Set(['identity', 'server', 'status', 'verify', 'get', 'search', 'inbound'])

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h') usage()
  if (hasHelp()) commandUsage(cmd)

  switch (cmd) {
    case 'status': {
      await showStatus()
      break
    }

    case 'get': {
      const ref = args[1]
      if (!ref) die('Usage: ig get <ref>')

      const identityName = flag('identity')
      const raw = args.includes('--raw')
      const ctx = await makeClient({ identityName, authenticate: !!identityName, skipRealmCheck: raw })
      const obj = await ctx.client.get(ref)
      if (!obj) die(`Not found: ${ref}`)
      console.log(JSON.stringify(obj, null, 2))
      break
    }

    case 'search': {
      const raw = args.includes('--raw')
      const ctx = await makeClient({ skipRealmCheck: raw })
      const result = await ctx.client.search({
        type: flag('type'),
        by: flag('by'),
        limit: flag('limit') ? parseInt(flag('limit')) : 20,
        cursor: flag('cursor'),
        includeInboundCounts: args.includes('--counts')
      })
      if (args.includes('--json')) {
        for (const item of result.items) console.log(canonicalJSON(item))
      } else {
        for (const item of result.items) {
          const i = item.item
          let line = `${i.ref}  ${i.type || '?'}  ${i.name || i.content?.title || '(no name)'}`
          if (item._inbound_counts) {
            const counts = Object.entries(item._inbound_counts).map(([k, v]) => `${k}:${v}`).join(' ')
            line += `  [${counts}]`
          }
          console.log(line)
        }
      }
      if (result.cursor) console.log(`\n... more results (--cursor ${result.cursor})`)
      break
    }

    case 'inbound': {
      const ref = args[1]
      if (!ref) die('Usage: ig inbound <ref>')
      const raw = args.includes('--raw')
      const ctx = await makeClient({ skipRealmCheck: raw })
      const result = await ctx.client.inbound(ref, {
        relation: flag('relation'),
        type: flag('type'),
        from: flag('from'),
        limit: flag('limit') ? parseInt(flag('limit')) : 20,
        cursor: flag('cursor'),
        includeInboundCounts: args.includes('--counts')
      })
      if (args.includes('--json')) {
        for (const item of result.items) console.log(canonicalJSON(item))
      } else {
        for (const item of result.items) {
          const i = item.item
          let line = `${i.ref}  ${i.type || '?'}  ${i.name || i.content?.title || ''}`
          if (item._inbound_counts) {
            const counts = Object.entries(item._inbound_counts).map(([k, v]) => `${k}:${v}`).join(' ')
            line += `  [${counts}]`
          }
          console.log(line)
        }
      }
      if (result.cursor) console.log(`\n... more results (--cursor ${result.cursor})`)
      break
    }

    case 'verify': {
      const file = args[1]
      if (!file) die('Usage: ig verify <file.json>')
      const obj = JSON.parse(readFileSync(resolve(file), 'utf-8'))
      if (!isEnvelope(obj)) die('Not an instructionGraph001 envelope')
      const valid = await verify(obj.item.pubkey, obj.signature, obj.item)
      if (valid) {
        console.log('Verified OK')
        process.exit(0)
      } else {
        console.log('Verification FAILED')
        process.exit(1)
      }
      break
    }

    case 'sign': {
      const file = args[1]
      if (!file) die('Usage: ig sign <spec.json>')
      const ctx = await makeClient()
      printStatus(ctx)
      const spec = JSON.parse(readFileSync(resolve(file), 'utf-8'))
      const item = isEnvelope(spec) ? spec.item : ctx.client.build(spec)
      const envelope = await ctx.client.sign(item)
      console.log(canonicalJSON(envelope))
      break
    }

    case 'create': {
      const file = args[1]
      if (!file) die('Usage: ig create <spec.json>')

      const identityName = flag('identity')
      const realm = flag('realm')
      const noPush = args.includes('--no-push')
      const forcePush = args.includes('--push')
      const allowUpdate = args.includes('--update')

      if (forcePush && noPush) die('Cannot use both --push and --no-push')

      const ctx = await makeClient({ identityName, realm })
      printStatus(ctx)

      const spec = JSON.parse(readFileSync(resolve(file), 'utf-8'))

      // Pre-check: can't target someone else's identity realm
      const specRealms = spec.in || []
      const signerPubkey = ctx.client.pubkey
      const foreignIdentityRealm = specRealms.find(r => r !== 'dataverse001' && r.length === 44 && r !== signerPubkey)
      if (foreignIdentityRealm) {
        die(`Cannot create in identity realm ${foreignIdentityRealm} \u2014 it belongs to a different pubkey.\n` +
            `Your pubkey: ${signerPubkey}`)
      }

      // If --push with identity realm and not logged in, auto-authenticate
      const hasIdentityRealm = specRealms.some(r => r !== 'dataverse001' && r.length === 44)
      if (forcePush && hasIdentityRealm && ctx.isOnline) {
        const savedToken = readConfig(ctx.configDir, 'auth-token', null)
        if (!savedToken) {
          console.log('Authenticating to push to identity realm...')
          const result = await ctx.client.authenticate()
          if (result.ok) {
            writeConfig(ctx.configDir, 'auth-token', result.token)
            console.log(`Logged in as ${result.pubkey}`)
          } else {
            die('Authentication failed \u2014 cannot push to identity realm.')
          }
        }
      }

      if (forcePush && !ctx.isOnline) {
        die('Cannot push \u2014 no server configured. Run \'ig server set <url>\' first.')
      }

      if (noPush) {
        // Local only: build + sign manually, store to fs directly
        const { createFsStore: makeFsStore } = await import('../src/store/fs.js')
        const { isoNow } = await import('../src/object.js')
        const dataDir = join(ctx.configDir, 'data')
        const local = makeFsStore({ dataDir })
        const item = ctx.client.build(spec)

        if (allowUpdate && spec.id) {
          const existing = await local.get(item.ref).catch(() => null)
          if (existing?.item) {
            if (existing.item.pubkey !== signerPubkey) die('Can only update your own objects')
            item.created_at = existing.item.created_at
            item.revision = spec.revision ?? (existing.item.revision || 0) + 1
            item.updated_at = spec.updated_at ?? isoNow()
          }
        }

        await ctx.client.validateType(item)
        const signed = await ctx.client.sign(item)
        await local.put(signed)
        console.log('Stored locally (server push skipped)')
        console.log(signed.item.ref)
      } else {
        // Normal path: client.create handles existence check + update logic
        const ref = await ctx.client.create(spec, { allowUpdate })
        console.log(ref)
      }
      break
    }

    case 'auth':  // hidden alias for 'ig server login'
      await serverLogin()
      break

    case 'identity': {
      const subcmd = args[1]
      if (subcmd === 'generate') {
        await identityGenerate()
      } else if (subcmd === 'activate') {
        await identityActivate()
      } else if (subcmd === 'list') {
        identityList()
      } else {
        const configDir = findConfigDir()
        const identityConfig = resolveIdentityConfig(configDir)
        if (identityConfig) {
          const { importPEM } = await import('../src/identity.js')
          const pem = readFileSync(identityConfig.path, 'utf-8')
          const kp = await importPEM(pem)
          console.log(`Identity: ${identityConfig.name}`)
          console.log(`Pubkey: ${kp.pubkey}`)
        } else {
          console.log('No identity configured')
          console.log('Run \'ig identity generate\' to create one.')
        }
      }
      break
    }

    case 'server': {
      const subcmd = args[1]
      if (!subcmd) {
        showServer()
      } else if (subcmd === 'set') {
        setServer()
      } else if (subcmd === 'login') {
        await serverLogin()
      } else if (subcmd === 'logout') {
        await serverLogout()
      } else if (subcmd === 'remove') {
        removeServer()
      } else if (subcmd === 'push') {
        await serverPush()
      } else {
        die('Usage: ig server [set <url> | login | logout | remove | push]')
      }
      break
    }

    case 'realm': {
      const subcmd = args[1]
      if (!subcmd) {
        await showRealm()
      } else if (subcmd === 'set') {
        await setRealm()
      } else {
        die('Usage: ig realm [set <realm|identity|dataverse001>]')
      }
      break
    }

    default:
      die(`Unknown command: ${cmd}\nRun 'ig --help' for usage.`)
  }
}

main().catch(e => {
  console.error(e.message)
  process.exit(1)
})
