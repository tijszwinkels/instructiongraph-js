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
import { generateKeypair } from '../src/crypto.js'
import {
  homeConfigDir, findConfigDir, readConfig, writeConfig,
  resolveIdentityConfig, resolveIdentityPemPath, resolveRealmAlias,
  listIdentityNames, listLocalIdentityNames,
  openRuntime as makeClient,
} from './runtime.js'

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

/**
 * Pull positional arguments out of argv, skipping flags and their values.
 * @param {string[]} argv - args slice (excluding the command name)
 * @param {string[]} valueFlags - flag names that take a value (without leading --)
 * @returns {string[]}
 */
function positionals(argv, valueFlags = []) {
  const valueFlagSet = new Set(valueFlags.map(f => `--${f}`))
  const out = []
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]
    if (t === '--help' || t === '-h') continue
    if (t.startsWith('-')) {
      if (valueFlagSet.has(t)) i++  // skip the flag's value
      continue
    }
    out.push(t)
  }
  return out
}

function die(msg) {
  console.error(`Error: ${msg}`)
  process.exit(1)
}

function validateFlags(commandName, argv, { booleanFlags = [], valueFlags = [] } = {}) {
  const allowedBoolean = new Set(booleanFlags.map(name => `--${name}`))
  const allowedValue = new Set(valueFlags.map(name => `--${name}`))

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--help' || token === '-h') continue
    if (!token.startsWith('-')) continue

    if (allowedBoolean.has(token)) continue
    if (allowedValue.has(token)) {
      const next = argv[i + 1]
      if (next == null || next.startsWith('-')) {
        die(`Option ${token} requires a value.\nRun 'ig ${commandName} --help' for usage.`)
      }
      i++
      continue
    }

    die(`Unknown option for '${commandName}': ${token}\nRun 'ig ${commandName} --help' for usage.`)
  }
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
  ig search [--identity N] [opts]  Search objects
  ig inbound <ref> [--identity N]  Inbound relations
  ig verify <file.json>            Verify signature
  ig sign <spec.json> [--identity N]  Sign spec, print envelope
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
  ig git init [name] [--realm R]        Create a git repository; prints its ref
  ig git clone <ref> [dir]              Clone a hosted repo (names dir after it)
  ig git fork <upstream> [--name N]     Thin-fork a repo you can contribute to
  ig git merge <fork> [branch]          Merge a fork branch into upstream (owner)
  ig freenet publish <ref>              Publish to Freenet; poke targets' indexes
  ig freenet get <ref> [--rev N]        Read a head, or one immutable revision
  ig freenet inbound <ref>              Inbound-relations index (who points here)
  ig freenet verify <ref>               Verify index slots against their snapshots

