/**
 * `ig freenet` — publish and read dataverse objects on Freenet.
 *
 * Kept out of cli/ig.js (which only dispatches into it) because this family
 * carries its own flag set, its own config keys and its own output contract.
 *
 * Output discipline, so the commands compose:
 *   stdout  the payload only — envelope JSON, slot map, derived ids
 *   stderr  progress, diagnostics, per-target reports
 * Exit codes: 0 on success; 1 on failure, including a publish where any poke
 * failed and a verify where any slot is unverified.
 */

import { readFileSync } from 'node:fs'
import {
  findConfigDir, readConfig, writeConfig, resolveIdentityConfig, openRuntime,
} from './runtime.js'
import { resolveFreenetConfig, FREENET_CONFIG_KEYS } from '../src/freenet/config.js'
import { loadContracts } from '../src/freenet/contracts.js'
import { createAddressing, parseRef } from '../src/freenet/addressing.js'
import { createFdevNode } from '../src/freenet/fdev.js'
import { publishObject } from '../src/freenet/publish.js'
import { verifyIndex, formatSlot } from '../src/freenet/verify.js'

const USAGE = `Usage: ig freenet <command> [options]

Publish and read dataverse objects on Freenet, including the inbound-relations
index. Every object is addressed from its ref alone:

  head      the current envelope         mutable, last-writer-wins on revision
  snapshot  one immutable revision       one contract per (ref, revision)
  index     who points at this object    keyed on the TARGET's params

Commands:
  ig freenet publish <ref>          Publish an object and poke its targets' indexes
  ig freenet get <ref> [--rev N]    Fetch the head, or one immutable revision
  ig freenet inbound <ref>          Print the inbound-relations slot map (JSON)
  ig freenet verify <ref>           Verify each index slot against its snapshot
  ig freenet derive <ref> [--rev N] Print derived contract ids; contacts nothing
  ig freenet config [<key> <value>] Show or set Freenet configuration

Publish performs the ordered flow: snapshot PUT, a GET-back gate, the head
PUT, then one poke per distinct target in item.relations. It aborts before
any poke if the snapshot is not confirmed, and exits non-zero if any poke
failed. Everything is idempotent — re-run to converge.

Options:
  --rev N            Revision (get, derive). Absent means the head.
  --port N           Node ws-api port (default 7509)
  --fdev PATH        fdev binary (default: fdev on PATH)
  --contracts-dir D  Directory holding the pinned contract WASMs
  --timeout S        Read timeout in seconds (default 60)
  --put-timeout S    Write timeout in seconds (default 330)
  --identity N       Authenticate as identity N when resolving a private object
  --json             Machine-readable output for publish/verify

Configuration keys (ig freenet config <key> <value>):
  ${FREENET_CONFIG_KEYS.port}          Node ws-api port
  ${FREENET_CONFIG_KEYS.fdev}          Path to the fdev binary
  ${FREENET_CONFIG_KEYS.contractsDir}  Directory of pinned contract WASMs

The contracts directory must hold dataverse_object.wasm,
dataverse_object_rev.wasm and dataverse_inbound_index.wasm. Those exact bytes
define the keyspace — a rebuilt contract addresses a different, empty universe,
so they are pinned artifacts, never rebuilt on the fly.`

const BOOLEAN_FLAGS = ['json']
const VALUE_FLAGS = ['rev', 'port', 'fdev', 'contracts-dir', 'timeout', 'put-timeout', 'identity']

/** Parse argv into {positional, flags}; throws on anything unrecognised. */
function parseArgs(argv, command) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--help' || token === '-h') {
      flags.help = true
      continue
    }
    if (!token.startsWith('-')) {
      positional.push(token)
      continue
    }
    const name = token.replace(/^--/, '')
    if (BOOLEAN_FLAGS.includes(name)) {
      flags[name] = true
      continue
    }
    if (VALUE_FLAGS.includes(name)) {
      const value = argv[++i]
      if (value === undefined || value.startsWith('-')) {
        throw new Error(`Option ${token} requires a value.\nRun 'ig freenet ${command} --help' for usage.`)
      }
      flags[name] = value
      continue
    }
    throw new Error(`Unknown option for 'freenet ${command}': ${token}\nRun 'ig freenet --help' for usage.`)
  }
  return { positional, flags }
}

