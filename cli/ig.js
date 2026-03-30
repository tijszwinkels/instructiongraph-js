#!/usr/bin/env node

/**
 * ig — CLI for InstructionGraph hubs.
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
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
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
                       [--activate] Set as active identity
  ig identity activate <name>      Activate an existing identity
  ig identity list                 List available identities
  ig realm                         Show current default realm
  ig realm set <realm>             Set default realm

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
    identity: `Usage: ig identity [generate|activate|list] [options]\n\nShow or manage the active identity.\n\nSubcommands:\n  ig identity generate [--name N] [--activate]\n  ig identity activate <name>\n  ig identity list`,
    realm: `Usage: ig realm [set <realm>]\n\nShow or set the default realm used for new objects.`
  }

  if (!docs[command]) die(`Unknown command: ${command}\nRun 'ig --help' for usage.`)
  console.log(docs[command])
  process.exit(0)
}

// ─── Config resolution ───────────────────────────────────────────

function findConfigDir() {
  // Walk up from cwd looking for .instructionGraph/
  let dir = process.cwd()
  while (dir !== '/') {
    const igDir = join(dir, '.instructionGraph')
    if (existsSync(join(igDir, 'config')) || existsSync(join(igDir, 'data'))) return igDir
    dir = resolve(dir, '..')
  }
  // Fall back to ~/.instructionGraph
  const home = join(process.env.HOME || '~', '.instructionGraph')
  if (existsSync(home)) return home
  return null
}

function readConfig(configDir, name, defaultVal) {
  if (configDir) {
    const localPath = join(configDir, 'config', name)
    if (existsSync(localPath)) return readFileSync(localPath, 'utf-8').trim()
  }
  const homePath = join(process.env.HOME || '~', '.instructionGraph', 'config', name)
  if (existsSync(homePath)) return readFileSync(homePath, 'utf-8').trim()
  return defaultVal
}

function resolveIdentityConfig(configDir) {
  const identityName = readConfig(configDir, 'active-identity', 'default')

  // Check local first, then home
  const candidates = []
  if (configDir) candidates.push(join(configDir, 'identities', identityName, 'private.pem'))
  candidates.push(join(process.env.HOME || '~', '.instructionGraph', 'identities', identityName, 'private.pem'))

  for (const pemPath of candidates) {
    if (existsSync(pemPath)) {
      return { type: 'pem-file', path: pemPath, name: identityName }
    }
  }
  return null
}

function writeConfig(configDir, name, value) {
  const resolvedConfigDir = configDir || join(process.cwd(), '.instructionGraph')
  const configPath = join(resolvedConfigDir, 'config')
  mkdirSync(configPath, { recursive: true })
  writeFileSync(join(configPath, name), `${value}\n`)
}

function resolveIdentityPemPath(configDir, identityName) {
  const candidates = []
  if (configDir) candidates.push(join(configDir, 'identities', identityName, 'private.pem'))
  candidates.push(join(process.env.HOME || '~', '.instructionGraph', 'identities', identityName, 'private.pem'))
  return candidates.find(existsSync) || null
}

function listIdentityNames(configDir) {
  const dirs = []
  if (configDir) dirs.push(join(configDir, 'identities'))
  dirs.push(join(process.env.HOME || '~', '.instructionGraph', 'identities'))

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
  const hubUrl = readConfig(configDir, 'hub-url', 'https://dataverse001.net')
  const defaultRealm = readConfig(configDir, 'default-realm', null)  // null → pubkey realm (private by default)

  const hub = createHubStore({ url: hubUrl })
  let store = hub

  // If we have a local data dir, use sync store
  if (configDir && existsSync(join(configDir, 'data'))) {
    const local = createFsStore({ dataDir: join(configDir, 'data') })
    store = createSyncStore({ local, remote: hub })
  }

  const identity = resolveIdentityConfig(configDir)

  const client = createClient({ store, identity, defaultRealm })
  if (identity) await client.ready
  return { client, hub, configDir }
}

// ─── Identity generation ─────────────────────────────────────────

async function identityGenerate() {
  const configDir = findConfigDir() || join(process.cwd(), '.instructionGraph')
  const name = flag('name') || 'default'

  const identityDir = join(configDir, 'identities', name)
  const pemPath = join(identityDir, 'private.pem')

  if (existsSync(pemPath)) {
    die(`Identity "${name}" already exists at ${pemPath}`)
  }

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

  mkdirSync(identityDir, { recursive: true })
  writeFileSync(pemPath, pem, { mode: 0o600 })

  console.log(`Generated identity: ${name}`)
  console.log(`Pubkey: ${kp.pubkey}`)
  console.log(`PEM saved: ${pemPath}`)

  // Optionally set as active identity
  if (args.includes('--activate')) {
    writeConfig(configDir, 'active-identity', name)
    console.log('Set as active identity')
  }
}

function identityActivate() {
  const name = args[2]
  if (!name) die('Usage: ig identity activate <name>')

  const configDir = findConfigDir() || join(process.cwd(), '.instructionGraph')
  const pemPath = resolveIdentityPemPath(configDir, name)
  if (!pemPath) die(`Identity not found: ${name}`)

  writeConfig(configDir, 'active-identity', name)
  console.log(`Activated identity: ${name}`)
  console.log(`PEM: ${pemPath}`)
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
  const { client } = await makeClient()
  await client.ready
  const configuredRealm = readConfig(findConfigDir(), 'default-realm', null)

  if (configuredRealm) {
    console.log(`Current realm: ${configuredRealm}`)
    return
  }

  if (client.pubkey) {
    console.log(`Current realm: ${client.pubkey} (pubkey realm default)`)
  } else {
    console.log('Current realm: <no identity configured>')
  }
}

function setRealm() {
  const realm = args[2]
  if (!realm) die('Usage: ig realm set <realm>')
  const configDir = findConfigDir() || join(process.cwd(), '.instructionGraph')
  writeConfig(configDir, 'default-realm', realm)
  console.log(`Set default realm: ${realm}`)
}

// ─── Commands ────────────────────────────────────────────────────

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h') usage()
  if (hasHelp()) commandUsage(cmd)

  switch (cmd) {
    case 'get': {
      const ref = args[1]
      if (!ref) die('Usage: ig get <ref>')
      const { client } = await makeClient()
      const obj = await client.get(ref)
      if (!obj) die(`Not found: ${ref}`)
      console.log(JSON.stringify(obj, null, 2))
      break
    }

    case 'search': {
      const { client } = await makeClient()
      const result = await client.search({
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
      const { client } = await makeClient()
      const result = await client.inbound(ref, {
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
      const { client } = await makeClient()
      const spec = JSON.parse(readFileSync(resolve(file), 'utf-8'))
      const item = isEnvelope(spec) ? spec.item : client.build(spec)
      const envelope = await client.sign(item)
      console.log(canonicalJSON(envelope))
      break
    }

    case 'create': {
      const file = args[1]
      if (!file) die('Usage: ig create <spec.json>')
      const { client } = await makeClient()
      const spec = JSON.parse(readFileSync(resolve(file), 'utf-8'))
      const ref = await client.create(spec)
      console.log(ref)
      break
    }

    case 'auth': {
      const { client } = await makeClient()
      const result = await client.authenticate()
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
        identityActivate()
      } else if (subcmd === 'list') {
        identityList()
      } else {
        const configDir = findConfigDir()
        const identityConfig = resolveIdentityConfig(configDir)
        const { client } = await makeClient()
        await client.ready
        if (client.pubkey) {
          if (identityConfig?.name) console.log(`Identity: ${identityConfig.name}`)
          console.log(`Pubkey: ${client.pubkey}`)
        } else {
          console.log('No identity configured')
        }
      }
      break
    }

    case 'realm': {
      const subcmd = args[1]
      if (!subcmd) {
        await showRealm()
      } else if (subcmd === 'set') {
        setRealm()
      } else {
        die('Usage: ig realm [set <realm>]')
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
