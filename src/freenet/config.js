/**
 * Freenet backend configuration.
 *
 * Stored the way every other ig setting is: one flat file per key under
 * <configDir>/config/. The reader is injected rather than imported so this
 * module stays free of node:fs and of cli/runtime.js (which imports from
 * src/, not the other way round).
 *
 * Precedence: command-line flag > stored config > default.
 */

export const FREENET_CONFIG_KEYS = {
  port: 'freenet-port',
  fdev: 'freenet-fdev',
  contractsDir: 'freenet-contracts-dir',
}

/** The node's ws-api port used by the dataverse spike work. */
export const DEFAULT_PORT = 7509

/**
 * Read timeout. A GET for a contract the node doesn't hold does not fail
 * fast — it blocks for the host's network fetch budget (minutes). Bounding
 * it is what turns "hung terminal" into a diagnosable error.
 */
export const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Write timeout. A PUT round-trips ring placement against the node's own
 * ~300 s budget, so this has to sit above it or we would report failures the
 * node was still working on.
 */
export const DEFAULT_PUT_TIMEOUT_MS = 330_000

/**
 * DEV-2: the bounded local-presence probe before a poke. A locally hosted
 * contract answers in well under a second, so 5 s cleanly separates "already
 * here" from "would go to the network" without ever waiting out the fetch
 * budget. Deliberately not configurable — it is a semantic constant of the
 * poke flow, not a tuning knob.
 */
export const PROBE_TIMEOUT_MS = 5_000

function positiveInt(value, label) {
  const n = typeof value === 'number' ? value : Number(String(value).trim())
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`Invalid ${label}: ${JSON.stringify(value)} — expected a positive integer`)
  }
  return n
}

/**
 * @param {(key: string) => (string|null)} read - stored-config getter
 * @param {object} flags - parsed command-line overrides
 * @returns {{port: number, fdevPath: string, contractsDir: string,
 *            timeoutMs: number, putTimeoutMs: number}}
 */
export function resolveFreenetConfig(read, flags = {}) {
  const stored = (key) => {
    const v = read(key)
    return v === null || v === undefined || v === '' ? null : v
  }

  const contractsDir = flags.contractsDir ?? stored(FREENET_CONFIG_KEYS.contractsDir)
  if (!contractsDir) {
    throw new Error(
      'Freenet contracts directory is not configured.\n' +
      `  Set it with:  ig freenet config ${FREENET_CONFIG_KEYS.contractsDir} <dir>\n` +
      '  Or pass:      --contracts-dir <dir>\n' +
      'The directory must hold the pinned contract WASMs: dataverse_object.wasm,\n' +
      'dataverse_object_rev.wasm, dataverse_inbound_index.wasm.',
    )
  }

  const rawPort = flags.port ?? stored(FREENET_CONFIG_KEYS.port) ?? DEFAULT_PORT
  const port = positiveInt(rawPort, 'Freenet port')
  if (port > 65535) throw new Error(`Invalid Freenet port: ${port} — expected a positive integer below 65536`)

  return {
    port,
    fdevPath: flags.fdev ?? stored(FREENET_CONFIG_KEYS.fdev) ?? 'fdev',
    contractsDir,
    timeoutMs: flags.timeout === undefined
      ? DEFAULT_TIMEOUT_MS
      : positiveInt(flags.timeout, 'timeout') * 1000,
    putTimeoutMs: flags.putTimeout === undefined
      ? DEFAULT_PUT_TIMEOUT_MS
      : positiveInt(flags.putTimeout, 'put-timeout') * 1000,
  }
}
