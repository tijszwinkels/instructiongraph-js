/**
 * Shell lock — prevents parallel test runs from clobbering shared /tmp files
 * when calling shell scripts that write to fixed paths.
 *
 * Uses mkdir as an atomic lock (EEXIST = already held).
 */
import { mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const LOCK_PATH = join(tmpdir(), 'instructiongraph-js-shell-lock')
const sleep = ms => new Promise(r => setTimeout(r, ms))

export async function withShellLock(fn) {
  for (;;) {
    try {
      await mkdir(LOCK_PATH)
      break
    } catch (e) {
      if (e?.code !== 'EEXIST') throw e
      await sleep(25)
    }
  }
  try {
    return await fn()
  } finally {
    await rm(LOCK_PATH, { recursive: true, force: true })
  }
}
