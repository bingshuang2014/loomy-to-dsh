/**
 * dsh-loomy-connect version constants and bundle-version helpers.
 *
 * @module dsh-loomy-connect/version
 */

import { dirname, join } from 'node:path'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** The plugin's own version, mirrored from package.json. */
export const LOOMY_CONNECT_VERSION = '0.1.0'

/** Stable provider id the plugin owns in the DSH model registry. */
export const LOOMY_PROVIDER = 'loomy'

/** Display name for the provider group in the DSH model picker. */
export const LOOMY_DISPLAY_NAME = 'Loomy'

/** Upstream provider id inside Loomy's opencode config (OpenAI-compatible). */
export const LOOMY_IMODEL_PROVIDER = 'imodel'

/** Environment variable that overrides the upstream base URL. */
export const LOOMY_BASE_URL_ENV = 'LOOMY_BASE_URL'

/** Default upstream base URL. */
export const DEFAULT_LOOMY_BASE_URL = 'https://loomyad.xunfei.cn/api/v1'

/** Stream idle ceiling for one outstanding provider stream, in ms. */
export const LOOMY_STREAM_IDLE_TIMEOUT_MS = 300_000

/**
 * Read the host bundle version from the package.json that sits next to the
 * module that called in. A link-installed plugin resolves its imports from
 * the profile's node_modules, so reporting the version it was actually built
 * from is the only honest answer. Empty string when it cannot be read.
 */
export function readBundleVersion(importMetaUrl) {
  try {
    const dir = dirname(fileURLToPath(importMetaUrl))
    const body = readFileSync(join(dir, 'package.json'), 'utf8')
    const parsed = JSON.parse(body)
    return typeof parsed.version === 'string' ? parsed.version : ''
  } catch {
    return ''
  }
}
