/**
 * Freenet config resolution and the fdev node client.
 *
 * The node client is exercised against an INJECTED exec, so these tests never
 * spawn fdev and never touch a node. What they pin down is the part that is
 * easy to get quietly wrong: the exact argv we hand fdev (a drifted flag
 * publishes into the wrong keyspace), and the error classification — a user
 * staring at "command failed" learns nothing, so every failure mode has to
 * come back as its own diagnosable message.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveFreenetConfig, FREENET_CONFIG_KEYS } from '../src/freenet/config.js'
import { createFdevNode } from '../src/freenet/fdev.js'
import { loadContracts } from '../src/freenet/contracts.js'

/** A fake exec that records calls and replays scripted results. */
function fakeExec(results = []) {
  const calls = []
  const queue = [...results]
  const exec = async (file, args, opts) => {
    calls.push({ file, args, opts })
    const next = queue.shift() ?? { code: 0, stdout: '', stderr: '' }
    if (typeof next === 'function') return next({ file, args, opts })
    return { code: 0, stdout: '', stderr: '', timedOut: false, spawnError: null, ...next }
  }
  return { exec, calls }
}

const node = (opts = {}) => createFdevNode({
  fdevPath: 'fdev', port: 7509, exec: fakeExec().exec, ...opts,
})

// ─── config ──────────────────────────────────────────────────────

test('config falls back to documented defaults', () => {
  const cfg = resolveFreenetConfig(() => null, { contractsDir: '/pinned' })
  assert.equal(cfg.port, 7509)
  assert.equal(cfg.fdevPath, 'fdev')
  assert.equal(cfg.contractsDir, '/pinned')
})

test('config reads stored keys and lets flags win', () => {
  const stored = {
    [FREENET_CONFIG_KEYS.port]: '7511',
    [FREENET_CONFIG_KEYS.fdev]: '/opt/fdev',
    [FREENET_CONFIG_KEYS.contractsDir]: '/stored/contracts',
  }
  const read = (k) => stored[k] ?? null
  assert.equal(resolveFreenetConfig(read, {}).port, 7511)
  assert.equal(resolveFreenetConfig(read, {}).fdevPath, '/opt/fdev')
  assert.equal(resolveFreenetConfig(read, {}).contractsDir, '/stored/contracts')
  assert.equal(resolveFreenetConfig(read, { port: 7599 }).port, 7599)
  assert.equal(resolveFreenetConfig(read, { contractsDir: '/flag' }).contractsDir, '/flag')
})

test('config explains how to fix an unset contracts dir', () => {
  assert.throws(() => resolveFreenetConfig(() => null, {}), (err) => {
    assert.match(err.message, /contracts/i)
    assert.match(err.message, new RegExp(FREENET_CONFIG_KEYS.contractsDir), 'names the config key')
    assert.match(err.message, /--contracts-dir/, 'names the flag')
    return true
  })
})

test('config rejects a nonsense port instead of passing it to fdev', () => {
  assert.throws(
    () => resolveFreenetConfig(() => null, { contractsDir: '/c', port: 'seven' }),
    /port/i,
  )
  assert.throws(
    () => resolveFreenetConfig((k) => (k === FREENET_CONFIG_KEYS.port ? '0' : null), { contractsDir: '/c' }),
    /port/i,
  )
})

// ─── contracts dir ───────────────────────────────────────────────

