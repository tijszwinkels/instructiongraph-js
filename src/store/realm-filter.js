/**
 * Realm visibility checker for client-side filtering.
 *
 * Determines whether an object should be visible to a given identity
 * based on its realm membership (`item.in`).
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Well-known realm for local-only objects. Objects in this realm are never
 * pushed to a remote hub, even when authenticated. They live on the local
 * filesystem only.
 */
export const LOCAL_REALM = 'local'

/**
 * Load cached shared realm memberships from disk.
 *
 * @param {string} configDir - The .instructionGraph directory
 * @returns {{ pubkey: string, realms: string[], fetched_at: string } | null}
 */
export function loadSharedRealms(configDir) {
  try {
    const srPath = join(configDir, 'config', 'shared-realms.json')
    if (!existsSync(srPath)) return null
    return JSON.parse(readFileSync(srPath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Check if an object is visible to the given identity + realm memberships.
 *
 * @param {object} obj - Envelope with obj.item.in
 * @param {string} activePubkey - The active identity's pubkey
 * @param {string[]} sharedRealms - Shared realms this identity belongs to
 * @returns {boolean}
 */
export function isVisible(obj, activePubkey, sharedRealms) {
  const realms = obj?.item?.in
  if (!Array.isArray(realms) || realms.length === 0) return false

  for (const r of realms) {
    if (r === 'dataverse001') return true
    if (r === LOCAL_REALM) return true
    if (r === activePubkey) return true
    if (sharedRealms.includes(r)) return true
  }
  return false
}
