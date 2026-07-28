/**
 * `ig freenet` CLI integration, end to end, offline.
 *
 * Runs the real CLI against a real local .instructionGraph store and a fake
 * fdev (test-support/fake-fdev.js). No Freenet node is contacted and the
 * shared node on :7509 is never touched — the fake is selected with --fdev.
 *
 * What is under test here is the CLI contract: subcommand surface, flag
 * handling, what lands on stdout vs stderr, and exit codes. Address
 * correctness is pinned by the golden vectors in freenet-addressing.test.js
 * and by the live e2e.
 */

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { setupIgStore } from '../test-support/ig-store.js'
import { createAddressing } from '../src/freenet/addressing.js'
import { loadContracts } from '../src/freenet/contracts.js'

const execFile = promisify(execFileCb)
const CLI = join(import.meta.dirname, '..', 'cli', 'ig.js')
const FAKE_FDEV = join(import.meta.dirname, '..', 'test-support', 'fake-fdev.js')

describe('ig freenet', () => {
  let store, contractsDir, fdevShim, statePath, addressing, sourceRef, targetRef, sourceEnv, pokeTargets

  /** Run the CLI; resolves with {stdout, stderr, code} instead of throwing. */
  async function ig(args, { state = null } = {}) {
    if (state) await writeFile(statePath, JSON.stringify(state, null, 2))
    try {
      const r = await execFile(process.execPath, [CLI, ...args], {
        env: { ...process.env, INSTRUCTIONGRAPH_DIR: store.dir, FAKE_FDEV_STATE: statePath },
      })
      return { ...r, code: 0 }
    } catch (err) {
      return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: err.code ?? 1 }
    }
  }

  /**
   * Run `ig freenet …` against the fake node. A trailing object is the fake
   * node's seed state, not an argument. The state is ALWAYS rewritten, so each
   * invocation starts from a known node rather than inheriting the last test's.
   */
  const fn = (...args) => {
    const last = args.at(-1)
    const seed = last !== null && typeof last === 'object' ? args.pop() : {}
    return ig(['freenet', ...args, '--contracts-dir', contractsDir, '--fdev', fdevShim], { state: seed })
  }

  const readState = async () => JSON.parse(await readFile(statePath, 'utf-8'))

  /** `ig create` prints a status line before the ref; the ref is last. */
  const lastLine = (stdout) => stdout.trim().split('\n').pop().trim()

  before(async () => {
    store = await setupIgStore({ realm: 'server-public' })

    // Stand-in contract WASMs: distinct bytes are all the addressing needs.
    contractsDir = await mkdtemp(join(tmpdir(), 'ig-fn-wasm-'))
    await writeFile(join(contractsDir, 'dataverse_object.wasm'), 'fake-object-contract')
    await writeFile(join(contractsDir, 'dataverse_object_rev.wasm'), 'fake-snapshot-contract')
    await writeFile(join(contractsDir, 'dataverse_inbound_index.wasm'), 'fake-index-contract')
    addressing = createAddressing(loadContracts(contractsDir).codeHashes)

    const bin = await mkdtemp(join(tmpdir(), 'ig-fn-bin-'))
    fdevShim = join(bin, 'fdev')
    await writeFile(fdevShim, `#!/bin/sh\nexec ${process.execPath} ${JSON.stringify(FAKE_FDEV)} "$@"\n`, { mode: 0o755 })

    statePath = join(await mkdtemp(join(tmpdir(), 'ig-fn-state-')), 'state.json')
    await writeFile(statePath, '{}')

    // A real signed target, and a real signed source pointing at it twice.
    const specPath = join(contractsDir, 'spec.json')
    await writeFile(specPath, JSON.stringify({ type: 'NOTE', name: 'target', instruction: 'target object' }))
    targetRef = lastLine((await ig(['create', specPath, '--no-push'])).stdout)

    await writeFile(specPath, JSON.stringify({
      type: 'NOTE',
      name: 'source',
      instruction: 'source object',
      relations: { root: [{ ref: targetRef }], mentions: [{ ref: targetRef }] },
    }))
    sourceRef = lastLine((await ig(['create', specPath, '--no-push'])).stdout)
    sourceEnv = JSON.parse((await ig(['get', sourceRef])).stdout)

    // `ig create` also auto-fills relations.author → the signer's identity
    // object, so the real target set is {target, author} — two distinct
    // targets reached by three relations.
    pokeTargets = [...new Set(
      Object.values(sourceEnv.item.relations).flat().map(entry => entry.ref),
    )]
    assert.equal(pokeTargets.length, 2)
    assert.ok(pokeTargets.includes(targetRef))
  })

  after(async () => {
    for (const d of [store?.dir, contractsDir]) if (d) await rm(d, { recursive: true, force: true })
  })

  // ─── surface ───────────────────────────────────────────────────

  it('lists its subcommands in --help', async () => {
    const { stdout, code } = await ig(['freenet', '--help'])
    assert.equal(code, 0)
    for (const sub of ['publish', 'get', 'inbound', 'verify', 'derive', 'config']) {
      assert.match(stdout, new RegExp(`ig freenet ${sub}`), `--help should document '${sub}'`)
    }
  })

  it('rejects an unknown subcommand and an unknown flag', async () => {
    const bad = await ig(['freenet', 'frobnicate'])
    assert.equal(bad.code, 1)
    assert.match(bad.stderr, /frobnicate/)

    const badFlag = await fn('derive', sourceRef, '--nope', 'x')
    assert.equal(badFlag.code, 1)
    assert.match(badFlag.stderr, /--nope/)
  })

  // ─── config ────────────────────────────────────────────────────

  it('explains what to configure when the contracts dir is unset', async () => {
    const { stderr, code } = await ig(['freenet', 'derive', sourceRef])
    assert.equal(code, 1)
    assert.match(stderr, /contracts/i)
    assert.match(stderr, /freenet-contracts-dir/)
    assert.match(stderr, /--contracts-dir/)
  })

  it('stores and shows configuration', async () => {
    assert.equal((await ig(['freenet', 'config', 'freenet-port', '7511'])).code, 0)
    const shown = await ig(['freenet', 'config'])
    assert.match(shown.stdout, /freenet-port\s+7511/)
    // A stored port is used when no flag overrides it.
    const derived = await fn('derive', sourceRef)
    assert.equal(derived.code, 0)
    assert.equal((await ig(['freenet', 'config', 'freenet-port', '7509'])).code, 0)
  })

  it('refuses an unknown config key rather than writing it', async () => {
    const { code, stderr } = await ig(['freenet', 'config', 'freenet-nonsense', 'x'])
    assert.equal(code, 1)
    assert.match(stderr, /freenet-nonsense/)
  })

  // ─── derive ────────────────────────────────────────────────────

  it('derives ids without contacting the node', async () => {
    const { stdout, code } = await fn('derive', sourceRef, '--rev', '0')
    assert.equal(code, 0)
    const out = JSON.parse(stdout)
    assert.equal(out.head, addressing.headId(sourceRef))
    assert.equal(out.index, addressing.indexId(sourceRef))
    assert.equal(out.snapshot, addressing.snapshotId(sourceRef, 0))
    assert.deepEqual((await readState()).calls ?? [], [], 'derive must not call fdev')
  })

  it('omits the snapshot id when no revision is given', async () => {
    const out = JSON.parse((await fn('derive', sourceRef)).stdout)
    assert.equal(out.snapshot, undefined)
    assert.ok(out.head && out.index)
  })

  it('reports a malformed ref instead of deriving a plausible address', async () => {
    const { code, stderr } = await fn('derive', 'not-a-ref')
    assert.equal(code, 1)
    assert.match(stderr, /ref/i)
  })

  // ─── publish ───────────────────────────────────────────────────

  it('publishes the snapshot, head and index, then pokes each target once', async () => {
    const { code, stderr } = await fn('publish', sourceRef)
    assert.equal(code, 0, stderr)

    const { calls } = await readState()
    const ops = calls.map(c => c.op)
    assert.equal(ops[0], 'publish')
    assert.equal(calls[0].wasm, 'dataverse_object_rev.wasm', 'snapshot PUT first')
    assert.equal(calls[0].id, addressing.snapshotId(sourceRef, 0))
    assert.equal(ops[1], 'get', 'GET-back gate')

    const pokes = calls.filter(c => c.op === 'update')
    assert.equal(pokes.length, pokeTargets.length)
    assert.deepEqual(
      new Set(pokes.map(p => p.id)),
      new Set(pokeTargets.map(t => addressing.indexId(t))),
    )
    // `root` and `mentions` both point at the target — still exactly one poke.
    const toTarget = pokes.filter(p => p.id === addressing.indexId(targetRef))
    assert.equal(toTarget.length, 1)
    assert.deepEqual(toTarget[0].payload, { v: 1, poke: { source_ref: sourceRef, revision: 0 } })

    assert.match(stderr, /1\/4/)
    assert.match(stderr, /4\/4/)
    assert.match(stderr, new RegExp(`${pokeTargets.length}/${pokeTargets.length} ok`))
  })

  it('is idempotent — a second publish converges and stays exit 0', async () => {
    const contracts = {
      [addressing.snapshotId(sourceRef, 0)]: sourceEnv,
      [addressing.headId(sourceRef)]: sourceEnv,
    }
    for (const t of pokeTargets) contracts[addressing.indexId(t)] = { v: 1, slots: {} }

    const { code } = await fn('publish', sourceRef, { contracts })
    assert.equal(code, 0)
    const { calls } = await readState()
    // DEV-2: every index is already local, so none may be re-published.
    assert.equal(calls.filter(c => c.wasm === 'dataverse_inbound_index.wasm').length, 0)
    assert.equal(calls.filter(c => c.op === 'update').length, pokeTargets.length)
  })

  it('aborts before any poke when the snapshot does not GET back', async () => {
    // The PUT is accepted but the state never sticks — the real "ring
    // placement did not take" failure. Poking now would stall on every
    // target for the node's fetch budget and then fail.
    const { code, stderr } = await fn('publish', sourceRef, {
      swallowPublish: ['dataverse_object_rev.wasm'],
    })
    assert.equal(code, 1)
    assert.match(stderr, /snapshot did not GET back/i)
    assert.match(stderr, /poke/i)
    const { calls } = await readState()
    assert.equal(calls.filter(c => c.op === 'update').length, 0, 'no poke was sent')
    assert.equal(
      calls.filter(c => c.wasm === 'dataverse_object.wasm').length, 0,
      'the head was never published either',
    )
  })

  it('aborts when the snapshot PUT itself fails', async () => {
    const { code, stderr } = await fn('publish', sourceRef, {
      failPublish: ['dataverse_object_rev.wasm'],
    })
    assert.equal(code, 1)
    assert.match(stderr, /put timed out/i)
    const { calls } = await readState()
    assert.equal(calls.filter(c => c.op === 'update').length, 0)
  })

  it('exits non-zero and reports the target when a poke fails', async () => {
    const { code, stderr } = await fn('publish', sourceRef, {
      failUpdate: [addressing.indexId(targetRef)],
    })
    assert.equal(code, 1)
    // One of the two targets failed; the other still went out.
    assert.match(stderr, new RegExp(`1/${pokeTargets.length} ok`))
    assert.match(stderr, new RegExp(targetRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.match(stderr, /InvalidUpdateWithInfo/)
    assert.match(stderr, /re-run/i, 'tells the user the flow is re-runnable')
  })

  it('reports a ref that is in neither the local store nor the hub', async () => {
    const missing = `${store.pubkey}.11111111-1111-4111-8111-111111111111`
    const { code, stderr } = await fn('publish', missing)
    assert.equal(code, 1)
    assert.match(stderr, /not found/i)
  })

  it('names the fdev path when the binary cannot be run', async () => {
    const { code, stderr } = await ig([
      'freenet', 'get', sourceRef, '--contracts-dir', contractsDir, '--fdev', '/no/such/fdev',
    ])
    assert.equal(code, 1)
    assert.match(stderr, /\/no\/such\/fdev/)
    assert.match(stderr, /fdev/)
  })

  // ─── get ───────────────────────────────────────────────────────

  it('gets the head and prints the envelope as JSON', async () => {
    const { stdout, code } = await fn('get', sourceRef, {
      contracts: { [addressing.headId(sourceRef)]: sourceEnv },
    })
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), sourceEnv)
  })

  it('gets a specific revision with --rev', async () => {
    const { stdout, code } = await fn('get', sourceRef, '--rev', '0', {
      contracts: { [addressing.snapshotId(sourceRef, 0)]: sourceEnv },
    })
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), sourceEnv)
  })

  it('never falls back to the head when a revision is missing — absence is meaningful', async () => {
    const { code, stderr, stdout } = await fn('get', sourceRef, '--rev', '9', {
      contracts: { [addressing.headId(sourceRef)]: sourceEnv },
    })
    assert.equal(code, 1)
    assert.equal(stdout.trim(), '')
    assert.match(stderr, /not found|revision 9/i)
  })

  // ─── inbound ───────────────────────────────────────────────────

  it('prints the slot map as jq-friendly JSON', async () => {
    const slots = { [sourceRef]: { revision: 0, relations: ['mentions', 'root'] } }
    const { stdout, code } = await fn('inbound', targetRef, {
      contracts: { [addressing.indexId(targetRef)]: { v: 1, slots } },
    })
    assert.equal(code, 0)
    assert.deepEqual(JSON.parse(stdout), slots)
  })

  it('distinguishes an index with no slots from one that does not exist', async () => {
    const empty = await fn('inbound', targetRef, {
      contracts: { [addressing.indexId(targetRef)]: { v: 1, slots: {} } },
    })
    assert.equal(empty.code, 0)
    assert.deepEqual(JSON.parse(empty.stdout), {})

    const absent = await fn('inbound', targetRef, { contracts: {} })
    assert.equal(absent.code, 1)
    assert.match(absent.stderr, /poked|not exist/i)
  })

  // ─── verify ────────────────────────────────────────────────────

  it('reports verified-current and exits 0 when every slot checks out', async () => {
    const { stdout, code } = await fn('verify', targetRef, {
      contracts: {
        [addressing.indexId(targetRef)]: {
          v: 1,
          slots: { [sourceRef]: { revision: 0, relations: ['mentions', 'root'] } },
        },
        [addressing.snapshotId(sourceRef, 0)]: sourceEnv,
        [addressing.headId(sourceRef)]: sourceEnv,
      },
    })
    assert.equal(code, 0)
    assert.match(stdout, /verified-current/)
    assert.match(stdout, new RegExp(sourceRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  it('exits 1 when a slot cannot be verified against its snapshot', async () => {
    const { stdout, code } = await fn('verify', targetRef, {
      contracts: {
        [addressing.indexId(targetRef)]: {
          v: 1,
          slots: { [sourceRef]: { revision: 0, relations: ['author'] } },
        },
        [addressing.snapshotId(sourceRef, 0)]: sourceEnv,
        [addressing.headId(sourceRef)]: sourceEnv,
      },
    })
    assert.equal(code, 1)
    assert.match(stdout, /unverified/)
  })

  it('exits 0 for a stale-but-honest slot', async () => {
    const moved = JSON.parse(JSON.stringify(sourceEnv))
    moved.item.revision = 5
    const { stdout, code } = await fn('verify', targetRef, {
      contracts: {
        [addressing.indexId(targetRef)]: {
          v: 1,
          slots: { [sourceRef]: { revision: 0, relations: ['mentions', 'root'] } },
        },
        [addressing.snapshotId(sourceRef, 0)]: sourceEnv,
        [addressing.headId(sourceRef)]: moved,
      },
    })
    assert.equal(code, 0)
    assert.match(stdout, /verified-stale/)
    assert.match(stdout, /head is at 5/)
  })
})
