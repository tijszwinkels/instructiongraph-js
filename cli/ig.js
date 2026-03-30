#!/usr/bin/env node

/**
 * ig — CLI for InstructionGraph.
 *
 * Usage:
 *   ig get <ref>              Fetch and print object
 *   ig search [--type T] [--by PK] [--limit N]
 *   ig inbound <ref> [--relation R] [--type T]
 *   ig verify <file.json>     Verify signature
 *   ig sign <spec.json>       Sign a spec and print envelope
 *   ig create <spec.json>     Sign and publish
 *   ig auth                   Authenticate with hub
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
  console.log(`ig — InstructionGraph CLI

InstructionGraph is a novel, self-describing graph data format designed for
exchanging data, concepts, and applications between LLMs. Each node carries
instructions plus relations, so agents and humans can follow the graph to
understand, render, and extend it.

Learn more:
  https://dataverse001.net/AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.b3f5a7c9-2d4e-4f60-9b8a-0c1d2e3f4a5b

Usage:
  ig <command> [options]

Commands:
  ig get <ref>                     Fetch object
  ig search [--type T] [--by PK]   Search objects
  ig inbound <ref> [--relation R]  Inbound relations
  ig verify <file.json>            Verify signature
  ig sign <spec.json>              Sign spec, print envelope
  ig create <spec.json>            Sign and publish
  ig auth                          Hub authentication
  ig identity                      Show current identity
  ig identity generate [--name N]  Generate a new identity
                       [--project]  Use ./.instructionGraph instead of ~/
                       [--activate] Set as active identity
  ig identity activate <name>      Activate an existing identity
  ig identity list                 List available identities
  ig server                        Show current server
  ig server set <url>              Connect to a hub server
  ig server remove                 Disconnect (go offline)
  ig server push                   Push all local objects to server
  ig realm                              Show current default realm
  ig realm set identity                 Go private (identity realm)
  ig realm set dataverse001             Go public
  ig realm set <realm>                  Set a specific realm

Run 'ig <command> --help' for command-specific help.`)
  process.exit(0)
}

function commandUsage(command) {
  const docs = {
    get: `Usage: ig get <ref>\n\nFetch an object by ref and print its JSON envelope.`,
    search: `Usage: ig search [--type T] [--by PK] [--limit N]\n\nSearch objects on the configured hub/store.`,
    inbound: `Usage: ig inbound <ref> [--relation R] [--type T] [--limit N]\n\nList objects that point to the target ref.`,
    verify: `Usage: ig verify <file.json>\n\nVerify an instructionGraph001 envelope on disk.`,
    sign: `Usage: ig sign <spec.json>\n\nBuild and sign a spec, then print the canonical envelope JSON.`,
    create: `Usage: ig create <spec.json>\n\nBuild, sign, and publish a spec to the configured store.`,
    auth: `Usage: ig auth\n\nAuthenticate with the configured hub.`,
    identity: `Usage: ig identity [generate|activate|list] [options]\n\nShow or manage the active identity.\n\nSubcommands:\n  ig identity generate [--name N] [--project] [--activate]\n  ig identity activate <name>\n  ig identity list\n\nEnvironment:\n  INSTRUCTIONGRAPH_DIR  Override config directory location`,
    server: `Usage: ig server [set <url> | remove | push]\n\nShow, configure, or remove the hub server connection.\n\nSubcommands:\n  ig server              Show current server status\n  ig server set <url>    Connect to a hub server for sync\n  ig server remove       Disconnect and go offline\n  ig server push         Push all local objects to the server\n\nWithout a server, all data stays on local filesystem only.\nWith a server, objects sync between local storage and the hub.`,
    realm: `Usage: ig realm [set <realm|identity|dataverse001>]\n\nShow or set the default realm used for new objects.\n\n  ig realm set identity       Use current identity\'s realm (private)\n  ig realm set dataverse001   Use the public dataverse realm\n  ig realm set <pubkey>       Use any specific realm`
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

  // 3. Default: ~/.instructionGraph (always — never null)
  return homeConfigDir()
}

function readConfig(configDir, name, defaultVal) {
  const localPath = join(configDir, 'config', name)
  if (existsSync(localPath)) return readFileSync(localPath, 'utf-8').trim()

  // Fall back to home config if configDir is project-local
  const home = homeConfigDir()
  if (configDir !== home) {
    const homePath = join(home, 'config', name)
    if (existsSync(homePath)) return readFileSync(homePath, 'utf-8').trim()
  }
  return defaultVal
}

function resolveIdentityConfig(configDir) {
  const identityName = readConfig(configDir, 'active-identity', 'default')

  // Check configDir first, then home (if different)
  const candidates = [join(configDir, 'identities', identityName, 'private.pem')]
  const home = homeConfigDir()
  if (configDir !== home) {
    candidates.push(join(home, 'identities', identityName, 'private.pem'))
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
  const home = homeConfigDir()
  if (configDir !== home) {
    candidates.push(join(home, 'identities', identityName, 'private.pem'))
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
  const home = homeConfigDir()
  if (configDir !== home) dirs.push(join(home, 'identities'))

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

async function makeClient() {
  const configDir = findConfigDir()
  const hubUrl = readConfig(configDir, 'hub-url', null)  // null = no server configured
  const defaultRealm = readConfig(configDir, 'default-realm', null)  // null → identity realm (private by default)
  const dataDir = join(configDir, 'data')
  const hasLocal = existsSync(dataDir)

  let store
  let isOnline = false

  if (hubUrl && hasLocal) {
    // Both: sync store (local primary, hub sync)
    const local = createFsStore({ dataDir })
    const hub = createHubStore({ url: hubUrl })
    store = createSyncStore({ local, remote: hub })
    isOnline = true
  } else if (hubUrl) {
    // Hub only (no local data dir yet)
    store = createHubStore({ url: hubUrl })
    isOnline = true
  } else if (hasLocal) {
    // Local only (offline mode)
    store = createFsStore({ dataDir })
  } else {
    // Nothing configured
    die(
      'No InstructionGraph configured.\n' +
      'Run \'ig identity generate\' to get started.'
    )
  }

  const identity = resolveIdentityConfig(configDir)

  const client = createClient({ store, identity, defaultRealm })
  if (identity) await client.ready
  return { client, configDir, isOnline, hubUrl }
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
    console.log('You are currently offline — objects stay on local filesystem only.')
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
    } else {
      console.log(`Current realm: ${configuredRealm}`)
    }
  } else {
    // No explicit realm — check if we have an identity (identity realm default)
    const identityConfig = resolveIdentityConfig(configDir)
    if (identityConfig) {
      const { importPEM } = await import('../src/identity.js')
      const pem = readFileSync(identityConfig.path, 'utf-8')
      const kp = await importPEM(pem)
      console.log(`Current realm: ${kp.pubkey} (identity realm — private)`)
      console.log('New objects will only be visible to you.')
    } else {
      console.log('Current realm: <no identity configured>')
    }
  }

  console.log('')
  console.log('The realm controls who can see your objects:')
  console.log('  dataverse001     Public — visible to everyone')
  console.log('  <your pubkey>    Private — only visible to you (identity realm)')
  console.log('')
  console.log('When connected to a server, all objects are uploaded, but private')
  console.log('objects are only accessible to you, after you authenticate (ig auth).')
  console.log('')
  console.log('To switch:')
  console.log('  ig realm set dataverse001        Go public')
  console.log('  ig realm set identity            Go private (use current identity realm)')
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
  } else {
    console.log(`Set default realm: ${realm} (identity realm — private)`)
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
    console.log('Both public and private objects are uploaded to the server.')
    console.log('Public objects (realm: dataverse001) are visible to everyone.')
    console.log('Private objects (identity realm) are stored on the server,')
    console.log('but only accessible to you, after you authenticate with \'ig auth\'.')
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
    console.log('  \u2022 Private objects (identity realm) are uploaded too, but only you can')
    console.log('    access them, after you authenticate with \'ig auth\'')
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
  console.log('Private objects (identity realm) will only be accessible to you, after you authenticate with \'ig auth\'.')
  console.log('')
  console.log('If you have existing local objects, push them to the server:')
  console.log('  ig server push')
}

async function serverPush() {
  const configDir = findConfigDir()
  const hubUrl = readConfig(configDir, 'hub-url', null)
  if (!hubUrl) die('No server configured. Run \'ig server set <url>\' first.')

  const dataDir = join(configDir, 'data')
  if (!existsSync(dataDir)) die('No local data directory found.')

  const local = createFsStore({ dataDir })
  const hub = createHubStore({ url: hubUrl })
  const sync = createSyncStore({ local, remote: hub })

  // Authenticate if we have an identity (needed for private objects)
  const identityConfig = resolveIdentityConfig(configDir)
  if (identityConfig) {
    try {
      const { importPEM, createSigner } = await import('../src/identity.js')
      const pem = readFileSync(identityConfig.path, 'utf-8')
      const kp = await importPEM(pem)
      const signer = createSigner(kp)
      await hub.authenticate(signer)
    } catch (e) {
      console.warn(`Warning: could not authenticate (${e.message}). Private objects may fail to push.`)
    }
  }

  console.log(`Pushing local objects to ${hubUrl}...`)

  const result = await sync.pushAll({
    onProgress({ ref, index, total, status, error }) {
      const n = `[${index + 1}/${total}]`
      if (status === 'ok') {
        process.stderr.write(`${n} \x1b[32m✓\x1b[0m ${ref}\n`)
      } else {
        process.stderr.write(`${n} \x1b[31m✗\x1b[0m ${ref}: ${error}\n`)
      }
    }
  })

  console.log('')
  console.log(`Done. ${result.pushed} pushed, ${result.errors} errors, ${result.total} total.`)
}

function removeServer() {
  const configDir = findConfigDir()
  const configPath = join(configDir, 'config', 'hub-url')

  if (!existsSync(configPath)) {
    console.log('No server configured (already offline).')
    return
  }

  unlinkSync(configPath)
  console.log('Server removed. Now in offline mode.')
  console.log('Your local objects are still on disk \u2014 nothing was deleted.')
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
const QUIET_COMMANDS = new Set(['identity', 'server', 'verify'])

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h') usage()
  if (hasHelp()) commandUsage(cmd)

  switch (cmd) {
    case 'get': {
      const ref = args[1]
      if (!ref) die('Usage: ig get <ref>')
      const ctx = await makeClient()
      printStatus(ctx)
      const obj = await ctx.client.get(ref)
      if (!obj) die(`Not found: ${ref}`)
      console.log(JSON.stringify(obj, null, 2))
      break
    }

    case 'search': {
      const ctx = await makeClient()
      printStatus(ctx)
      const result = await ctx.client.search({
        type: flag('type'),
        by: flag('by'),
        limit: flag('limit') ? parseInt(flag('limit')) : 20
      })
      for (const item of result.items) {
        const i = item.item
        console.log(`${i.ref}  ${i.type || '?'}  ${i.name || i.content?.title || '(no name)'}`)
      }
      if (result.cursor) console.log(`\n... more results (cursor: ${result.cursor})`)
      break
    }

    case 'inbound': {
      const ref = args[1]
      if (!ref) die('Usage: ig inbound <ref>')
      const ctx = await makeClient()
      printStatus(ctx)
      const result = await ctx.client.inbound(ref, {
        relation: flag('relation'),
        type: flag('type'),
        limit: flag('limit') ? parseInt(flag('limit')) : 20
      })
      for (const item of result.items) {
        const i = item.item
        console.log(`${i.ref}  ${i.type || '?'}  ${i.name || i.content?.title || ''}`)
      }
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
      const ctx = await makeClient()
      printStatus(ctx)
      const spec = JSON.parse(readFileSync(resolve(file), 'utf-8'))
      const ref = await ctx.client.create(spec)
      console.log(ref)
      break
    }

    case 'auth': {
      const ctx = await makeClient()
      if (!ctx.isOnline) die('No server configured. Run \'ig server set <url>\' first.')
      printStatus(ctx)
      const result = await ctx.client.authenticate()
      if (result.ok) {
        console.log(`Authenticated as ${result.pubkey}`)
        console.log(`Token: ${result.token}`)
      } else {
        die('Authentication failed')
      }
      break
    }

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
      } else if (subcmd === 'remove') {
        removeServer()
      } else if (subcmd === 'push') {
        await serverPush()
      } else {
        die('Usage: ig server [set <url> | remove | push]')
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
