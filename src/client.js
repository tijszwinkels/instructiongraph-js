import { canonicalJSON } from './canonical.js'
import { generateKeypair, signBytes } from './crypto.js'
import { createSigner } from './identity.js'
import { buildItem, isoNow, tombstone } from './object.js'
import { createHubStore } from './store/hub.js'

const DEFAULT_HUB_URL = 'https://dataverse001.net'
const DEFAULT_REALM = 'dataverse001'
const WELL_KNOWN_IDENTITY_ID = '00000000-0000-0000-0000-000000000001'
const NO_IDENTITY_ERROR = 'No identity configured — createClient needs an identity for write operations'
const textEncoder = new TextEncoder()

function clone(value) {
  return typeof structuredClone === 'function'
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value))
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function deepMerge(target, patch) {
  if (!isPlainObject(target) || !isPlainObject(patch)) {
    return clone(patch)
  }

  const merged = clone(target)
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(merged[key])) {
      merged[key] = deepMerge(merged[key], value)
    } else {
      merged[key] = clone(value)
    }
  }
  return merged
}

function autoIdentityName(pubkey) {
  return `Agent-${pubkey.slice(-4)}`
}

function assertIdentityName(name) {
  if (!name || typeof name !== 'string') throw new Error('Identity name must be a non-empty string')
  if (name.includes('/') || name.includes('\\')) {
    throw new Error('Identity name cannot contain path separators')
  }
}

function signerLike(value) {
  return Boolean(value && typeof value.pubkey === 'string' && typeof value.sign === 'function')
}

function inferType(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  return typeof value
}

