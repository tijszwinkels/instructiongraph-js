/**
 * End-to-end against a REAL Freenet node and the REAL pinned contracts.
 *
 * Skipped unless explicitly enabled, because it needs artifacts and a node
 * that a plain `npm test` has no business assuming.
 *
 *   # 1. the pinned contract WASMs (dataverse_object.wasm,
 *   #    dataverse_object_rev.wasm, dataverse_inbound_index.wasm)
 *   export IG_FREENET_E2E_CONTRACTS=/path/to/contracts
 *
 *   # 2. a LOCAL-MODE node of your own — never a shared/network node
 *   freenet local --ws-api-address 127.0.0.1 --ws-api-port 7511 \
 *     --config-dir ~/.cache/ig-freenet-e2e/config \
 *     --data-dir   ~/.cache/ig-freenet-e2e/data
 *   export IG_FREENET_E2E_PORT=7511
 *
 *   node --test test/freenet-e2e.test.js
 *
 * With only IG_FREENET_E2E_CONTRACTS set, the golden-id assertions still run
 * offline — those alone catch a WASM swap, which silently relocates the entire
 * keyspace. The live half additionally signs its OWN throwaway objects and
 * publishes them for real, so it needs no private envelopes from anyone's store.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { rm } from 'node:fs/promises'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { setupIgStore } from '../test-support/ig-store.js'
import { loadContracts } from '../src/freenet/contracts.js'
import { createAddressing } from '../src/freenet/addressing.js'

const execFile = promisify(execFileCb)
const CLI = join(import.meta.dirname, '..', 'cli', 'ig.js')

const CONTRACTS = process.env.IG_FREENET_E2E_CONTRACTS
const PORT = process.env.IG_FREENET_E2E_PORT

const noContracts = !CONTRACTS && 'set IG_FREENET_E2E_CONTRACTS to the pinned contracts dir'
const noNode = (!CONTRACTS || !PORT) && 'set IG_FREENET_E2E_CONTRACTS and IG_FREENET_E2E_PORT (local-mode node)'

/**
 * Live-verified golden ids from the inbound-index spike (2026-06-11). These
 * are what `fdev execute get-contract-id` derives and what was actually
 * published to a node — so they pin our derivation to the real keyspace.
 */
const GOLDEN = {
  identity: {
    ref: 'ApWJVWXvVKIIMnH6CP6u8HUyU2gLvyYGnwRlgrWAUwcP.00000000-0000-0000-0000-000000000001',
    revision: 3,
    head: 'DWzw99Gtxyhu1gDjNKJcVfSsfw9HmEjNLwUrHmxY4VWB',
    index: 'FQ6Qbh6Y9N2syWVciUNtJoeEL28wCq1UNzRDfUJGNKTp',
    snapshot: '7GHNZLEQToEYz7Z6Jy6e7JqsSKNB4jgxUru1CwjnucbY',
  },
  root: {
    ref: 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.00000000-0000-0000-0000-000000000000',
    revision: 41,
    snapshot: 'ExUAkBcvqWMicnkDwPCn6zf6wxAXU2Nc6Ee6Lbpyzpc8',
  },
}

/** BLAKE3 of the pinned WASMs, as recorded when they were frozen. */
const PINNED_CODE_HASHES = {
  object: '6631a15614c55e96d5297c459461bbb63ec47fd7a4fa6050e2cf104815ed3ff0',
  snapshot: 'f2e5cf0d8f7ddd588fd2edd782e224bb146593ec0910b8d1dd0635e161c92c44',
  index: '27d3ea150dd78b093b0afcc2b62b43147690a2da1b0e9f5e3ea71c8b4a6c6568',
}

const toHex = (bytes) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('')

describe('freenet e2e — pinned contracts', { skip: noContracts }, () => {
  it('the contracts directory holds the exact pinned WASMs', () => {
    const { codeHashes } = loadContracts(CONTRACTS)
    for (const [role, expected] of Object.entries(PINNED_CODE_HASHES)) {
      assert.equal(toHex(codeHashes[role]), expected, `${role} WASM is not the pinned build`)
    }
  })

  it('derives the live-verified golden contract ids', () => {
    const addressing = createAddressing(loadContracts(CONTRACTS).codeHashes)
    const { identity, root } = GOLDEN
    assert.equal(addressing.headId(identity.ref), identity.head)
    assert.equal(addressing.indexId(identity.ref), identity.index)
    assert.equal(addressing.snapshotId(identity.ref, identity.revision), identity.snapshot)
    assert.equal(addressing.snapshotId(root.ref, root.revision), root.snapshot)
  })
})

