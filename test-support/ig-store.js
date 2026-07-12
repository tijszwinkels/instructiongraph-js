/**
 * Test-support: an isolated, offline .instructionGraph store with a throwaway
 * identity, plus a PATH shim so real `git` can find the git-remote-ig helper.
 * Everything is local — never touches a hub.
 */

import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { throwawayIdentity } from './throwaway-identity.js'

/** Create an offline local store (no hub-url) with an active throwaway identity. */
export async function setupIgStore({ realm = 'server-public' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ig-e2e-store-'))
  mkdirSync(join(dir, 'data'), { recursive: true })
  mkdirSync(join(dir, 'config'), { recursive: true })
  const id = await throwawayIdentity()
  const idDir = join(dir, 'identities', 'default')
  mkdirSync(idDir, { recursive: true })
  writeFileSync(join(idDir, 'private.pem'), id.pem, { mode: 0o600 })
  writeFileSync(join(dir, 'config', 'active-identity'), 'default\n')
  writeFileSync(join(dir, 'config', 'default-realm'), `${realm}\n`)
  return { dir, pubkey: id.pubkey, realm }
}

/** Write an executable `git-remote-ig` wrapper into a fresh dir; return the dir. */
export function setupHelperOnPath() {
  const here = dirname(fileURLToPath(import.meta.url))
  const helperJs = join(here, '..', 'cli', 'git-remote-ig.js')
  const bindir = mkdtempSync(join(tmpdir(), 'ig-e2e-bin-'))
  writeFileSync(join(bindir, 'git-remote-ig'), `#!/bin/sh\nexec node ${JSON.stringify(helperJs)} "$@"\n`, { mode: 0o755 })
  return bindir
}

/** Environment for invoking git with the helper + store visible. */
export function gitEnv(store, bindir, extra = {}) {
  return {
    ...process.env,
    PATH: `${bindir}:${process.env.PATH}`,
    INSTRUCTIONGRAPH_DIR: store.dir,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    ...extra,
  }
}