/** A non-negative integer flag, or undefined. Rejects junk loudly. */
function intFlag(flags, name) {
  if (flags[name] === undefined) return undefined
  const n = Number(flags[name])
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new Error(`--${name} must be a non-negative integer, got: ${flags[name]}`)
  }
  return n
}

/** Wire up config → contracts → addressing → node for one invocation. */
function openBackend(flags) {
  const configDir = findConfigDir()
  const config = resolveFreenetConfig(
    (key) => readConfig(configDir, key, null),
    {
      port: flags.port === undefined ? undefined : intFlag(flags, 'port'),
      fdev: flags.fdev,
      contractsDir: flags['contracts-dir'],
      timeout: flags.timeout === undefined ? undefined : intFlag(flags, 'timeout'),
      putTimeout: flags['put-timeout'] === undefined ? undefined : intFlag(flags, 'put-timeout'),
    },
  )
  const contracts = loadContracts(config.contractsDir)
  return {
    config,
    contracts,
    addressing: createAddressing(contracts.codeHashes),
    node: createFdevNode({
      fdevPath: config.fdevPath,
      port: config.port,
      timeoutMs: config.timeoutMs,
      putTimeoutMs: config.putTimeoutMs,
    }),
  }
}

/**
 * Resolve a signed envelope through the normal ig plumbing: local store first,
 * hub if one is configured. A path to a JSON file also works, so an envelope
 * that is not in any store can still be published.
 */
async function resolveEnvelope(ref, flags) {
  if (ref.endsWith('.json')) {
    try {
      return JSON.parse(readFileSync(ref, 'utf-8'))
    } catch (err) {
      throw new Error(`Could not read envelope file ${ref}: ${err.message}`)
    }
  }
  parseRef(ref)
  const identityName = flags.identity
  // Private and shared-realm objects need auth; only try it if we have a key.
  const hasIdentity = !!identityName || !!resolveIdentityConfig(findConfigDir())
  const ctx = await openRuntime({ identityName, authenticate: hasIdentity })
  const envelope = await ctx.client.get(ref).catch(() => null)
  if (!envelope) {
    throw new Error(
      `Not found in the local store or on the hub: ${ref}\n` +
      '  Fetch or create it first (ig get / ig create), or pass a path to a signed envelope JSON file.',
    )
  }
  return envelope
}

const log = (msg) => console.error(msg)

// ─── commands ────────────────────────────────────────────────────

async function cmdDerive(positional, flags) {
  const [ref] = positional
  if (!ref) throw new Error('Usage: ig freenet derive <ref> [--rev N]')
  const { addressing } = openBackend(flags)
  console.log(JSON.stringify(addressing.all(ref, intFlag(flags, 'rev')), null, 2))
}

async function cmdGet(positional, flags) {
  const [ref] = positional
  if (!ref) throw new Error('Usage: ig freenet get <ref> [--rev N]')
  const { addressing, node } = openBackend(flags)
  const rev = intFlag(flags, 'rev')

  const id = rev === undefined ? addressing.headId(ref) : addressing.snapshotId(ref, rev)
  const what = rev === undefined ? `head of ${ref}` : `${ref} at revision ${rev}`
  log(`→ GET ${id}  (${what})`)

  const res = await node.get(id)
  if (!res.found) {
    // No fallback from a missing revision to the head, ever: the absence of a
    // revision is meaningful, and quietly answering with a different revision
    // would be worse than answering nothing.
    throw new Error(`Not found on the node: ${what}\n  contract ${id}\n  ${res.detail}`)
  }
  console.log(JSON.stringify(res.state, null, 2))
}

async function cmdInbound(positional, flags) {
  const [ref] = positional
  if (!ref) throw new Error('Usage: ig freenet inbound <ref>')
  const { addressing, node } = openBackend(flags)
  const id = addressing.indexId(ref)
  log(`→ GET ${id}  (inbound index of ${ref})`)

  const res = await node.get(id)
  if (!res.found) {
    throw new Error(
      `No inbound index on the node for ${ref}\n  contract ${id}\n  ${res.detail}\n` +
      '  No publish flow has poked this target yet — that is different from an index with no slots.',
    )
  }
  console.log(JSON.stringify(res.state?.slots ?? {}, null, 2))
}