test('loadContracts hashes the three pinned WASMs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ig-fn-contracts-'))
  try {
    await writeFile(join(dir, 'dataverse_object.wasm'), 'a')
    await writeFile(join(dir, 'dataverse_object_rev.wasm'), 'b')
    await writeFile(join(dir, 'dataverse_inbound_index.wasm'), 'c')
    const c = loadContracts(dir)
    assert.equal(c.codeHashes.object.length, 32)
    assert.equal(c.codeHashes.snapshot.length, 32)
    assert.equal(c.codeHashes.index.length, 32)
    assert.equal(c.paths.object, join(dir, 'dataverse_object.wasm'))
    assert.notDeepEqual(c.codeHashes.object, c.codeHashes.snapshot)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadContracts names the missing file and the directory it looked in', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ig-fn-contracts-'))
  try {
    await writeFile(join(dir, 'dataverse_object.wasm'), 'a')
    assert.throws(() => loadContracts(dir), (err) => {
      assert.match(err.message, /dataverse_object_rev\.wasm/)
      assert.match(err.message, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      return true
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('loadContracts reports a missing contracts directory distinctly', () => {
  assert.throws(() => loadContracts('/definitely/not/here'), /not a directory|does not exist/i)
})

// ─── fdev argv ───────────────────────────────────────────────────

test('get issues `fdev -p PORT execute get <id> --output <file> --timeout <s>`', async () => {
  const { exec, calls } = fakeExec([{ code: 1, stderr: 'client error: missing contract: ID' }])
  const n = createFdevNode({ fdevPath: '/opt/fdev', port: 7511, exec, timeoutMs: 30_000 })
  await n.get('SOMECONTRACTID')
  assert.equal(calls[0].file, '/opt/fdev')
  assert.deepEqual(calls[0].args.slice(0, 5), ['-p', '7511', 'execute', 'get', 'SOMECONTRACTID'])
  assert.ok(calls[0].args.includes('--output'))
  assert.equal(calls[0].args[calls[0].args.indexOf('--timeout') + 1], '30', 'fdev timeout in seconds')
})

test('fdev gets its own --timeout, and the process bound sits above it', async () => {
  // fdev can give up cleanly and explain itself; SIGKILL cannot. So fdev's
  // deadline must fire FIRST, with the process kill only as a hard backstop.
  const { exec, calls } = fakeExec([{ code: 1, stderr: 'client error: missing contract: ID' }])
  const n = createFdevNode({ fdevPath: 'fdev', port: 7509, exec, timeoutMs: 20_000 })
  await n.get('ID')
  const fdevTimeoutS = Number(calls[0].args[calls[0].args.indexOf('--timeout') + 1])
  assert.equal(fdevTimeoutS, 20)
  assert.ok(
    calls[0].opts.timeoutMs > fdevTimeoutS * 1000,
    `process bound ${calls[0].opts.timeoutMs}ms must exceed fdev's ${fdevTimeoutS}s`,
  )
})

test('get returns the parsed state and found=true', async () => {
  const { exec } = fakeExec([
    async ({ args }) => {
      const out = args[args.indexOf('--output') + 1]
      await writeFile(out, JSON.stringify({ v: 1, slots: {} }))
      return { code: 0 }
    },
  ])
  const res = await createFdevNode({ fdevPath: 'fdev', port: 7509, exec }).get('ID')
  assert.equal(res.found, true)
  assert.deepEqual(res.state, { v: 1, slots: {} })
})

test('get reports not-found rather than throwing, and says so plainly', async () => {
  const { exec } = fakeExec([{ code: 1, stderr: 'contract not found' }])
  const res = await createFdevNode({ fdevPath: 'fdev', port: 7509, exec }).get('ID')
  assert.equal(res.found, false)
  assert.equal(res.state, null)
  assert.match(res.detail, /not found|no state/i)
})

test('an empty output file is a miss, not an empty state', async () => {
  const { exec } = fakeExec([
    async ({ args }) => {
      await writeFile(args[args.indexOf('--output') + 1], '')
      return { code: 0 }
    },
  ])
  const res = await createFdevNode({ fdevPath: 'fdev', port: 7509, exec }).get('ID')
  assert.equal(res.found, false)
})

test('a timed-out GET is distinguished from a miss and explains why it is slow', async () => {
  const { exec } = fakeExec([{ code: null, timedOut: true }])
  const res = await createFdevNode({ fdevPath: 'fdev', port: 7509, exec, timeoutMs: 4000 }).get('ID')
  assert.equal(res.found, false)
  assert.equal(res.timedOut, true)
  assert.match(res.detail, /timed out/i)
  assert.match(res.detail, /4/, 'names the timeout that elapsed')
})

test('a missing fdev binary is reported as such, with the path tried', async () => {
  const { exec } = fakeExec([{ spawnError: Object.assign(new Error('spawn'), { code: 'ENOENT' }) }])
  const n = createFdevNode({ fdevPath: '/no/such/fdev', port: 7509, exec })
  await assert.rejects(() => n.get('ID'), (err) => {
    assert.match(err.message, /fdev/)
    assert.match(err.message, /\/no\/such\/fdev/)
    assert.match(err.message, /freenet-fdev|PATH/i, 'tells the user how to fix it')
    return true
  })
})

test('publish issues `fdev -p PORT publish --code W --parameters P contract --state S`', async () => {
  const { exec, calls } = fakeExec([{ code: 0 }])
  const n = createFdevNode({ fdevPath: 'fdev', port: 7509, exec, putTimeoutMs: 330_000 })
  await n.publish({ wasmPath: '/w.wasm', params: new Uint8Array([1, 2]), state: { hello: 1 } })
  const a = calls[0].args
  assert.deepEqual(a.slice(0, 4), ['-p', '7509', 'publish', '--code'])
  assert.equal(a[4], '/w.wasm')
  assert.equal(a[5], '--parameters')
  // --timeout belongs to `publish`, so it must precede the `contract` subcommand.
  assert.ok(a.indexOf('--timeout') > 0 && a.indexOf('--timeout') < a.indexOf('contract'))
  assert.equal(a[a.indexOf('--timeout') + 1], '330')
  assert.equal(a[a.indexOf('contract') + 1], '--state')
})

test('update issues `fdev -p PORT execute update <id> <payload-file>`', async () => {
  const { exec, calls } = fakeExec([{ code: 0 }])
  const n = createFdevNode({ fdevPath: 'fdev', port: 7509, exec })
  await n.update('THEID', { v: 1, poke: { source_ref: 'x.y', revision: 1 } })
  const a = calls[0].args
  assert.deepEqual(a.slice(0, 4), ['-p', '7509', 'execute', 'update'])
  assert.equal(a[4], 'THEID')
  assert.equal(a[5].endsWith('payload.json'), true, 'delta file is the second positional')
})

test('a failed publish surfaces fdev stderr, ANSI stripped', async () => {
  const { exec } = fakeExec([{ code: 1, stderr: '[31mError: put timed out after 1 peer attempt(s)[0m' }])
  const n = createFdevNode({ fdevPath: 'fdev', port: 7509, exec })
  await assert.rejects(
    () => n.publish({ wasmPath: '/w.wasm', params: new Uint8Array([1]), state: {} }),
    (err) => {
      assert.match(err.message, /put timed out after 1 peer attempt/)
      assert.doesNotMatch(err.message, /\[/, 'ANSI escapes stripped')
      return true
    },
  )
})

test('a timed-out write says how long it waited and that the node may be unreachable', async () => {
  const { exec } = fakeExec([{ timedOut: true }])
  const n = createFdevNode({ fdevPath: 'fdev', port: 7509, exec, putTimeoutMs: 12000 })
  await assert.rejects(
    () => n.publish({ wasmPath: '/w.wasm', params: new Uint8Array([1]), state: {} }),
    (err) => {
      assert.match(err.message, /timed out/i)
      assert.match(err.message, /12/)
      assert.match(err.message, /7509/, 'names the port, so a wrong-port config is obvious')
      return true
    },
  )
})

test('node operations clean up their temp files', async () => {
  const seen = []
  const { exec } = fakeExec([
    async ({ args }) => {
      seen.push(args[args.indexOf('--parameters') + 1], args[args.indexOf('--state') + 1])
      return { code: 0 }
    },
  ])
  const n = createFdevNode({ fdevPath: 'fdev', port: 7509, exec })
  await n.publish({ wasmPath: '/w.wasm', params: new Uint8Array([1]), state: {} })
  const { existsSync } = await import('node:fs')
  for (const p of seen) assert.equal(existsSync(p), false, `temp file left behind: ${p}`)
})

test('the DEV-2 probe uses its own short timeout, not the read timeout', async () => {
  // DEV-2: a locally hosted contract answers in well under a second, so 5 s
  // separates "already here" from "would go to the network" without ever
  // waiting out the node's fetch budget. It must not inherit --timeout.
  const { exec, calls } = fakeExec([{ code: 1, stderr: 'client error: missing contract: ID' }])
  const n = createFdevNode({ fdevPath: 'fdev', port: 7509, exec, timeoutMs: 60_000, probeTimeoutMs: 5_000 })
  await n.probe('ID')
  assert.equal(calls[0].args[calls[0].args.indexOf('--timeout') + 1], '5')
  assert.ok(calls[0].opts.timeoutMs < 60_000, 'process bound stays near the probe bound')
})

// ─── operational failure vs genuine absence ──────────────────────

test('a non-ENOENT spawn failure (e.g. EACCES) is still a spawn failure', async () => {
  // execFile reports spawn problems with a STRING code and exit failures with
  // a number; anything non-numeric must not fall through as a contract miss.
  const { exec } = fakeExec([{ spawnError: Object.assign(new Error('permission denied'), { code: 'EACCES' }) }])
  const n = createFdevNode({ fdevPath: '/root/fdev', port: 7509, exec })
  await assert.rejects(() => n.get('ID'), (err) => {
    assert.match(err.message, /\/root\/fdev/)
    assert.doesNotMatch(err.message, /not found on the node/i)
    return true
  })
})

test('an unreachable node is an error, not "contract not found"', async () => {
  // fdev's real wording, captured from the binary on 2026-07-28.
  const { exec } = fakeExec([{
    code: 1,
    stderr: 'Error: failed to connect to the host(ws://127.0.0.1:7599/v1/contract/command): IO error: Connection refused (os error 111)',
  }])
  const n = createFdevNode({ fdevPath: 'fdev', port: 7599, exec })
  await assert.rejects(() => n.get('ID'), (err) => {
    assert.match(err.message, /could not reach|connect/i)
    assert.match(err.message, /7599/, 'names the port, the usual cause')
    return true
  })
})

test('a genuine miss is reported as a miss, not an error', async () => {
  const { exec } = fakeExec([{ code: 1, stderr: 'Error: Failed to receive response: client error: missing contract: ABC' }])
  const res = await createFdevNode({ fdevPath: 'fdev', port: 7509, exec }).get('ABC')
  assert.equal(res.found, false)
  assert.equal(res.operational, false)
  assert.match(res.detail, /not found/i)
})

test('an unrecognised failure is surfaced, never silently treated as absence', async () => {
  const { exec } = fakeExec([{ code: 3, stderr: 'Error: something nobody predicted' }])
  const n = createFdevNode({ fdevPath: 'fdev', port: 7509, exec })
  await assert.rejects(() => n.get('ID'), /something nobody predicted/)
})

test('a probe treats an unreachable node as an error, so DEV-2 cannot mass-create indexes', async () => {
  const { exec } = fakeExec([{ code: 1, stderr: 'Error: failed to connect to the host(ws://x): Connection refused' }])
  const n = createFdevNode({ fdevPath: 'fdev', port: 7509, exec })
  await assert.rejects(() => n.probe('ID'), /could not reach|connect/i)
})
