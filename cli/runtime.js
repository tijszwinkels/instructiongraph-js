/**
 * Shared runtime resolution for the ig CLI and the git-remote-ig helper:
 * locate the .instructionGraph config dir, read config, resolve the active
 * identity, and build a client over the right store (fs / hub / sync) with
 * realm filtering and optional hub authentication.
 *
 * Extracted from cli/ig.js so both executables resolve config identically
 * (DRY). Functions throw on error; each executable's top-level handler turns a
 * thrown Error into a stderr message + exit 1.
 *
 * Node-only (uses node:fs / node:path).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createClient } from '../src/client.js'
import { createHubStore } from '../src/store/hub.js'
import { createFsStore } from '../src/store/fs.js'
import { createSyncStore } from '../src/store/sync.js'
import { isVisible, loadSharedRealms } from '../src/store/realm-filter.js'

// ─── Config resolution ───────────────────────────────────────────

export function homeConfigDir() {
  return join(process.env.HOME || '~', '.instructionGraph')
}

export function findConfigDir() {
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

export function readConfig(configDir, name, defaultVal) {
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

export function resolveIdentityConfig(configDir) {
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

export function writeConfig(configDir, name, value) {
  const configPath = join(configDir, 'config')
  mkdirSync(configPath, { recursive: true })
  writeFileSync(join(configPath, name), `${value}\n`)
}

/**
 * Resolve well-known realm aliases (e.g. 'identity') to their actual values.
 * @param {string|undefined} realm - Raw realm string from --realm flag
 * @param {string} configDir - Config directory for identity lookup
 * @param {string|null} [identityName] - Explicit identity name (from --identity flag)
 * @returns {Promise<string|undefined>} Resolved realm string, or undefined if input was undefined
 */
export async function resolveRealmAlias(realm, configDir, identityName) {
  if (realm === undefined) return undefined
  if (realm === 'identity') {
    const name = identityName || readConfig(configDir, 'active-identity', 'default')
    const pemPath = resolveIdentityPemPath(configDir, name)
    if (!pemPath) throw new Error(`No identity '${name}' found. Run 'ig identity generate' first.`)
    const { importPEM } = await import('../src/identity.js')
    const kp = await importPEM(readFileSync(pemPath, 'utf-8'))
    return kp.pubkey
  }
  return realm
}

export function resolveIdentityPemPath(configDir, identityName) {
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
export function listLocalIdentityNames(configDir) {
  const dir = join(configDir, 'identities')
  const names = []
  if (!existsSync(dir)) return names
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    if (existsSync(join(dir, entry.name, 'private.pem'))) names.push(entry.name)
  }
  return names.sort()
}

export function listIdentityNames(configDir) {
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
 * Build a client over the resolved store + identity.
 *
 * @param {object} [overrides]
 * @param {string} [overrides.identityName] - Use a specific identity instead of active
 * @param {string} [overrides.realm] - Override the default realm
 * @param {string} [overrides.token] - Override the auth token
 * @param {boolean} [overrides.authenticate] - Authenticate with hub on connect
 * @param {boolean} [overrides.skipRealmCheck] - Disable realm filtering (--raw)
 * @returns {Promise<{client, configDir, isOnline, hubUrl, hub, store}>}
 */
export async function openRuntime(overrides = {}) {
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

  // If realm is 'local', ensure data dir exists — local realm objects must never
  // go through hub-only mode, which would bypass the sync store's push guard.
  const effectiveRealm = overrides.realm || readConfig(configDir, 'default-realm', null)
  if ((effectiveRealm === 'local' || effectiveRealm === 'server-public') && !hasLocal) {
    mkdirSync(dataDir, { recursive: true })
  }
  const hasLocalResolved = hasLocal || effectiveRealm === 'local' || effectiveRealm === 'server-public'

  if (hubUrl && hasLocalResolved) {
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
  } else if (hasLocalResolved) {
    // Local only (offline mode)
    store = createFsStore({ dataDir, filter: realmFilter })
  } else {
    // Nothing configured
    throw new Error(
      'No InstructionGraph configured.\n' +
      'Run \'ig identity generate\' to get started.'
    )
  }

  // Resolve identity: override or active
  let identity
  if (overrides.identityName) {
    const pemPath = resolveIdentityPemPath(configDir, overrides.identityName)
    if (!pemPath) throw new Error(`Identity not found: ${overrides.identityName}`)
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
    if (!client.signer) throw new Error('Cannot authenticate — no identity configured.')
    const authResult = await client.authenticate()
    if (!authResult.ok) throw new Error(`Authentication failed for identity: ${overrides.identityName || 'active'}`)
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
