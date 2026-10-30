/**
 * The Loomy model catalog: the parsed upstream directory plus the in-memory
 * roster the provider advertises to DSH.
 *
 * `GET {baseURL}/models` answers with the live directory:
 *
 *   { "object": "list", "reasoning_enabled": true,
 *     "data": [ { "id", "name", "type", "protocol", "context_length",
 *                 "max_output_tokens", "reasoning_efforts",
 *                 "capabilities": { "reasoning", "vision", "function_calling",
 *                                   "streaming", "input_modalities",
 *                                   "output_modalities" },
 *                 "is_default_model" } ] }
 *
 * Two model kinds come back. `type: "image"` rows are image *generation*
 * models (Hy-Image, seedream, qwen-image); they answer a different API shape
 * and are dropped here — DSH models on this provider must be chat models.
 * The `auto` row has no limits and is a routing hint, not a selectable model.
 *
 * @module dsh-loomy-connect/catalog
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Chat models are the only selectable kind on this provider. */
const CHAT_TYPE = 'chat'

/** Default context window when the directory omits one. */
const DEFAULT_CONTEXT_WINDOW = 128_000

/** Default output ceiling when the directory omits one. */
const DEFAULT_MAX_OUTPUT = 8_192

/** Matches the billing-rate suffix Loomy appends: `(x2.0)`, `（x4.0）`. */
const RATE_SUFFIX_RE = /[（(]\s*x\s*([\d.]+)\s*[)）]\s*$/i

/** Promotional badge phrases Loomy folds into a model name. Bare `免费` is
 *  omitted because it is a substring of `限时免费` and would double-match. */
const BADGE_PHRASES = ['限时免费', '限时优惠', '新用户免费']

/**
 * A parsed catalog row, ready for the adapter to turn into a pi-ai model.
 *
 * Field notes:
 * - `rate` is the billing multiplier (`x2.0`), display-only. It never affects
 *   routing: DSH routes on `id`.
 * - `reasoning.supportedEfforts` excludes `"none"`, which the upstream uses to
 *   mean "thinking off". That value is surfaced separately by the adapter as
 *   pi-ai's `off` level rather than as a selectable effort.
 */
export function parseLoomyCatalogResponse(body) {
  const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
  const models = []
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const id = typeof row.id === 'string' ? row.id.trim() : ''
    if (id === '') continue
    if (String(row.type ?? CHAT_TYPE) !== CHAT_TYPE) continue
    // A chat model with no declared context window is a routing hint (the
    // `auto` row), not a selectable model: drop it rather than serve a row
    // whose limits the picker would have to fabricate.
    const contextWindow = positiveNumber(row.context_length)
    if (contextWindow === undefined) continue
    const maxTokens = positiveNumber(row.max_output_tokens) ?? DEFAULT_MAX_OUTPUT
    const capabilities = row.capabilities ?? {}
    const inputModalities = Array.isArray(capabilities.input_modalities)
      ? capabilities.input_modalities.map((value) => String(value).toLowerCase())
      : []
    const streaming = capabilities.streaming !== false
    if (!streaming) continue
    const effortList = Array.isArray(row.reasoning_efforts)
      ? row.reasoning_efforts.map((value) => String(value).toLowerCase()).filter(Boolean)
      : []
    const supportedEfforts = effortList.filter((value) => value !== 'none')
    const supportsReasoning = capabilities.reasoning === true && supportedEfforts.length > 0
    const reasoning = {
      supports: supportsReasoning,
      supportedEfforts,
      ...(supportedEfforts.length > 0
        ? { defaultEffort: normalizeEffort(row.default_reasoning_effort, supportedEfforts) }
        : {}),
      canDisableThinking: effortList.includes('none'),
    }
    models.push({
      id,
      name: typeof row.name === 'string' && row.name.trim() !== '' ? row.name.trim() : id,
      contextWindow,
      maxTokens,
      supportsImages: inputModalities.includes('image'),
      supportsTools: capabilities.function_calling === true,
      reasoning,
      ...(parseRate(row.name) === undefined ? {} : { rate: parseRate(row.name) }),
      ...(badgesOf(row.name).length > 0 ? { badges: badgesOf(row.name) } : {}),
      ...(row.is_default_model === true ? { isDefault: true } : {}),
      ...(row.is_default_small_model === true ? { isDefaultSmall: true } : {}),
      ...(typeof row.protocol === 'string' ? { protocol: row.protocol } : {}),
    })
  }
  return models
}