Run 'ig <command> --help' for command-specific help.`)
  process.exit(0)
}

function commandUsage(command) {
  const docs = {
    get: `Usage: ig get <ref> [--identity N] [--raw]\n\nFetch an object by ref and print its JSON envelope.\n\nFlags:\n  --identity N  Authenticate as identity N to access private objects\n  --raw         Skip realm filtering (show objects from any realm)`,
    search: `Usage: ig search [--type T] [--by PK] [--limit N] [--cursor C] [--identity N] [--counts] [--jsonl] [--raw] [--local] [--remote]\n\nSearch objects on the configured hub/store.\n\nFlags:\n  --type T      Filter by object type\n  --by PK       Filter by pubkey\n  --limit N     Max results (default: 20)\n  --cursor C    Pagination cursor from previous result\n  --identity N  Authenticate as identity N to access private objects\n  --counts      Include inbound relation counts\n  --jsonl       Output one JSON envelope per line (JSONL)\n  --raw         Skip realm filtering (show objects from any realm)\n  --local       Search local store only (skip hub)\n  --remote      Search hub only (skip local)`,
    inbound: `Usage: ig inbound <ref> [--relation R] [--type T] [--from PK] [--limit N] [--cursor C] [--identity N] [--counts] [--jsonl] [--raw] [--local] [--remote]\n\nList objects that point to the target ref.\n\nFlags:\n  --relation R  Filter by relation name\n  --type T      Filter by source object type\n  --from PK     Filter by source object pubkey\n  --limit N     Max results (default: 20)\n  --cursor C    Pagination cursor from previous result\n  --identity N  Authenticate as identity N to access private objects\n  --counts      Include inbound relation counts\n  --jsonl       Output one JSON envelope per line (JSONL)\n  --raw         Skip realm filtering (show objects from any realm)\n  --local       Search local store only (skip hub)\n  --remote      Search hub only (skip local)`,
    verify: `Usage: ig verify <file.json>\n\nVerify an instructionGraph001 envelope on disk.`,
    sign: `Usage: ig sign <spec.json> [--identity N]\n\nBuild and sign a spec, then print the canonical envelope JSON.\n\nFlags:\n  --identity N  Sign with identity N instead of active identity`,
    create: `Usage: ig create <spec.json> [--update] [--identity N] [--realm R] [--push] [--no-push]\n\nBuild, sign, and publish a spec to the configured store.\n\nSpec format (JSON):\n  All fields are optional. Auto-filled: id, pubkey, ref, in, created_at,\n  relations.author. Recommended:\n    type         Object type (e.g. POST, NOTE, COMMENT)\n    name         Short human-readable label\n    instruction  How agents should interpret/display this object\n    content      Free-form payload (e.g. { "title": "...", "body": "..." })\n  Other fields:\n    id           UUID (auto-generated if omitted)\n    in           Realm array (default: your active realm)\n    relations    Named arrays of { ref } links to other objects\n    rights       { license, ai_training_allowed }\n\n  The instruction field is key — it makes objects self-describing so any\n  agent (human or LLM) can understand them without external docs.\n\n  If using a type, add a type_def relation so the schema is validated:\n    "relations": { "type_def": [{ "ref": "<pubkey>.<type-uuid>" }] }\n\n  Structural objects should include a root relation for discoverability:\n    "relations": { "root": [{ "ref": "AxyU5_...00000000-...",\n      "url": "https://dataverse001.net/AxyU5_...00000000-..." }] }\n\nExample:\n  {\n    "type": "POST",\n    "name": "Hello",\n    "instruction": "A post. Display title and body.",\n    "content": { "title": "Hello!", "body": "First post!" }\n  }\n\nFlags:\n  --update      Allow updating existing objects (auto-increments revision,\n                sets updated_at). Without this, fails if object exists.\n  --identity N  Sign with identity N instead of active identity\n  --realm R     Override default realm (e.g. dataverse001, identity)\n  --push        Push to server (auto-login if needed for identity realm)\n  --no-push     Store locally only, skip server push`,

    identity: `Usage: ig identity [generate|activate|list] [options]\n\nShow or manage the active identity.\n\nFlags:\n  --identity N  Show info for identity N instead of the active one\n\nSubcommands:\n  ig identity generate [--name N] [--project] [--activate]\n  ig identity activate <name>\n  ig identity list\n\nEnvironment:\n  INSTRUCTIONGRAPH_DIR  Override config directory location`,
    server: `Usage: ig server [set <url> | login | logout | remove | push]\n\nShow, configure, or remove the hub server connection.\n\nSubcommands:\n  ig server              Show current server status and auth\n  ig server set <url>    Connect to a hub server for sync\n  ig server login        Log in with your active identity\n  ig server logout       Log out from the hub\n  ig server remove       Disconnect and go offline\n  ig server push [--all]  Push local objects (default: your realms only)\n\nWithout a server, all data stays on local filesystem only.\nWith a server, objects sync between local storage and the hub.\nLogin uses your active identity (see ig identity).`,
    realm: `Usage: ig realm [set <realm|identity|dataverse001|server-public|local>]\n\nShow or set the default realm used for new objects.\n\n  ig realm set identity       Use current identity\'s realm (private)\n  ig realm set dataverse001   Use the public dataverse realm\n  ig realm set server-public  Public on this hub, not propagated globally\n  ig realm set local          Local only \u2014 never synced to any server\n  ig realm set <pubkey>       Use any specific realm`,
    git: `Usage: ig git init [name] [--realm R] [--identity N]\n       ig git clone <ref> [dir] [--identity N]\n       ig git fork <upstream-ref> [--name N] [--realm R] [--identity N]\n       ig git merge <fork-ref> [branch] [--into <upstream>] [--onto <refname>]\n                    [--ff-only | --no-ff] [--message M] [--identity N]\n\nHost git repositories on instructionGraph (git-remote-ig helper).\n\ninit  Create a repository; prints its ref. Push/clone with:\n        git remote add origin ig::<ref> && git push -u origin main\n        git clone ig::<ref>/<name>\n      The /<name> suffix is ignored for resolution; it just gives stock git a\n      friendly checkout directory. Repo lives in your default realm unless\n      --realm is given. Only your identity can push; others fork to contribute.\n\nclone Clone a hosted repository, naming the checkout directory after the repo\n      (or [dir] if given).\n\nfork  Thin-fork an upstream repo (O(1)): a new anchor with forked_from -> the\n      upstream plus a mirrored default branch, no objects copied. You own the\n      fork and can push to it; reads fall through to upstream. Inherits the\n      upstream realm unless --realm is given. Prints the fork ref.\n\nmerge Merge a fork branch back into an upstream you OWN (run from a clone of\n      the upstream, target branch checked out). Fetches the fork delta, runs\n      plain local git (fast-forward or, with --no-ff, a merge commit), signs\n      owner-copies of the new objects into your namespace (each carrying\n      copied_from -> the contributor's original), and CAS-updates the ref.\n      --into defaults to the fork's forked_from upstream; --onto to its\n      default branch. --ff-only refuses a non-fast-forward.`,
  }

  if (!docs[command]) die(`Unknown command: ${command}\nRun 'ig --help' for usage.`)
  console.log(docs[command])
  process.exit(0)
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
  // Preserve well-known realms like 'dataverse001' and 'local'
  const currentRealm = readConfig(configDir, 'default-realm', null)
  const isIdentityRealm = currentRealm === null  // implicit: identity realm by default
    || (currentRealm !== 'dataverse001' && currentRealm !== 'local' && currentRealm !== 'server-public' && currentRealm !== kp.pubkey)
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
    } else if (configuredRealm === 'server-public') {
      console.log(`Current realm: server-public (readable by anyone, not propagated globally)`)
      console.log('New objects will be pushed to the server and readable without auth,')
      console.log('but will not be propagated to other hubs or discovered via global scanning.')
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
  console.log('  dataverse001     Public - visible to everyone, propagated globally')
  console.log('  server-public    Readable by anyone, but stays on this hub only')
  console.log('  <your pubkey>    Private - only visible to you (identity realm)')
  console.log('  local            Local only - never uploaded to any server')
  console.log('')
  console.log('When connected to a server, public, server-public, and private objects are uploaded.')
  console.log('Private objects are only accessible to you after you log in.')
  console.log('Local objects are NEVER uploaded, even when logged in.')
  console.log('')
  console.log('To switch:')
  console.log('  ig realm set dataverse001        Go public (global propagation)')
  console.log('  ig realm set server-public       Public on this hub only (no propagation)')
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
  } else if (realm === 'server-public') {
    console.log('Set default realm: server-public')
    console.log('New objects will be pushed to the server and readable by anyone without auth,')
    console.log('but will not be propagated globally to other hubs.')
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
      defaultRealm === 'server-public' ? '(server-public \u2014 readable by anyone, not propagated)' :
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
    realms = ['dataverse001', 'server-public']
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

// ─── git merge (owner-side, client-computed) ─────────────────────

/**
 * `ig git merge <fork-ref> [branch] [--into <upstream>] [--onto <refname>]
 *                          [--ff-only|--no-ff] [--message M] [--identity N]`
 * Run from a clone of the upstream repo (target branch checked out). Delegates
 * the mechanics to src/git/merge.js; here we only resolve args + the local git.
 */
async function gitMerge() {
  validateFlags('git merge', args.slice(2), {
    booleanFlags: ['ff-only', 'no-ff'],
    valueFlags: ['identity', 'into', 'onto', 'message'],
  })
  const pos = positionals(args.slice(2), ['identity', 'into', 'onto', 'message'])
  if (!pos[0]) {
    die('Usage: ig git merge <fork-ref> [branch] [--into <upstream>] [--onto <refname>] [--ff-only|--no-ff]')
  }
  const sourceRef = pos[0].replace(/^ig::/, '').split('/')[0]
  const sourceBranch = pos[1] || undefined
  const ffOnly = args.includes('--ff-only')
  const noFF = args.includes('--no-ff')
  if (ffOnly && noFF) die('--ff-only and --no-ff are mutually exclusive.')
  const mode = ffOnly ? 'ff-only' : noFF ? 'no-ff' : 'auto'

  const identityName = flag('identity')
  const hasIdentity = !!resolveIdentityConfig(findConfigDir())
  const ctx = await makeClient({ identityName, authenticate: hasIdentity })
  if (!ctx.client.pubkey) die('No identity configured — run \'ig identity generate\' first.')

  const { resolveGitDir } = await import('../src/git/gitio.js')
  const { execFileSync } = await import('node:child_process')
  let gitDir, worktree
  try {
    gitDir = resolveGitDir()
    worktree = execFileSync('git', ['rev-parse', '--show-toplevel']).toString('utf-8').trim()
  } catch {
    die('ig git merge must run inside a git working tree (a clone of the upstream repo).')
  }

  const into = flag('into')
  const { mergeIntoUpstream } = await import('../src/git/merge.js')
  const result = await mergeIntoUpstream({
    client: ctx.client, gitDir, worktree,
    sourceRef, sourceBranch,
    upstreamRef: into ? into.replace(/^ig::/, '').split('/')[0] : undefined,
    targetRefname: flag('onto'),
    mode, message: flag('message'),
  })

  if (result.kind === 'up-to-date') {
    console.error(`Already up to date (${result.targetRef} at ${result.base}).`)
    return
  }
  console.log(result.newTip)
  console.error(
    `Merged (${result.kind}) into ${result.upstreamRef}\n` +
    `  ${result.targetRef}: ${result.base || '(empty)'} → ${result.newTip}\n` +
    `  signed ${result.copied.length} owner-copy object(s) into your namespace`
  )
}

// ─── Commands ────────────────────────────────────────────────────

/** Commands that skip makeClient and status line. */
const QUIET_COMMANDS = new Set(['identity', 'server', 'status', 'verify', 'get', 'search', 'inbound'])

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h') usage()
  // `freenet` documents its own subcommands (and their flags) in cli/freenet.js,
  // so it handles --help itself rather than through the flat docs map.
  if (cmd !== 'freenet' && hasHelp()) commandUsage(cmd)

  switch (cmd) {
    case 'status': {
      validateFlags('status', args.slice(1))
      await showStatus()
      break
    }

    case 'get': {
      validateFlags('get', args.slice(1), { booleanFlags: ['raw'], valueFlags: ['identity'] })
      const [ref] = positionals(args.slice(1), ['identity'])
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
      validateFlags('search', args.slice(1), {
        booleanFlags: ['counts', 'json', 'jsonl', 'raw', 'local', 'remote'],
        valueFlags: ['by', 'cursor', 'identity', 'limit', 'type']
      })
      const identityName = flag('identity')
      const raw = args.includes('--raw')
      const wantLocal = args.includes('--local')
      const wantRemote = args.includes('--remote')
      const ctx = await makeClient({ identityName, authenticate: !!identityName && !wantLocal, skipRealmCheck: raw })
      const isSyncStore = !!ctx.store.setRealmContext
      // Validate source flags against store type
      if (wantLocal && !isSyncStore && ctx.isOnline) {
        die('--local requires a local data directory. Run \'ig identity generate\' first.')
      }
      if (wantRemote && !ctx.isOnline) {
        die('--remote requires a server. Run \'ig server set <url>\' first.')
      }
      // Only pass source to sync store; bare stores already do the right thing
      const source = isSyncStore ? (wantLocal ? 'local' : wantRemote ? 'remote' : 'both') : undefined
      const result = await ctx.client.search({
        type: flag('type'),
        by: flag('by'),
        limit: flag('limit') ? parseInt(flag('limit')) : 20,
        cursor: flag('cursor'),
        includeInboundCounts: args.includes('--counts'),
        ...(source && { source })
      })
      if (args.includes('--jsonl') || args.includes('--json')) {
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
      if (result.cursor) process.stderr.write(`\n... more results (--cursor ${result.cursor})\n`)
      break
    }

    case 'inbound': {
      const inboundValueFlags = ['cursor', 'from', 'identity', 'limit', 'relation', 'type']
      validateFlags('inbound', args.slice(1), {
        booleanFlags: ['counts', 'json', 'jsonl', 'raw', 'local', 'remote'],
        valueFlags: inboundValueFlags
      })
      const [ref] = positionals(args.slice(1), inboundValueFlags)
      if (!ref) die('Usage: ig inbound <ref>')
      const identityName = flag('identity')
      const raw = args.includes('--raw')
      const wantLocal = args.includes('--local')
      const wantRemote = args.includes('--remote')
      const ctx = await makeClient({ identityName, authenticate: !!identityName && !wantLocal, skipRealmCheck: raw })
      const isSyncStore = !!ctx.store.setRealmContext
      if (wantLocal && !isSyncStore && ctx.isOnline) {
        die('--local requires a local data directory. Run \'ig identity generate\' first.')
      }
      if (wantRemote && !ctx.isOnline) {
        die('--remote requires a server. Run \'ig server set <url>\' first.')
      }
      const source = isSyncStore ? (wantLocal ? 'local' : wantRemote ? 'remote' : 'both') : undefined
      const result = await ctx.client.inbound(ref, {
        relation: flag('relation'),
        type: flag('type'),
        from: flag('from'),
        limit: flag('limit') ? parseInt(flag('limit')) : 20,
        cursor: flag('cursor'),
        includeInboundCounts: args.includes('--counts'),
        ...(source && { source })
      })
      if (args.includes('--jsonl') || args.includes('--json')) {
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
      if (result.cursor) process.stderr.write(`\n... more results (--cursor ${result.cursor})\n`)
      break
    }

    case 'verify': {
      const file = args[1]
      if (!file) die('Usage: ig verify <file.json>')
      validateFlags('verify', args.slice(2))
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
      if (!file) die('Usage: ig sign <spec.json> [--identity N]')
      validateFlags('sign', args.slice(2), {
        valueFlags: ['identity']
      })
      const identityName = flag('identity')
      const ctx = await makeClient({ identityName })
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
      validateFlags('create', args.slice(2), {
        booleanFlags: ['no-push', 'push', 'update'],
        valueFlags: ['identity', 'realm']
      })

      const identityName = flag('identity')
      const rawRealm = flag('realm')
      const realm = await resolveRealmAlias(rawRealm, findConfigDir(), identityName)
      const noPush = args.includes('--no-push')
      const forcePush = args.includes('--push')
      const allowUpdate = args.includes('--update')

      if (forcePush && noPush) die('Cannot use both --push and --no-push')

      let spec = JSON.parse(readFileSync(resolve(file), 'utf-8'))

      // Accept a wrapped envelope ({ is: 'instructionGraph001', [signature], item }) — e.g. the output
      // of `ig get` — by unwrapping it to the flat fields buildItem expects. pubkey/ref/signature are
      // re-derived from the signing identity, so strip them to avoid clobbering the signer's state.
      if (spec && spec.is === 'instructionGraph001' && spec.item && typeof spec.item === 'object') {
        console.error('Detected wrapped envelope — unwrapping to flat spec fields.')
        const { pubkey: _pk, ref: _ref, signature: _sig, ...inner } = spec.item
        spec = inner
      }

      // --update without an id would silently fall through and create a brand-new object — refuse.
      if (allowUpdate && !spec.id) {
        die('--update requires the spec to include an "id" field naming the existing object to update.')
      }

      // If spec explicitly targets local realm, ensure makeClient uses a local-capable store
      const effectiveLocalRealm = realm === 'local' || (spec.in && spec.in.includes('local'))
      const ctx = await makeClient({ identityName, realm: effectiveLocalRealm ? 'local' : realm })
      printStatus(ctx)

      // Warn when targeting another identity's realm (hub may accept or reject depending on config)
      const specRealms = spec.in || []
      const signerPubkey = ctx.client.pubkey
      const foreignIdentityRealm = specRealms.find(r => r !== 'dataverse001' && r !== 'local' && r !== 'server-public' && r.length === 44 && r !== signerPubkey)
      if (foreignIdentityRealm) {
        console.error(`Warning: pushing to identity realm ${foreignIdentityRealm} (not your own pubkey).`)
      }

      // If --push with identity realm and not logged in, auto-authenticate.
      // Compute the effective realms that buildItem would produce (spec.in → --realm → default realm → pubkey).
      const effectiveRealms = specRealms.length > 0
        ? specRealms
        : [realm || readConfig(ctx.configDir, 'default-realm', null) || signerPubkey]
      const hasIdentityRealm = effectiveRealms.some(r =>
        r !== 'dataverse001' && r !== 'local' && r !== 'server-public' && r.length === 44)
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
          } else {
            die(`Object ${item.ref} not found locally — cannot update.\nTo create a new object with this id, remove --update.`)
          }
        }

        await ctx.client.validateType(item)
        const signed = await ctx.client.sign(item)
        await local.put(signed)
        console.log('Stored locally (server push skipped)')
        console.log(signed.item.ref)
      } else {
        // Normal path: client.create handles existence check + update logic
        const ref = await ctx.client.create(spec, { allowUpdate, requirePush: forcePush })
        console.log(ref)
      }
      break
    }

    case 'auth':  // hidden alias for 'ig server login'
      validateFlags('server login', args.slice(1))
      await serverLogin()
      break

    case 'identity': {
      const subcmd = args[1]
      if (subcmd === 'generate') {
        validateFlags('identity generate', args.slice(2), {
          booleanFlags: ['activate', 'project'],
          valueFlags: ['name']
        })
        await identityGenerate()
      } else if (subcmd === 'activate') {
        validateFlags('identity activate', args.slice(3))
        await identityActivate()
      } else if (subcmd === 'list') {
        validateFlags('identity list', args.slice(2))
        identityList()
      } else {
        validateFlags('identity', args.slice(1), { valueFlags: ['identity'] })
        const configDir = findConfigDir()
        const requested = flag('identity')
        let identityConfig
        if (requested) {
          const pemPath = resolveIdentityPemPath(configDir, requested)
          identityConfig = pemPath ? { type: 'pem-file', path: pemPath, name: requested } : null
          if (!identityConfig) die(`No identity '${requested}' found. Run 'ig identity list' to see available identities.`)
        } else {
          identityConfig = resolveIdentityConfig(configDir)
        }
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
        validateFlags('server', args.slice(1))
        showServer()
      } else if (subcmd === 'set') {
        validateFlags('server set', args.slice(3))
        setServer()
      } else if (subcmd === 'login') {
        validateFlags('server login', args.slice(2))
        await serverLogin()
      } else if (subcmd === 'logout') {
        validateFlags('server logout', args.slice(2))
        await serverLogout()
      } else if (subcmd === 'remove') {
        validateFlags('server remove', args.slice(2))
        removeServer()
      } else if (subcmd === 'push') {
        validateFlags('server push', args.slice(2), { booleanFlags: ['all'] })
        await serverPush()
      } else {
        die('Usage: ig server [set <url> | login | logout | remove | push]')
      }
      break
    }

    case 'realm': {
      const subcmd = args[1]
      if (!subcmd) {
        validateFlags('realm', args.slice(1))
        await showRealm()
      } else if (subcmd === 'set') {
        validateFlags('realm set', args.slice(3))
        await setRealm()
      } else {
        die('Usage: ig realm [set <realm|identity|dataverse001>]')
      }
      break
    }

    case 'git': {
      const subcmd = args[1]
      if (subcmd === 'init') {
        validateFlags('git init', args.slice(2), { valueFlags: ['identity', 'realm', 'name'] })
        const identityName = flag('identity')
        const rawRealm = flag('realm')
        const realm = await resolveRealmAlias(rawRealm, findConfigDir(), identityName)
        const positional = args[2] && !args[2].startsWith('-') ? args[2] : null
        const name = flag('name') || positional || 'repo'

        const ctx = await makeClient({ identityName, realm })
        if (!ctx.client.pubkey) die('No identity configured — run \'ig identity generate\' first.')

        const { initRepo } = await import('../src/git/repo.js')
        const id = crypto.randomUUID()
        const ref = await initRepo({
          client: ctx.client,
          id,
          name,
          format: 'sha1',
          in: realm ? [realm] : undefined,
          defaultBranch: 'refs/heads/main',
        })
        console.log(ref)
        console.error(
          `Created GIT_REPOSITORY "${name}". Clone or push with:\n` +
          `  git clone ig::${ref}/${name}\n` +
          `  git remote add origin ig::${ref} && git push -u origin main`
        )
      } else if (subcmd === 'clone') {
        validateFlags('git clone', args.slice(2), { valueFlags: ['identity'] })
        const rawRef = args[2]
        if (!rawRef) die('Usage: ig git clone <ref> [dir]')
        const cleanRef = rawRef.replace(/^ig::/, '').split('/')[0]
        const identityName = flag('identity')
        const hasIdentity = !!resolveIdentityConfig(findConfigDir())
        const ctx = await makeClient({ identityName, authenticate: hasIdentity })
        const env = await ctx.client.get(cleanRef).catch(() => null)
        const name = env?.item?.content?.name || cleanRef
        const positional = args[3] && !args[3].startsWith('-') ? args[3] : null
        const { spawnSync } = await import('node:child_process')
        const cloneArgs = ['clone', `ig::${cleanRef}/${name}`]
        if (positional) cloneArgs.push(positional)
        const r = spawnSync('git', cloneArgs, { stdio: 'inherit' })
        process.exit(r.status == null ? 1 : r.status)
      } else if (subcmd === 'fork') {
        validateFlags('git fork', args.slice(2), { valueFlags: ['identity', 'realm', 'name'] })
        const [rawRef] = positionals(args.slice(2), ['identity', 'realm', 'name'])
        if (!rawRef) die('Usage: ig git fork <upstream-ref> [--name N] [--realm R]')
        const upstreamRef = rawRef.replace(/^ig::/, '').split('/')[0]
        const identityName = flag('identity')
        const realm = await resolveRealmAlias(flag('realm'), findConfigDir(), identityName)
        // Reads may hit a private/shared upstream, so authenticate if we can.
        const hasIdentity = !!resolveIdentityConfig(findConfigDir())
        const ctx = await makeClient({ identityName, realm, authenticate: hasIdentity })
        if (!ctx.client.pubkey) die('No identity configured — run \'ig identity generate\' first.')

        const { forkRepo } = await import('../src/git/repo.js')
        const { ref, tip, defaultBranch } = await forkRepo({
          client: ctx.client,
          upstreamRef,
          name: flag('name'),
          in: realm ? [realm] : undefined,
        })
        console.log(ref)
        console.error(
          `Forked ${upstreamRef}\n` +
          `  ${defaultBranch} → ${tip || '(empty)'}\n` +
          `Clone your fork, commit, and push:\n` +
          `  git clone ig::${ref}\n` +
          `  git push origin <branch>\n` +
          `The upstream owner merges with: ig git merge ${ref} <branch>`
        )
      } else if (subcmd === 'merge') {
        await gitMerge()
      } else {
        die('Usage: ig git [init [name] [--realm R] | clone <ref> [dir] | fork <upstream> | merge <fork> [branch]]')
      }
      break
    }

    case 'freenet': {
      // Own flag set, config keys and output contract — see cli/freenet.js.
      const { runFreenet } = await import('./freenet.js')
      await runFreenet(args.slice(1))
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
