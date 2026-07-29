/**
 * The pinned contract WASMs.
 *
 * These bytes ARE the keyspace: a contract's id hashes its code, so a
 * different build of the same contract addresses a different, empty universe
 * (an existing object would silently look unpublished). They are therefore
 * pinned artifacts to be read, never rebuilt on the fly — which is why the
 * directory is configuration rather than something we go looking for.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { blake3 } from './blake3.js'

/** Contract role → file name in the contracts directory. */
export const CONTRACT_FILES = {
  object: 'dataverse_object.wasm',
  snapshot: 'dataverse_object_rev.wasm',
  index: 'dataverse_inbound_index.wasm',
}

/**
 * Read and hash the three contract WASMs.
 *
 * @param {string} contractsDir
 * @returns {{paths: Record<string,string>, codeHashes: Record<string,Uint8Array>, dir: string}}
 */
export function loadContracts(contractsDir) {
  let st
  try {
    st = statSync(contractsDir)
  } catch {
    throw new Error(
      `Freenet contracts directory does not exist: ${contractsDir}\n` +
      '  Point --contracts-dir (or the freenet-contracts-dir config key) at the\n' +
      '  directory holding the pinned contract WASMs.',
    )
  }
  if (!st.isDirectory()) throw new Error(`Freenet contracts path is not a directory: ${contractsDir}`)

  const paths = {}
  const codeHashes = {}
  for (const [role, file] of Object.entries(CONTRACT_FILES)) {
    const path = join(contractsDir, file)
    let bytes
    try {
      bytes = readFileSync(path)
    } catch {
      throw new Error(
        `Missing contract WASM: ${file}\n` +
        `  Looked in: ${contractsDir}\n` +
        `  Expected all of: ${Object.values(CONTRACT_FILES).join(', ')}`,
      )
    }
    paths[role] = path
    codeHashes[role] = blake3(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  }
  return { paths, codeHashes, dir: contractsDir }
}