/** A finite positive number, or undefined. */
function positiveNumber(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

/** The first supported effort matching the upstream default, else the first. */
function normalizeEffort(defaultValue, supportedEfforts) {
  const normalized = String(defaultValue ?? '').trim().toLowerCase()
  if (supportedEfforts.includes(normalized)) return normalized
  return supportedEfforts[0]
}

/** Parse `(x2.0)` / `（x4.0）` off a model name, or undefined. */
export function parseRate(name) {
  const match = RATE_SUFFIX_RE.exec(String(name ?? ''))
  if (match === null) return undefined
  const parsed = Number(match[1])
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The promotional badge phrases found in a model name. */
export function badgesOf(name) {
  const text = String(name ?? '')
  return BADGE_PHRASES.filter((phrase) => text.includes(phrase))
}

/**
 * The static roster served when the live directory is unreachable.
 *
 * Captured from a real `GET /models` response on Loomy 0.9.38. A snapshot
 * rather than "no models at all": a transient network failure should not hide
 * an entire provider group, and these rows are strictly less informative than
 * a live fetch (the live one is always preferred when it succeeds).
 *
 * `spark-x2.6-preview` in opencode.json and `spark-x2.6` in the live catalog
 * are the same model across two releases; the live id wins, the snapshot keeps
 * the id the directory actually serves.
 */
export const FALLBACK_LOOMY_MODELS = [
  {
    id: 'DeepSeek-V4.1-Flash', name: 'DeepSeek V4.1 Flash(x2.0)',
    contextWindow: 1_048_576, maxTokens: 384_000,
    supportsImages: true, supportsTools: true, rate: 2.0, isDefault: true,
    reasoning: { supports: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'low', canDisableThinking: true },
  },
  {
    id: 'MiniMax-M3', name: 'MiniMax M3（x4.0）',
    contextWindow: 1_048_576, maxTokens: 512_000,
    supportsImages: true, supportsTools: true, rate: 4.0,
    reasoning: { supports: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'low', canDisableThinking: true },
  },
  {
    id: 'Kimi-k2.6', name: 'Kimi k2.6（x6.5）',
    contextWindow: 262_144, maxTokens: 65_536,
    supportsImages: true, supportsTools: true, rate: 6.5,
    reasoning: { supports: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'low', canDisableThinking: true },
  },
  {
    id: 'qwen-3.8-max', name: 'Qwen 3.8 Max (x12.0)',
    contextWindow: 1_000_000, maxTokens: 65_536,
    supportsImages: false, supportsTools: true, rate: 12.0,
    reasoning: { supports: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'low', canDisableThinking: true },
  },
  {
    id: 'GLM-5.3-Flash', name: 'GLM 5.3 Flash(x0.8)',
    contextWindow: 1_048_576, maxTokens: 131_072,
    supportsImages: true, supportsTools: true, rate: 0.8,
    reasoning: { supports: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'low', canDisableThinking: true },
  },
  {
    id: 'qwen3.8-flash', name: 'qwen 3.8 flash（x0.8）',
    contextWindow: 1_000_000, maxTokens: 131_072,
    supportsImages: true, supportsTools: true, rate: 0.8, isDefaultSmall: true,
    reasoning: { supports: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'low', canDisableThinking: true },
  },
  {
    id: 'spark-x2.6', name: 'Spark-X2.6 正式版（限时免费）(x0.0)',
    contextWindow: 1_048_576, maxTokens: 131_072,
    supportsImages: false, supportsTools: true, rate: 0.0, badges: ['限时免费'],
    reasoning: { supports: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'low', canDisableThinking: true },
  },
  {
    id: 'spark-x', name: 'Spark-X2.5（限时免费）(x0.0)',
    contextWindow: 1_048_576, maxTokens: 65_536,
    supportsImages: false, supportsTools: true, rate: 0.0, badges: ['限时免费'],
    reasoning: { supports: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'low', canDisableThinking: true },
  },
  {
    id: 'mimo-v2.5', name: 'MiMo V2.5（x3.3）',
    contextWindow: 1_048_576, maxTokens: 131_072,
    supportsImages: true, supportsTools: true, rate: 3.3,
    reasoning: { supports: true, supportedEfforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'low', canDisableThinking: true },
  },
]

/**
 * The mutable roster the provider serves.
 *
 * Holds a single list plus a visibility flag. `setVisible(false)` is how the
 * group disappears from the picker: an empty roster means the host has nothing
 * to render, which is the correct answer while signed out.
 */
export class LoomyCatalog {
  constructor(fallback = FALLBACK_LOOMY_MODELS) {
    this.fallback = fallback
    this.models = []
    this.visible = false
    this.source = 'fallback'
    this.fetchedAt = undefined
    this.error = undefined
    this.listeners = new Set()
  }

  /** The roster currently advertised. Never throws. */
  current() {
    if (!this.visible) return []
    return this.models
  }

  /** Install a roster and notify listeners. Returns whether it changed. */
  set(models) {
    const next = models.map((model) => ({ ...model }))
    const changed = JSON.stringify(next) !== JSON.stringify(this.models)
    this.models = next
    return changed
  }

  /** Install the static snapshot (used on startup and after a failed fetch). */
  useFallback() {
    this.models = this.fallback.map((model) => ({ ...model }))
    this.source = 'fallback'
    this.fetchedAt = undefined
    return true
  }

  /** Whether the picker should show this provider at all. */
  setVisible(visible) {
    const next = Boolean(visible)
    if (next === this.visible) return false
    this.visible = next
    return true
  }

  /** Notify listeners after a mutation. */
  notify() {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A listener throwing must not break the sweep.
      }
    }
  }
}

/**
 * Persist the last good catalog so a restart serves it instead of the
 * compiled snapshot. One file per account key; an account with no key is not
 * written, mirroring the visibility store's refusal rule.
 */
export class LoomyCatalogStore {
  constructor(path) {
    this.path = path
  }

  /** Read one account's saved roster, or undefined. */
  get(account) {
    if (account === undefined || account === '') return undefined
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      const entry = parsed?.accounts?.[account]
      if (entry === undefined || !Array.isArray(entry.models)) return undefined
      return { models: entry.models, fetchedAt: entry.fetchedAt }
    } catch {
      return undefined
    }
  }

  /** Save one account's roster atomically. Returns true on success. */
  set(account, models, fetchedAt) {
    if (account === undefined || account === '') return false
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      let parsed = {}
      try {
        parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      } catch {
        parsed = {}
      }
      const next = { accounts: { ...(parsed.accounts ?? {}), [account]: { models, fetchedAt } } }
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(next, null, 2))
      renameSync(tmp, this.path)
      return true
    } catch {
      return false
    }
  }

  /** Forget one account's roster. */
  delete(account) {
    if (account === undefined || account === '') return false
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf8'))
      if (parsed?.accounts === undefined) return false
      delete parsed.accounts[account]
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, JSON.stringify(parsed, null, 2))
      renameSync(tmp, this.path)
      return true
    } catch {
      return false
    }
  }
}