async function cmdVerify(positional, flags) {
  const [ref] = positional
  if (!ref) throw new Error('Usage: ig freenet verify <ref>')
  const { addressing, node } = openBackend(flags)

  // Each slot is printed exactly once, as it resolves. In human mode the
  // slot lines ARE the payload, so they stream to stdout; under --json the
  // payload is the report, so the same lines stream to stderr as progress.
  const onSlot = flags.json
    ? (slot) => log(formatSlot(slot))
    : (slot) => console.log(formatSlot(slot))

  const report = await verifyIndex({ ref, node, addressing, log, onSlot })
  if (flags.json) console.log(JSON.stringify(report, null, 2))

  log(`── ${report.slots.length} slot(s), ${report.unverified} unverified`)
  if (!report.ok) {
    throw new Error('Some slots could not be verified against their snapshots.')
  }
}

async function cmdPublish(positional, flags) {
  const [ref] = positional
  if (!ref) throw new Error('Usage: ig freenet publish <ref>')
  const envelope = await resolveEnvelope(ref, flags)
  const { addressing, contracts, node, config } = openBackend(flags)

  log(`══ publish on 127.0.0.1:${config.port}`)
  const report = await publishObject({ envelope, node, addressing, contracts, log })

  const ok = report.pokes.length - report.failed
  if (flags.json) console.log(JSON.stringify(report, null, 2))
  log(`══ per-target report (${ok}/${report.pokes.length} ok)`)
  for (const poke of report.pokes) {
    log(poke.ok
      ? `   ✓ ${poke.target}${poke.created ? '  (index created)' : ''}`
      : `   ✗ ${poke.target}  ${poke.error.split('\n').join(' ')}`)
  }
  if (report.ok) return

  // Exit non-zero for EITHER failure mode. A green poke report over a head
  // that never landed would tell the user their object is live when it isn't.
  const reasons = []
  if (!report.headState.confirmed) reasons.push(`the head was not confirmed — ${report.headState.detail}`)
  if (report.failed > 0) reasons.push(`${report.failed} of ${report.pokes.length} poke(s) failed`)
  throw new Error(
    `${reasons.join('\n  ')}\n` +
    `  Re-run 'ig freenet publish ${ref}' to retry — the flow is idempotent: the snapshot\n` +
    '  re-PUT is a no-op, the head merge is LWW, and pokes are LWW.',
  )
}

function cmdConfig(positional) {
  const configDir = findConfigDir()
  const keys = Object.values(FREENET_CONFIG_KEYS)

  if (positional.length === 0) {
    for (const key of keys) {
      console.log(`${key.padEnd(24)} ${readConfig(configDir, key, '(unset)')}`)
    }
    return
  }
  const [key, value] = positional
  if (!keys.includes(key)) {
    throw new Error(`Unknown Freenet config key: ${key}\n  Known keys: ${keys.join(', ')}`)
  }
  if (value === undefined) {
    console.log(readConfig(configDir, key, '(unset)'))
    return
  }
  writeConfig(configDir, key, value)
  console.error(`Set ${key} = ${value}`)
}

const COMMANDS = {
  publish: cmdPublish,
  get: cmdGet,
  inbound: cmdInbound,
  verify: cmdVerify,
  derive: cmdDerive,
  config: async (positional) => cmdConfig(positional),
}

/**
 * @param {string[]} argv - args after `freenet`
 */
export async function runFreenet(argv) {
  const sub = argv[0]
  if (!sub || sub === '--help' || sub === '-h') {
    console.log(USAGE)
    return
  }
  if (!COMMANDS[sub]) {
    throw new Error(`Unknown 'ig freenet' command: ${sub}\nRun 'ig freenet --help' for usage.`)
  }

  const { positional, flags } = parseArgs(argv.slice(1), sub)
  if (flags.help) {
    console.log(USAGE)
    return
  }
  await COMMANDS[sub](positional, flags)
}
