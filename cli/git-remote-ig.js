#!/usr/bin/env node

/**
 * git-remote-ig — a git remote helper for repositories hosted on
 * instructionGraph. Invoked by git for URLs of the form `ig::<repo-ref>`:
 *
 *   git clone ig::<owner>.<uuid>
 *   git remote add origin ig::<owner>.<uuid> && git push -u origin main
 *
 * Implements the gitremote-helpers(7) capabilities list/fetch/push over LOOSE
 * objects only (no packfiles). Objects are read from / signed into the user's
 * local .instructionGraph store (and synced to the hub when configured) exactly
 * the way the ig CLI resolves config and identity.
 *
 * Protocol I/O is on stdin/stdout; everything else (logs, errors) goes to
 * stderr. See the git-hosting section of the README for the model.
 */

import { createInterface } from 'node:readline'
import { basename } from 'node:path'

import { openRuntime, findConfigDir, resolveIdentityConfig, readConfig } from './runtime.js'
import { openRepo, initRepo } from '../src/git/repo.js'
import { parseRef } from '../src/object.js'
import { resolveGitDir } from '../src/git/gitio.js'
import { fetchToLocal, pushToRemote } from '../src/git/transfer.js'

// argv: [node, script, <arg1>, <arg2>]. For `ig::<ref>` git passes the address
// (and, for a configured remote, its name first). Prefer the URL arg; strip the
// transport prefix if present.
const urlArg = process.argv[3] || process.argv[2] || ''
const repoRef = urlArg.replace(/^ig::/, '').replace(/^ig:\/\//, '')

let verbosity = 1
const out = (s) => process.stdout.write(s)
const log = (s) => { if (verbosity >= 1) process.stderr.write(`git-remote-ig: ${s}\n`) }

if (!repoRef || repoRef.indexOf('.') === -1) {
  process.stderr.write(`git-remote-ig: invalid repository ref "${urlArg}" (expected ig::<owner>.<uuid>)\n`)
  process.exit(1)
}

// ─── Lazy runtime + repository ────────────────────────────────────

let _runtime = null
async function runtime() {
  if (_runtime) return _runtime
  const configDir = findConfigDir()
  const hasIdentity = !!resolveIdentityConfig(configDir)
  _runtime = await openRuntime({ authenticate: hasIdentity })
  return _runtime
}

let _repo = null
async function getRepo({ createIfMissing = false } = {}) {
  if (_repo) return _repo
  const { client } = await runtime()
  try {
    _repo = await openRepo({ client, repoRef })
    return _repo
  } catch (e) {
    if (!createIfMissing) return null
    const { pubkey: owner, id } = parseRef(repoRef)
    if (owner !== client.pubkey) {
      throw new Error(`cannot create a repository in another identity's namespace (${owner}); active identity is ${client.pubkey}`)
    }
    // New repositories default to the caller's configured default realm, else
    // the private identity realm. Override with IG_GIT_REALM.
    const configDir = findConfigDir()
    const realm = process.env.IG_GIT_REALM || readConfig(configDir, 'default-realm', owner)
    log(`creating repository ${repoRef} in realm ${realm}`)
    await initRepo({ client, id, name: basename(process.cwd()) || 'repo', format: 'sha1', in: [realm], defaultBranch: 'refs/heads/main' })
    _repo = await openRepo({ client, repoRef })
    return _repo
  }
}

// ─── Protocol handlers ────────────────────────────────────────────

function doCapabilities() {
  out('fetch\n')
  out('push\n')
  out('option\n')
  out('\n')
}

function doOption(line) {
  const rest = line.slice('option '.length)
  const sp = rest.indexOf(' ')
  const name = sp === -1 ? rest : rest.slice(0, sp)
  const value = sp === -1 ? '' : rest.slice(sp + 1)
  if (name === 'verbosity') { verbosity = Number(value) || 0; out('ok\n') }
  else if (name === 'progress') { out('ok\n') }
  else out('unsupported\n')
}

async function doList() {
  const repo = await getRepo()
  if (!repo) { out('\n'); return } // unknown/empty repository → no refs
  const refs = await repo.listRefs()
  let head = null
  for (const r of refs) {
    if (r.refname === 'HEAD') { head = r; continue }
    if (r.targetOid) out(`${r.targetOid} ${r.refname}\n`)
  }
  const symTarget = head?.symrefTarget || repo.content?.default_branch
  if (symTarget) out(`@${symTarget} HEAD\n`)
  out('\n')
}

async function doFetch(firstLine, reader) {
  const wants = []
  let line = firstLine
  while (line !== null && line !== '') {
    if (line.startsWith('fetch ')) wants.push(line.split(' ')[1])
    line = await reader.next()
  }
  const repo = await getRepo()
  if (!repo) throw new Error(`repository not found: ${repoRef}`)
  const n = await fetchToLocal({ repo, gitDir: resolveGitDir(), wants })
  log(`fetched ${n} object(s)`)
  out('\n')
}

function parsePush(line) {
  let spec = line.slice('push '.length)
  const force = spec[0] === '+'
  if (force) spec = spec.slice(1)
  const colon = spec.indexOf(':')
  const src = colon === -1 ? spec : spec.slice(0, colon)
  const dst = colon === -1 ? spec : spec.slice(colon + 1)
  return { src, dst, force }
}

async function doPush(firstLine, reader) {
  const pushes = []
  let line = firstLine
  while (line !== null && line !== '') {
    if (line.startsWith('push ')) pushes.push(parsePush(line))
    line = await reader.next()
  }
  const repo = await getRepo({ createIfMissing: true })
  const results = await pushToRemote({ repo, gitDir: resolveGitDir(), pushes })
  for (const r of results) out(r.ok ? `ok ${r.dst}\n` : `error ${r.dst} ${r.error}\n`)
  out('\n')
}

// ─── stdin line reader (pull-based) ───────────────────────────────

function createLineReader(stream) {
  const rl = createInterface({ input: stream })
  const queue = []
  let waiting = null
  let closed = false
  rl.on('line', (l) => { if (waiting) { const w = waiting; waiting = null; w(l) } else queue.push(l) })
  rl.on('close', () => { closed = true; if (waiting) { const w = waiting; waiting = null; w(null) } })
  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift())
      if (closed) return Promise.resolve(null)
      return new Promise((res) => { waiting = res })
    },
  }
}

// ─── Main command loop ────────────────────────────────────────────

async function main() {
  const reader = createLineReader(process.stdin)
  for (;;) {
    const line = await reader.next()
    if (line === null || line === '') break // blank line / EOF ends the command stream
    if (line === 'capabilities') doCapabilities()
    else if (line === 'list' || line === 'list for-push') await doList()
    else if (line.startsWith('option ')) doOption(line)
    else if (line.startsWith('fetch ')) await doFetch(line, reader)
    else if (line.startsWith('push ')) await doPush(line, reader)
    else log(`ignoring unknown command: ${line}`)
  }
}

main().catch((e) => {
  process.stderr.write(`git-remote-ig: ${e.message}\n`)
  process.exit(1)
})