function validateSchema(value, schema, path = 'content') {
  if (!schema || typeof schema !== 'object') return []

  const errors = []
  if (schema.type) {
    const expected = Array.isArray(schema.type) ? schema.type : [schema.type]
    const actual = inferType(value)
    const matches = expected.some((candidate) => {
      if (candidate === 'number') return typeof value === 'number'
      if (candidate === 'integer') return Number.isInteger(value)
      if (candidate === 'object') return isPlainObject(value)
      if (candidate === 'array') return Array.isArray(value)
      if (candidate === 'null') return value === null
      return typeof value === candidate
    })

    if (!matches) {
      errors.push(`${path} must be ${expected.join(' or ')}`)
      return errors
    }
  }

  if (schema.enum && !schema.enum.some((candidate) => Object.is(candidate, value))) {
    errors.push(`${path} must be one of ${schema.enum.map((candidate) => JSON.stringify(candidate)).join(', ')}`)
  }

  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key} is required`)
    }
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (key in value) {
        errors.push(...validateSchema(value[key], propertySchema, `${path}.${key}`))
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((entry, index) => {
      errors.push(...validateSchema(entry, schema.items, `${path}[${index}]`))
    })
  }

  return errors
}

async function loadNodeModules() {
  try {
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const os = await import('node:os')
    return { fs, path, os }
  } catch {
    return null
  }
}

async function fileExists(fs, filePath) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function findNearestInstructionGraphBase(fs, path, startDir) {
  let current = startDir
  while (true) {
    const candidate = path.join(current, '.instructionGraph')
    try {
      const stat = await fs.stat(candidate)
      if (stat.isDirectory()) return candidate
    } catch {
      // keep walking upward
    }

    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

async function readOverlayFile(env, segments) {
  const { node, localBase, homeBase } = env
  if (!node) return null

  const localPath = localBase ? node.path.join(localBase, ...segments) : null
  if (localPath && await fileExists(node.fs, localPath)) return localPath

  const homePath = homeBase ? node.path.join(homeBase, ...segments) : null
  if (homePath && await fileExists(node.fs, homePath)) return homePath

  return null
}

async function readOverlayConfig(env, name, fallback) {
  const filePath = await readOverlayFile(env, ['config', name])
  if (!filePath) return fallback
  return (await env.node.fs.readFile(filePath, 'utf8')).trim() || fallback
}

async function resolveEnvironment(options) {
  const node = await loadNodeModules()
  if (!node) {
    return { node: null, localBase: options.configDir ?? null, homeBase: null }
  }

  const cwd = options.cwd ?? process.cwd()
  const localBase = options.configDir ?? await findNearestInstructionGraphBase(node.fs, node.path, cwd)
  const homeDir = options.homeDir ?? node.os.homedir()
  const homeBase = options.configDir ? null : node.path.join(homeDir, '.instructionGraph')
  return { node, localBase, homeBase }
}

async function resolveConfiguredIdentity(options, env) {
  if (options.identity === null) return null
  if (options.identity !== undefined) {
    return signerLike(options.identity) ? options.identity : createSigner(options.identity)
  }

  const identityName = await readOverlayConfig(env, 'active-identity', 'default')
  const identityPath = await readOverlayFile(env, ['identities', identityName, 'private.pem'])
  if (!identityPath) return null
  return createSigner({ type: 'pem-file', path: identityPath })
}

async function writeLocalConfig(state, name, value) {
  if (!state.node || !state.localBase) return null
  const configDir = state.node.path.join(state.localBase, 'config')
  await state.node.fs.mkdir(configDir, { recursive: true })
  const filePath = state.node.path.join(configDir, name)
  await state.node.fs.writeFile(filePath, value, 'utf8')
  return filePath
}

async function removeLocalConfig(state, name) {
  if (!state.node || !state.localBase) return
  try {
    await state.node.fs.rm(state.node.path.join(state.localBase, 'config', name))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
}

async function resolveState(options) {
  const env = await resolveEnvironment(options)
  const hubUrl = options.hubUrl ?? await readOverlayConfig(env, 'hub-url', DEFAULT_HUB_URL)
  const defaultRealm = options.defaultRealm ?? await readOverlayConfig(env, 'default-realm', DEFAULT_REALM)
  const hubToken = options.token ?? await readOverlayConfig(env, 'hub-token', null)
  const signer = await resolveConfiguredIdentity(options, env)

  return {
    ...env,
    hubUrl,
    defaultRealm,
    hubToken,
    signer,
    store: options.store ?? createHubStore({
      url: hubUrl,
      fetch: options.fetch,
      token: hubToken,
      headers: options.headers,
      credentials: options.credentials,
      userAgent: options.userAgent,
    }),
    logger: options.logger ?? null,
    typeCache: new Map(),
  }
}

async function validateTypeDef(item, state) {
  const typeRef = item.relations?.type_def?.[0]?.ref
  if (!typeRef || !state.store?.get) return

  let typeObject = state.typeCache.get(typeRef)
  if (typeObject === undefined) {
    typeObject = await state.store.get(typeRef)
    state.typeCache.set(typeRef, typeObject ?? null)
  }

  const schema = typeObject?.item?.content?.schema
  if (!schema) return

  const errors = validateSchema(item.content ?? {}, schema)
  if (errors.length > 0) {
    throw new Error(errors.join('; '))
  }
}

async function signEnvelope(signer, item) {
  return {
    is: 'instructionGraph001',
    signature: await signer.sign(textEncoder.encode(canonicalJSON(item))),
    item,
  }
}

async function publishOrThrow(store, signedObject) {
  const result = await store.put(signedObject)
  if (!result?.ok) {
    throw new Error(result?.error ?? `Failed to publish ${signedObject.item.ref}`)
  }
  return result
}

function normalizeBuildFields(fields, pubkey, defaultRealm) {
  return {
    ...fields,
    pubkey: fields.pubkey ?? pubkey,
    in: fields.in ?? [defaultRealm],
  }
}

async function exportPrivateKeyToPem(privateKey) {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('Web Crypto API is not available in this runtime')
  const pkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', privateKey))
  const base64 = btoa(String.fromCharCode(...pkcs8))
  const lines = base64.match(/.{1,64}/g) ?? []
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`
}

