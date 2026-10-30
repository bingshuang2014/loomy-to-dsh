/**
 * Loomy session store: discover the desktop app's on-disk sign-in and read the
 * upstream configuration next to it.
 *
 * Loomy stores its login as a plaintext JSON file (unlike WorkBuddy, whose
 * credentials are sealed), so this plugin reads it directly and never starts
 * its own auth flow. The session token is the *only* credential the plugin
 * ever needs: it authenticates every request to the upstream as the
 * signed-in user.
 *
 * Layout observed on Windows (Loomy 0.9.38):
 *
 *   C:\Users\Public\Loomy\<profile-hash>\userData\auth-session.json
 *   C:\Users\Public\Loomy\<profile-hash>\opencode\opencode.json
 *   C:\Users\Public\Loomy\<profile-hash>\opencode\last-app-version.txt
 *
 * `auth-session.json` shape:
 *
 *   { "session": "f226…", "userid": "…", "updatedAt": 1792558303462, "phone": "…" }
 *
 * @module loomy-to-dsh/session
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { LOOMY_IMODEL_PROVIDER } from './version.js'

/** File name of Loomy's on-disk login, relative to its userData directory. */
export const LOOMY_SESSION_FILENAME = 'auth-session.json'

/** Directory that holds userData, relative to the profile root. */
export const LOOMY_USER_DATA_DIRNAME = 'userData'

/** Directory that holds opencode's config, relative to the profile root. */
export const LOOMY_OPENCODE_DIRNAME = 'opencode'

/** File name of Loomy's opencode config. */
export const LOOMY_CONFIG_FILENAME = 'opencode.json'

/** File names that carry the Loomy app version, most reliable first. */
export const LOOMY_APP_VERSION_FILENAMES = ['last-app-version.txt', '.loomy-runtime-version']

/** Environment variable that pins the userData directory. */
export const LOOMY_USER_DATA_ENV = 'LOOMY_USER_DATA'

/** Environment variable that pins the profile root (parent of userData). */
export const LOOMY_HOME_ENV = 'LOOMY_HOME'

/** Environment variable that pins the app-version string. */
export const LOOMY_VERSION_ENV = 'LOOMY_VERSION'

/** Candidate Loomy profile roots on Windows, most specific first. */
function windowsCandidateRoots() {
  const publicDir = process.env['PUBLIC'] || 'C:\\Users\\Public'
  return [
    join(publicDir, 'Loomy'),
    ...(process.env['LOCALAPPDATA'] ? [join(process.env['LOCALAPPDATA'], 'Loomy')] : []),
    ...(process.env['APPDATA'] ? [join(process.env['APPDATA'], 'Loomy')] : []),
    join(homedir(), 'Loomy'),
  ]
}

/** Candidate Loomy profile roots on POSIX. */
function posixCandidateRoots() {
  const home = homedir()
  const xdgData = process.env['XDG_DATA_HOME'] || join(home, '.local', 'share')
  const xdgConfig = process.env['XDG_CONFIG_HOME'] || join(home, '.config')
  return [
    join(xdgData, 'loomy'),
    join(xdgConfig, 'loomy'),
    join(home, 'Loomy'),
  ]
}

/** All candidate profile roots for the current platform. */
export function candidateProfileRoots() {
  return process.platform === 'win32' ? windowsCandidateRoots() : posixCandidateRoots()
}

/** Read a small file as trimmed text, or undefined when absent/unreadable. */
function readTextFile(file) {
  try {
    if (!existsSync(file)) return undefined
    const body = readFileSync(file, 'utf8').trim()
    return body === '' ? undefined : body
  } catch {
    return undefined
  }
}

