/**
 * Per-account model-visibility preferences: which Loomy models the user has
 * hidden from the picker. One JSON file, keyed by account (the stable userid).
 *
 * Preferences are keyed by account so one account's hidden list never answers
 * for another: a signed-out or uid-less session has no account key, and the
 * store then refuses to read or write rather than sharing one bucket.
 *
 * @module loomy-to-dsh/visibility
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Resolve the DSH home directory: env, then the well-known default. */
export function resolveDshHome() {
  const fromEnv = (process.env['DSH_HOME'] || '').trim()
  if (fromEnv !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** Default file name for the visibility store, under the DSH home. */
export const VISIBILITY_FILENAME = '.loomy-visibility.json'

/** Default path for the visibility store. */
export function loomyVisibilityPath(filename = VISIBILITY_FILENAME) {
  return join(resolveDshHome(), filename)
}

/**
 * One per-account hidden-model set, persisted as JSON.
 *
 * Shape on disk:
 *
 *   { "accounts": { "<userid>": { "disabled": ["model-id", ...] } } }
 */
export class LoomyVisibilityStore {
  constructor(path = loomyVisibilityPath()) {
    this.path = path
  }

  /** Read one account's disabled model ids (empty when none). */
  disabled(account) {
    if (account === undefined || account === '') return []
    const parsed = this.read()
    const list = parsed?.accounts?.[account]?.disabled
    return Array.isArray(list) ? list.filter((id) => typeof id === 'string' && id !== '') : []
  }

  /** Set one model's visibility for one account. Returns true on success. */
  setVisible(account, modelId, visible) {
    if (account === undefined || account === '') return false
    if (typeof modelId !== 'string' || modelId === '') return false
    const parsed = this.read()
    const accounts = parsed?.accounts ?? {}
    const current = Array.isArray(accounts[account]?.disabled) ? accounts[account].disabled : []
    const next = visible ? current.filter((id) => id !== modelId) : current.includes(modelId) ? current : [...current, modelId]
    return this.write({ accounts: { ...accounts, [account]: { disabled: next } } })
  }

  /** Read the whole store, or an empty object. */
  read() {
    try {
      const body = readFileSync(this.path, 'utf8')
      const parsed = JSON.parse(body)
      return parsed !== null && typeof parsed === 'object' ? parsed : {}
    } catch {
      return {}
    }
  }

  /** Atomically write the whole store. Returns true on success. */
  write(parsed) {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(parsed, null, 2))
      renameSync(tmp, this.path)
      return true
    } catch {
      return false
    }
  }
}