export function createClient(options = {}) {
  let statePromise

  async function getState() {
    if (!statePromise) statePromise = resolveState(options)
    return statePromise
  }

  async function requireSigner() {
    const state = await getState()
    if (!state.signer) throw new Error(NO_IDENTITY_ERROR)
    return { state, signer: state.signer }
  }

  async function buildAndValidate(fields, signerOverride = null) {
    const state = await getState()
    const signer = signerOverride ?? state.signer
    const pubkey = fields.pubkey ?? signer?.pubkey
    if (!pubkey) {
      throw new Error('No pubkey available — provide fields.pubkey or configure an identity')
    }

    const item = buildItem(normalizeBuildFields(fields, pubkey, state.defaultRealm))
    await validateTypeDef(item, state)
    return item
  }

  return {
    async get(ref) {
      return (await getState()).store.get(ref)
    },

    async search(query = {}) {
      return (await getState()).store.search(query)
    },

    async inbound(ref, query = {}) {
      return (await getState()).store.inbound(ref, query)
    },

    async build(fields) {
      return buildAndValidate(fields)
    },

    async sign(fields) {
      const { signer } = await requireSigner()
      const item = await buildAndValidate(fields, signer)
      return signEnvelope(signer, item)
    },

    async publish(signedObject) {
      const state = await getState()
      const result = await state.store.put(signedObject)
      return {
        ...result,
        ref: signedObject?.item?.ref,
      }
    },

    async create(fields) {
      const { state, signer } = await requireSigner()
      const item = await buildAndValidate(fields, signer)
      if (item.pubkey !== signer.pubkey) {
        throw new Error(`Item pubkey ${item.pubkey} does not match configured identity ${signer.pubkey}`)
      }
      const signedObject = await signEnvelope(signer, item)
      await publishOrThrow(state.store, signedObject)
      return item.ref
    },

    async update(ref, patch) {
      const { state, signer } = await requireSigner()
      const current = await state.store.get(ref)
      if (!current?.item) throw new Error(`Object not found: ${ref}`)
      if (current.item.pubkey !== signer.pubkey) {
        throw new Error(`Cannot update object owned by ${current.item.pubkey} with identity ${signer.pubkey}`)
      }

      const updatedItem = deepMerge(current.item, patch ?? {})
      updatedItem.id = current.item.id
      updatedItem.ref = current.item.ref
      updatedItem.pubkey = current.item.pubkey
      updatedItem.created_at = current.item.created_at
      updatedItem.updated_at = isoNow()
      updatedItem.revision = (current.item.revision ?? 0) + 1

      await validateTypeDef(updatedItem, state)
      const signedObject = await signEnvelope(signer, updatedItem)
      await publishOrThrow(state.store, signedObject)
      return ref
    },

    async delete(ref) {
      const { state, signer } = await requireSigner()
      const current = await state.store.get(ref)
      if (!current?.item) throw new Error(`Object not found: ${ref}`)
      if (current.item.pubkey !== signer.pubkey) {
        throw new Error(`Cannot delete object owned by ${current.item.pubkey} with identity ${signer.pubkey}`)
      }

      const deletedItem = tombstone(current.item)
      const signedObject = await signEnvelope(signer, deletedItem)
      await publishOrThrow(state.store, signedObject)
      return ref
    },

    async authenticate() {
      const { state, signer } = await requireSigner()
      if (typeof state.store.authenticate !== 'function') {
        throw new Error('Configured store does not support authentication')
      }

      const result = await state.store.authenticate(signer)
      if (result?.token) {
        state.hubToken = result.token
        await writeLocalConfig(state, 'hub-token', `${result.token}\n`)
      }
      return result
    },

    async logout() {
      const state = await getState()
      if (typeof state.store.logout !== 'function') {
        throw new Error('Configured store does not support logout')
      }

      const result = await state.store.logout()
      state.hubToken = null
      await removeLocalConfig(state, 'hub-token')
      return result
    },

    async createIdentity(identityOptions = {}) {
      const state = await getState()
      const keypair = await generateKeypair()
      const signer = {
        pubkey: keypair.pubkey,
        privateKey: keypair.privateKey,
        sign: (data) => signBytes(keypair.privateKey, data),
      }

      const displayName = identityOptions.name ?? autoIdentityName(keypair.pubkey)
      assertIdentityName(displayName)

      const item = buildItem({
        id: WELL_KNOWN_IDENTITY_ID,
        pubkey: signer.pubkey,
        in: identityOptions.in ?? [state.defaultRealm],
        type: 'IDENTITY',
        name: displayName,
        instruction: identityOptions.instruction,
        relations: identityOptions.relations ?? {},
        content: {
          name: displayName,
          ...(identityOptions.content ?? {}),
        },
      })

      const signedObject = await signEnvelope(signer, item)
      await publishOrThrow(state.store, signedObject)

      let pemPath = null
      if (state.node && state.localBase) {
        const identityDir = state.node.path.join(state.localBase, 'identities', displayName)
        await state.node.fs.mkdir(identityDir, { recursive: true })
        pemPath = state.node.path.join(identityDir, 'private.pem')
        await state.node.fs.writeFile(pemPath, await exportPrivateKeyToPem(keypair.privateKey), 'utf8')
      }

      state.signer = signer
      return {
        ref: item.ref,
        pubkey: signer.pubkey,
        signedObject,
        ...(pemPath ? { pemPath } : {}),
      }
    },
  }
}
