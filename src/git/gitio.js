/**
 * Node-only git I/O for the remote helper: write loose objects the local git
 * accepts, and read local objects/reachability via git plumbing (so we never
 * have to parse packfiles — git does that for us).
 *
 * All reads go through the `git` binary against an explicit GIT_DIR; all writes
 * are loose objects reconstructed from the authoritative payload.
 */

import { execFileSync } from 'node:child_process'
import { deflateSync } from 'node:zlib'
import { writeFileSync, renameSync, mkdirSync, existsSync, chmodSync } from 'node:fs'
import { join, dirname } from 'node:path'

let tmpCounter = 0

/** Loose object path: <gitDir>/objects/<oid[0:2]>/<oid[2:]>. */
export function looseObjectPath(gitDir, oid) {
  return join(gitDir, 'objects', oid.slice(0, 2), oid.slice(2))
}

/**
 * Write a git object to the loose object store. Idempotent: if the object is
 * already present it is left untouched (git makes loose objects read-only).
 * @param {string} gitDir
 * @param {string} oid - the object's git oid (path + integrity are derived from it)
 * @param {string} otype - commit|tree|blob|tag
 * @param {Uint8Array} payload - object payload WITHOUT the git header
 */
export function writeLooseObject(gitDir, oid, otype, payload) {
  const path = looseObjectPath(gitDir, oid)
  if (existsSync(path)) return
  const header = Buffer.from(`${otype} ${payload.length}\0`, 'latin1')
  const store = Buffer.concat([header, Buffer.from(payload)])
  const compressed = deflateSync(store)
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${tmpCounter++}`
  writeFileSync(tmp, compressed)
  try {
    renameSync(tmp, path)
  } catch (e) {
    // lost a race with a concurrent writer — the object is content-addressed,
    // so whoever won wrote identical bytes; drop our temp and move on.
    if (existsSync(path)) { try { chmodSync(tmp, 0o600) } catch {}; return }
    throw e
  }
  try { chmodSync(path, 0o444) } catch { /* best effort */ }
}

/** Run a git plumbing command against an explicit GIT_DIR. */
export function runGit(gitDir, args, { input, maxBuffer = 256 * 1024 * 1024 } = {}) {
  return execFileSync('git', args, {
    // GIT_NO_REPLACE_OBJECTS: read the TRUE objects, never `git replace`
    // substitutes — otherwise cat-file would hand back a different payload than
    // the oid we address it by (silent corruption / spurious oid drift).
    env: { ...process.env, GIT_DIR: gitDir, GIT_NO_REPLACE_OBJECTS: '1' },
    input,
    maxBuffer,
  })
}

/** The repository's object format ('sha1' | 'sha256'). */
export function objectFormat(gitDir) {
  return runGit(gitDir, ['rev-parse', '--show-object-format']).toString('utf-8').trim()
}

/** True if this is a shallow clone (history is truncated). */
export function isShallow(gitDir) {
  return runGit(gitDir, ['rev-parse', '--is-shallow-repository']).toString('utf-8').trim() === 'true'
}

/**
 * Read many objects at once via `git cat-file --batch`.
 * @returns {Map<string,{type:string,size:number,payload:Buffer}>} keyed by oid (missing oids omitted)
 */
export function catFileBatch(gitDir, oids) {
  const out = new Map()
  if (!oids.length) return out
  const buf = runGit(gitDir, ['cat-file', '--batch'], { input: oids.join('\n') + '\n' })
  let pos = 0
  while (pos < buf.length) {
    let nl = buf.indexOf(0x0a, pos)
    if (nl === -1) break
    const header = buf.toString('utf-8', pos, nl)
    pos = nl + 1
    const parts = header.split(' ')
    if (parts[1] === 'missing') continue
    const [oid, type, sizeStr] = parts
    const size = Number(sizeStr)
    const payload = buf.subarray(pos, pos + size)
    out.set(oid, { type, size, payload: Buffer.from(payload) })
    pos += size + 1 // skip payload + trailing newline
  }
  return out
}

/** Read a single object's payload. */
export function catFile(gitDir, otype, oid) {
  return runGit(gitDir, ['cat-file', otype, oid])
}

/** Object type word (commit|tree|blob|tag). */
export function catFileType(gitDir, oid) {
  return runGit(gitDir, ['cat-file', '-t', oid]).toString('utf-8').trim()
}

/** Resolve a revision to an oid; throws if it does not resolve. */
export function revParse(gitDir, rev) {
  return runGit(gitDir, ['rev-parse', '--verify', '--end-of-options', rev]).toString('utf-8').trim()
}

/**
 * All object oids reachable from `tip`, optionally excluding everything
 * reachable from `notTips` (for incremental push).
 * @returns {string[]}
 */
export function revListObjects(gitDir, tip, notTips = []) {
  const args = ['rev-list', '--objects', tip, ...notTips.map(t => `^${t}`)]
  const text = runGit(gitDir, args).toString('utf-8')
  const oids = []
  for (const line of text.split('\n')) {
    if (!line) continue
    const sp = line.indexOf(' ')
    oids.push(sp === -1 ? line : line.slice(0, sp))
  }
  return oids
}

/** True if `ancestor` is an ancestor of `descendant`. */
export function isAncestor(gitDir, ancestor, descendant) {
  try {
    runGit(gitDir, ['merge-base', '--is-ancestor', ancestor, descendant])
    return true
  } catch (e) {
    if (e.status === 1) return false
    throw e
  }
}

/** True if the object exists in the local store. */
export function objectExists(gitDir, oid) {
  try {
    runGit(gitDir, ['cat-file', '-e', oid])
    return true
  } catch {
    return false
  }
}

/** Resolve the effective GIT_DIR (env, else ask git). */
export function resolveGitDir(cwd = process.cwd()) {
  if (process.env.GIT_DIR) return process.env.GIT_DIR
  return execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd }).toString('utf-8').trim()
}
