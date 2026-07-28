/**
 * The Freenet node client: `fdev` driven as a subprocess.
 *
 * fdev is the only supported way to talk to a node's ws-api, so this wraps it
 * rather than reimplementing the protocol. The invocations mirror the spike's
 * shell scripts exactly (scripts/lib.sh) — a drifted flag would address the
 * wrong keyspace and look like a missing object.
 *
 * Two things this layer exists to guarantee:
 *
 *   1. EVERY node call is bounded. A GET for a contract the node doesn't hold
 *      does not fail fast: it blocks for the host's multi-minute network fetch
 *      budget. Unbounded, that reads as a hung terminal.
 *   2. Every failure comes back diagnosable. "fdev exited 1" tells a user
 *      nothing; missing binary, timeout, node refusal and plain not-found are
 *      four different problems with four different fixes.
 *
 * `exec` is injected so the whole surface is testable without a node.
 */

import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_TIMEOUT_MS, DEFAULT_PUT_TIMEOUT_MS, PROBE_TIMEOUT_MS, FREENET_CONFIG_KEYS } from './config.js'

const stripAnsi = (s) => String(s ?? '').replace(/\[[0-9;]*m/g, '')

/** Last few meaningful lines of fdev output — enough to diagnose, not a wall. */
function tail(text, lines = 6) {
  return stripAnsi(text).split('\n').map(l => l.trimEnd()).filter(Boolean).slice(-lines).join('\n')
}

const seconds = (ms) => `${Math.round(ms / 1000)}s`

/**
 * fdev takes its own deadline in whole seconds (`--timeout`, default 300 s).
 * We always pass it, because a clean fdev give-up carries a real explanation
 * and a SIGKILL carries none. The process-level bound is then set ABOVE it as
 * a pure backstop for an fdev that ignores its own deadline.
 */
const FDEV_TIMEOUT_GRACE_MS = 10_000
const fdevTimeoutArgs = (ms) => ['--timeout', String(Math.max(1, Math.ceil(ms / 1000)))]
const processBound = (ms) => ms + FDEV_TIMEOUT_GRACE_MS

/**
 * Default exec: run a command, capture output, never reject.
 * Timeouts kill with SIGKILL — fdev must not be able to outlive its bound.
 */
function defaultExec(file, args, { timeoutMs }) {
  return new Promise((resolve) => {
    execFile(
      file, args,
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          return resolve({ code: null, stdout: '', stderr: '', timedOut: false, spawnError: err })
        }
        resolve({
          code: err ? (typeof err.code === 'number' ? err.code : null) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          timedOut: !!(err && err.killed),
          spawnError: null,
        })
      },
    )
  })
}

/** Serialize a state/payload argument to the bytes fdev should send. */
function toBytes(value) {
  if (value instanceof Uint8Array) return value
  if (typeof value === 'string') return new TextEncoder().encode(value)
  return new TextEncoder().encode(JSON.stringify(value))
}

/**
 * @param {object} opts
 * @param {string} opts.fdevPath
 * @param {number} opts.port
 * @param {Function} [opts.exec] - injected runner (tests)
 * @param {number} [opts.timeoutMs] - read timeout
 * @param {number} [opts.putTimeoutMs] - write timeout
 * @param {number} [opts.probeTimeoutMs] - DEV-2 local-presence probe
 */
