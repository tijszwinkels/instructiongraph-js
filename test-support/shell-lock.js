import { mkdir, rm } from 'node:fs/promises'
import os from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function withShellLock(fn) {
  const lockPath = join(os.tmpdir(), 'instructiongraph-js-shell-lock')

  for (;;) {
    try {
      await mkdir(lockPath)
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      await sleep(25)
    }
  }

  try {
    return await fn()
  } finally {
    await rm(lockPath, { recursive: true, force: true })
  }
}