describe('freenet e2e — live node', { skip: noNode }, () => {
  let store, sourceRef, targetRef, sourceEnv

  /** Run the CLI against the live node; never throws. */
  async function ig(args) {
    try {
      const r = await execFile(process.execPath, [CLI, ...args], {
        env: { ...process.env, INSTRUCTIONGRAPH_DIR: store.dir },
      })
      return { ...r, code: 0 }
    } catch (err) {
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 }
    }
  }

  const fn = (...args) => ig(['freenet', ...args, '--contracts-dir', CONTRACTS, '--port', PORT])
  const lastLine = (s) => s.trim().split('\n').pop().trim()

  before(async () => {
    // The contracts only accept objects in the dataverse001 realm.
    store = await setupIgStore({ realm: 'dataverse001' })
    const spec = join(store.dir, 'spec.json')

    writeFileSync(spec, JSON.stringify({ type: 'NOTE', name: 'e2e target', instruction: 'target' }))
    targetRef = lastLine((await ig(['create', spec, '--no-push'])).stdout)

    writeFileSync(spec, JSON.stringify({
      type: 'NOTE',
      name: 'e2e source',
      instruction: 'source',
      relations: { root: [{ ref: targetRef }], mentions: [{ ref: targetRef }] },
    }))
    sourceRef = lastLine((await ig(['create', spec, '--no-push'])).stdout)
    sourceEnv = JSON.parse((await ig(['get', sourceRef])).stdout)
  })

  after(async () => {
    if (store?.dir) await rm(store.dir, { recursive: true, force: true })
  })

  it('publishes, pokes every target, and reports them all ok', async () => {
    const { code, stderr } = await fn('publish', sourceRef)
    assert.equal(code, 0, stderr)
    assert.match(stderr, /confirmed: the node holds our signature/)
    assert.doesNotMatch(stderr, /✗/)
  })

  it('the target index lists the source with only the relations that point at it', async () => {
    const { stdout, code } = await fn('inbound', targetRef)
    assert.equal(code, 0)
    const slots = JSON.parse(stdout)
    // The contract wrote this slot from the snapshot it fetched and re-invoked
    // with — we cannot author slot content, only point at a source.
    assert.deepEqual(slots[sourceRef], {
      revision: sourceEnv.item.revision ?? 0,
      relations: ['mentions', 'root'],
    })
    // `author` points at the identity object, not at us, so it must not leak in.
    assert.equal(Object.keys(slots).length, 1)
  })

  it('verifies every slot as current against its snapshot', async () => {
    const { stdout, code } = await fn('verify', targetRef)
    assert.equal(code, 0)
    assert.match(stdout, /verified-current/)
    assert.doesNotMatch(stdout, /unverified/)
  })

  it('re-publishing is an idempotent no-op — the index does not change', async () => {
    const before = (await fn('inbound', targetRef)).stdout
    const republish = await fn('publish', sourceRef)
    assert.equal(republish.code, 0)
    // DEV-2: every index is local now, so none is re-published.
    assert.doesNotMatch(republish.stderr, /index not on node/)
    assert.equal((await fn('inbound', targetRef)).stdout, before)
  })

  it('reads the head, and the same envelope at its explicit revision', async () => {
    const head = await fn('get', sourceRef)
    assert.equal(head.code, 0)
    assert.deepEqual(JSON.parse(head.stdout), sourceEnv)

    const snap = await fn('get', sourceRef, '--rev', String(sourceEnv.item.revision ?? 0))
    assert.equal(snap.code, 0)
    assert.deepEqual(JSON.parse(snap.stdout), sourceEnv)
  })

  it('a never-published revision is a clean not-found, never a head fallback', async () => {
    const { code, stdout, stderr } = await fn('get', sourceRef, '--rev', '9999', '--timeout', '15')
    assert.equal(code, 1)
    assert.equal(stdout.trim(), '', 'nothing on stdout — silence is the honest answer')
    assert.match(stderr, /not found|revision 9999/i)
  })

  it('US-2.4: dropping a relation tombstones the slot in the dropped target', async () => {
    // A second target, linked at this revision and dropped at the next.
    const spec = join(store.dir, 'drop.json')
    writeFileSync(spec, JSON.stringify({ type: 'NOTE', name: 'e2e drop target', instruction: 'dropped' }))
    const dropRef = lastLine((await ig(['create', spec, '--no-push'])).stdout)

    const id = sourceRef.split('.').slice(1).join('.')
    const linked = {
      id,
      type: 'NOTE',
      name: 'e2e source',
      instruction: 'source',
      relations: { root: [{ ref: targetRef }], mentions: [{ ref: targetRef }], drops: [{ ref: dropRef }] },
    }
    writeFileSync(spec, JSON.stringify(linked))
    assert.equal((await ig(['create', spec, '--update', '--no-push'])).code, 0)
    assert.equal((await fn('publish', sourceRef)).code, 0)

    const before = JSON.parse((await fn('inbound', dropRef)).stdout)
    assert.deepEqual(before[sourceRef].relations, ['drops'])

    // Next revision drops it. The index only learns that if we poke it too.
    delete linked.relations.drops
    writeFileSync(spec, JSON.stringify(linked))
    assert.equal((await ig(['create', spec, '--update', '--no-push'])).code, 0)

    const publish = await fn('publish', sourceRef)
    assert.equal(publish.code, 0, publish.stderr)
    assert.match(publish.stderr, /tombstoning/)

    const after = JSON.parse((await fn('inbound', dropRef)).stdout)
    assert.deepEqual(after[sourceRef].relations, [], 'observed absence is the tombstone')
    assert.ok(after[sourceRef].revision > before[sourceRef].revision)
  })

  it('an object nothing has pointed at has no index yet', async () => {
    // targetRef itself points at nobody but its author, and nothing points at
    // that author here, so the author's index exists while a fresh object's
    // does not. Use a ref that is definitely untouched.
    const untouched = `${store.pubkey}.99999999-9999-4999-8999-999999999999`
    const { code, stderr } = await fn('inbound', untouched, '--timeout', '15')
    assert.equal(code, 1)
    assert.match(stderr, /poked|not exist/i)
  })
})