export function createFdevNode({
  fdevPath,
  port,
  exec = defaultExec,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  putTimeoutMs = DEFAULT_PUT_TIMEOUT_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
}) {
  /** Run fdev in a scratch dir that is always cleaned up. */
  async function run(args, { timeoutMs: limit, files = {} }) {
    const dir = mkdtempSync(join(tmpdir(), 'ig-freenet-'))
    try {
      const paths = {}
      for (const [name, bytes] of Object.entries(files)) {
        paths[name] = join(dir, name)
        writeFileSync(paths[name], bytes)
      }
      const full = args(paths, dir)
      const res = await exec(fdevPath, full, { timeoutMs: processBound(limit) })
      if (res.spawnError) {
        throw new Error(
          `Could not run fdev at '${fdevPath}': ${res.spawnError.code === 'ENOENT' ? 'not found' : res.spawnError.message}\n` +
          `  Install fdev, put it on your PATH, or set its location:\n` +
          `    ig freenet config ${FREENET_CONFIG_KEYS.fdev} /path/to/fdev`,
        )
      }
      return { ...res, dir, paths }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  /** Shared failure text for writes — the two fixes are port and node health. */
  function writeFailure(what, res, limit) {
    if (res.timedOut) {
      return new Error(
        `${what} timed out after ${seconds(limit)} on 127.0.0.1:${port}.\n` +
        '  The node may be unreachable, or its ring placement may be stalled.\n' +
        `  Check the node is listening on port ${port} (fdev query), then retry — the flow is idempotent.`,
      )
    }
    const detail = tail(`${res.stderr}\n${res.stdout}`)
    return new Error(
      `${what} failed (fdev exit ${res.code ?? 'unknown'}) on 127.0.0.1:${port}` +
      (detail ? `:\n${detail.split('\n').map(l => `  ${l}`).join('\n')}` : '.'),
    )
  }

  /**
   * GET a contract's state.
   *
   * Never throws for a miss — absence is meaningful (a never-published
   * revision, an index nobody has poked), so callers decide what it means.
   * Reads the --output file before the scratch dir is torn down.
   *
   * @returns {Promise<{found: boolean, state: object|null, timedOut: boolean, detail: string}>}
   */
  async function getState(id, limit) {
    const dir = mkdtempSync(join(tmpdir(), 'ig-freenet-'))
    const outPath = join(dir, 'state.json')
    try {
      const res = await exec(
        fdevPath,
        ['-p', String(port), 'execute', 'get', id, '--output', outPath, ...fdevTimeoutArgs(limit)],
        { timeoutMs: processBound(limit) },
      )
      if (res.spawnError) {
        throw new Error(
          `Could not run fdev at '${fdevPath}': ${res.spawnError.code === 'ENOENT' ? 'not found' : res.spawnError.message}\n` +
          '  Install fdev, put it on your PATH, or set its location:\n' +
          `    ig freenet config ${FREENET_CONFIG_KEYS.fdev} /path/to/fdev`,
        )
      }
      if (res.timedOut) {
        return {
          found: false,
          state: null,
          timedOut: true,
          detail:
            `GET timed out after ${seconds(limit)}. On a connected node, a contract the node does not ` +
            'hold locally blocks for the network fetch budget (minutes) — so this is probably absent, ' +
            'but it is not proof. Raise --timeout to wait longer.',
        }
      }

      let raw = null
      try {
        if (statSync(outPath).size > 0) raw = readFileSync(outPath, 'utf-8')
      } catch { /* no output file — a miss */ }

      if (res.code !== 0 || !raw) {
        return {
          found: false,
          state: null,
          timedOut: false,
          detail: `no state returned for ${id} — not found on the node` +
            (res.code !== 0 && tail(res.stderr, 3) ? `\n  ${tail(res.stderr, 3)}` : ''),
        }
      }
      try {
        return { found: true, state: JSON.parse(raw), timedOut: false, detail: '', raw }
      } catch (err) {
        throw new Error(`Contract ${id} returned state that is not JSON: ${err.message}`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  return {
    port,
    fdevPath,
    timeoutMs,
    putTimeoutMs,

    get: (id, opts = {}) => getState(id, opts.timeoutMs ?? timeoutMs),

    /**
     * DEV-2 local-presence probe: bounded hard at 5 s. A locally hosted
     * contract answers in well under a second; anything slower is treated as
     * absent rather than waiting out the node's fetch budget.
     */
    probe: (id) => getState(id, probeTimeoutMs),

    /** PUT — creates the contract, or is an idempotent no-op / LWW merge. */
    async publish({ wasmPath, params, state }) {
      const res = await run(
        (paths) => [
          '-p', String(port), 'publish',
          '--code', wasmPath,
          '--parameters', paths['params.bin'],
          // --timeout is an option of `publish`, so it precedes the subcommand.
          ...fdevTimeoutArgs(putTimeoutMs),
          'contract',
          '--state', paths['state.json'],
        ],
        {
          timeoutMs: putTimeoutMs,
          files: { 'params.bin': params, 'state.json': toBytes(state) },
        },
      )
      if (res.timedOut || res.code !== 0) throw writeFailure('PUT', res, putTimeoutMs)
      return { ok: true, output: tail(`${res.stdout}\n${res.stderr}`) }
    },

    /** UPDATE — sends a delta to an existing contract. */
    async update(id, payload) {
      const res = await run(
        (paths) => [
          '-p', String(port), 'execute', 'update', id, paths['payload.json'],
          ...fdevTimeoutArgs(putTimeoutMs),
        ],
        { timeoutMs: putTimeoutMs, files: { 'payload.json': toBytes(payload) } },
      )
      if (res.timedOut || res.code !== 0) throw writeFailure(`UPDATE of ${id}`, res, putTimeoutMs)
      return { ok: true, output: tail(`${res.stdout}\n${res.stderr}`) }
    },
  }
}