/** Read a JSON object from a small file, or undefined when absent/unreadable. */
function readJsonFile(file) {
  const body = readTextFile(file)
  if (body === undefined) return undefined
  try {
    const parsed = JSON.parse(body)
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Whether `dir` looks like a Loomy profile root (carries a userData dir). */
function looksLikeProfileRoot(dir) {
  return typeof dir === 'string' && dir.length > 0 && existsSync(join(dir, LOOMY_USER_DATA_DIRNAME))
}

/**
 * Resolve the Loomy profile root.
 *
 * An explicit pin wins (`LOOMY_HOME`, then the config's `homeDir` /
 * `userDataDir`). Otherwise every candidate root is probed, and a root that
 * holds a `<hash>\userData` child is walked into: Loomy namespaces its
 * profiles by a per-machine hash, so the child lookup is the portable half of
 * discovery.
 *
 * @returns the absolute profile root, or undefined when nothing matched.
 */
export function resolveProfileRoot({ homeDir, userDataDir } = {}) {
  const pins = [
    process.env[LOOMY_HOME_ENV],
    homeDir,
    process.env[LOOMY_USER_DATA_ENV],
    userDataDir,
  ]
  for (const pin of pins) {
    if (typeof pin !== 'string' || pin.trim() === '') continue
    const absolute = resolve(pin.trim())
    if (looksLikeProfileRoot(absolute)) return absolute
    // A pin pointing straight at userData: its parent is the profile root.
    if (existsSync(join(absolute, LOOMY_SESSION_FILENAME))) return dirname(absolute)
  }
  for (const root of candidateProfileRoots()) {
    if (looksLikeProfileRoot(root)) return root
    let entries = []
    try {
      entries = readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    const children = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => join(root, entry.name))
      .filter(looksLikeProfileRoot)
    if (children.length === 1) return children[0]
  }
  return undefined
}

/**
 * Parse one auth-session.json body into a normalised session, or undefined when
 * it carries no usable token.
 *
 * `session` is the only required field. `userid`, `phone` and `updatedAt` are
 * advisory: the plugin keys per-account preferences by userid but degrades to a
 * single bucket when it is absent, and `updatedAt` is reported only.
 */
export function parseLoomySession(body) {
  if (body === null || typeof body !== 'object') return undefined
  const session = String(body.session ?? '').trim()
  if (session === '') return undefined
  const userid = typeof body.userid === 'string' ? body.userid.trim() : ''
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  const updatedAt = Number(body.updatedAt)
  return {
    session,
    userid,
    phone,
    ...(Number.isFinite(updatedAt) && updatedAt > 0 ? { updatedAt } : {}),
  }
}

/**
 * Mask a session token for logs and status payloads. The full value is only
 * ever placed into an HTTP header; it never belongs in a written file or a
 * browser-visible document.
 */
export function maskSession(session) {
  const value = String(session ?? '')
  if (value.length === 0) return ''
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}…${value.slice(-3)}`
}

/**
 * The stable account key per-account stores are keyed by: userid when
 * present, otherwise undefined (the caller then refuses to key anything by
 * account, rather than silently sharing one bucket between accounts).
 */
export function accountKeyOf(session) {
  if (session === undefined || session.userid === '') return undefined
  return session.userid
}

/**
 * Read the profile's upstream base URL from opencode.json.
 *
 * Falls back to the well-known default rather than failing: a config without a
 * provider block (a fresh install before the first login) must not disable a
 * plugin whose session file is otherwise perfectly usable.
 */
export function readBaseUrl(root, fallback) {
  if (root === undefined) return fallback
  const config = readJsonFile(join(root, LOOMY_OPENCODE_DIRNAME, LOOMY_CONFIG_FILENAME))
  const options = config?.provider?.[LOOMY_IMODEL_PROVIDER]?.options
  const baseUrl = typeof options?.baseURL === 'string' ? options.baseURL.trim() : ''
  if (baseUrl === '') return fallback
  return baseUrl.replace(/\/+$/, '')
}

/** Read the Loomy app version, most reliable source first. */
export function readAppVersion(root, versionEnv) {
  const fromEnv = typeof versionEnv === 'string' ? versionEnv.trim() : ''
  if (fromEnv !== '') return fromEnv
  if (root === undefined) return ''
  for (const name of LOOMY_APP_VERSION_FILENAMES) {
    const value = readTextFile(join(root, LOOMY_OPENCODE_DIRNAME, name))
    if (value !== undefined && /^\d+\.\d+\.\d+/.test(value)) return value.split(/\s+/)[0]
  }
  return ''
}

/**
 * One read of the session + config pair from a resolved profile root.
 *
 * Returns `found: false` rather than throwing when the login is absent: a
 * signed-out machine is a normal state, not an error. The store's poll loop
 * reports that state to the UI instead of crashing the plugin.
 */
export function readSession(root, { baseUrlFallback, versionEnv } = {}) {
  if (root === undefined) return { found: false, reason: 'profile-root-not-found' }
  const body = readJsonFile(join(root, LOOMY_USER_DATA_DIRNAME, LOOMY_SESSION_FILENAME))
  if (body === undefined) return { found: false, reason: 'no-session-file' }
  const session = parseLoomySession(body)
  if (session === undefined) return { found: false, reason: 'empty-session' }
  return {
    found: true,
    session,
    baseUrl: readBaseUrl(root, baseUrlFallback),
    appVersion: readAppVersion(root, versionEnv),
    sessionPath: join(root, LOOMY_USER_DATA_DIRNAME, LOOMY_SESSION_FILENAME),
  }
}

/** Hash of the session file, for change detection without diffing. */
export function sessionFingerprint(root) {
  try {
    const body = readFileSync(join(root, LOOMY_USER_DATA_DIRNAME, LOOMY_SESSION_FILENAME))
    return createHash('sha256').update(body).digest('hex').slice(0, 16)
  } catch {
    return ''
  }
}

/** Mtime of the session file, for cheap change detection. */
export function sessionMtimeMs(root) {
  try {
    return statSync(join(root, LOOMY_USER_DATA_DIRNAME, LOOMY_SESSION_FILENAME)).mtimeMs
  } catch {
    return 0
  }
}
