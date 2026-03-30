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

import { readFileSync, existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { canonicalJSON } from '../src/canonical.js'
import { verify } from '../src/crypto.js'
import { isEnvelope } from '../src/object.js'
import { createClient } from '../src/client.js'
import { createHubStore } from '../src/store/hub.js'
import { createFsStore } from '../src/store/fs.js'
import { createSyncStore } from '../src/store/sync.js'

const args = process.argv.slice(2)
const cmd = args[0]

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

Commands:
  ig get <ref>                     Fetch object
  ig search [--type T] [--by PK]   Search objects
  ig inbound <ref> [--relation R]  Inbound relations
  ig verify <file.json>            Verify signature
  ig sign <spec.json>              Sign spec, print envelope
  ig create <spec.json>            Sign and publish
  ig auth                          Hub authentication
  ig identity                      Show current identity`)
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
      return { type: 'pem-file', path: pemPath }
    }
  }
  return null
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

// ─── Commands ────────────────────────────────────────────────────

async function main() {
  if (!cmd || cmd === '--help' || cmd === '-h') usage()

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
      const { client } = await makeClient()
      await client.ready
      if (client.pubkey) {
        console.log(`Pubkey: ${client.pubkey}`)
      } else {
        console.log('No identity configured')
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
