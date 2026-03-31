/**
 * Bootstrap a new InstructionGraph data store with the root node.
 *
 * On first setup, copies the bundled root node into data/ and then
 * attempts to fetch a fresher version from the default hub.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJSON } from './canonical.js'

const ROOT_REF = 'AxyU5_5vWmP2tO_klN4UpbZzRsuJEvJTrdwdg_gODxZJ.00000000-0000-0000-0000-000000000000'
const DEFAULT_HUB = 'https://dataverse001.net'

const __dirname = dirname(fileURLToPath(import.meta.url))
const BUNDLED_ROOT_PATH = join(__dirname, 'data', `${ROOT_REF}.json`)

/**
 * Bootstrap the root node into a data directory.
 * 1. Writes the bundled root node if not already present (or bundled is newer)
 * 2. Tries to fetch a fresher version from the hub
 *
 * @param {string} dataDir - Path to the data/ directory
 * @param {string} [hubUrl] - Hub URL to fetch from (default: https://dataverse001.net)
 */
export async function bootstrapRootNode(dataDir, hubUrl) {
  const targetPath = join(dataDir, `${ROOT_REF}.json`)

  // Step 1: Write bundled root node
  const bundled = JSON.parse(readFileSync(BUNDLED_ROOT_PATH, 'utf-8'))
  const bundledRev = bundled.item?.revision || 0

  if (existsSync(targetPath)) {
    try {
      const existing = JSON.parse(readFileSync(targetPath, 'utf-8'))
      if ((existing.item?.revision || 0) >= bundledRev) return // already up to date
    } catch { /* corrupt file, overwrite */ }
  }

  writeFileSync(targetPath, canonicalJSON(bundled) + '\n')

  // Step 2: Try to fetch a fresher version from the hub
  const url = hubUrl || DEFAULT_HUB
  try {
    const resp = await fetch(`${url}/${ROOT_REF}`, { signal: AbortSignal.timeout(5000) })
    if (resp.ok) {
      const remote = await resp.json()
      const remoteRev = remote.item?.revision || 0
      if (remoteRev > bundledRev) {
        writeFileSync(targetPath, canonicalJSON(remote) + '\n')
      }
    }
  } catch { /* offline or hub unreachable — bundled version is fine */ }
}
