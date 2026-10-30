/**
 * The loomyad.xunfei.cn client: header construction, the model directory, and
 * chat completions.
 *
 * Everything here was pinned down by live probing against a real signed-in
 * account, because Loomy's own source comments are misleading about which
 * headers matter. The measured facts, in priority order:
 *
 * 1. `Authorization: Bearer <session>` is the only header that is actually
 *    mandatory for authentication. The `token` header works too, and sending
 *    both (as Loomy does) is safe, so this plugin sends both.
 * 2. **`TurnId` is mandatory for chat completions.** A request carrying
 *    `ChatId` and `MsgId` but no `TurnId` is rejected with
 *    `400 invalid_request_error 请求参数错误` — and the failure is fast, so it
 *    looks like a body problem. This is the one trap worth remembering.
 * 3. `traceparent` is NOT mandatory. Loomy's source claims chat/completions
 *    "挂死直到超时" without it; a probe without it returned 200 in 1.2s. The
 *    plugin still sends it, because it is free and may matter for other routes.
 *
 * @module dsh-loomy-connect/upstream
 */

import { randomBytes } from 'node:crypto'
import { LOOMY_IMODEL_PROVIDER, DEFAULT_LOOMY_BASE_URL, LOOMY_BASE_URL_ENV } from './version.js'
import { parseLoomyCatalogResponse } from './catalog.js'

/** The request purpose used for chat traffic. */
export const LOOMY_PURPOSE_CHAT = 'chat.message'

/** The invoke origin Loomy's own desktop client sends. */
export const LOOMY_INVOKE_ORIGIN = 'user'

/** The upstream header name carrying the Loomy app version. */
export const LOOMY_VERSION_HEADER = 'loomy-version'

/** Default timeout for the model directory fetch, in ms. */
export const MODELS_TIMEOUT_MS = 15_000

/** Default timeout for one chat completion, in ms. */
export const CHAT_TIMEOUT_MS = 300_000

/** The `loomy-version` used when the profile does not carry one. */
export const FALLBACK_LOOMY_VERSION = '0.9.38'

/**
 * A W3C traceparent, as Loomy generates one: `00-<32 hex>-<16 hex>-01`.
 * The upstream accepts the shape rather than the values.
 */
export function generateTraceparent() {
  return `00-${randomBytes(16).toString('hex')}-${randomBytes(8).toString('hex')}-01`
}

/** A fresh chat/turn identifier set for one request. */
export function generateRequestIds() {
  const hex = () => randomBytes(16).toString('hex')
  const msgId = `msg-${hex()}`
  return {
    chatId: `chat-${hex()}`,
    msgId,
    // TurnId echoes a real turn id. Reusing msgId is what the Loomy client
    // does when it has no separate turn id, and it is the combination that
    // passes upstream validation.
    turnId: msgId,
  }
}

/**
 * Build the full loomyad header set for one chat completion.
 *
 * Every key is included unconditionally: the measured cost of an extra header
 * is zero, and omitting `TurnId` is the one combination that fails. Callers
 * that only need the directory subset should use {@link directoryHeaders}.
 */
export function buildLoomyHeaders({ session, loomyVersion, ids, purpose = LOOMY_PURPOSE_CHAT, invokeOrigin = LOOMY_INVOKE_ORIGIN } = {}) {
  const token = String(session ?? '').trim()
  if (token === '') return undefined
  const requestIds = ids ?? generateRequestIds()
  const version = String(loomyVersion ?? '').trim() !== '' ? String(loomyVersion).trim() : FALLBACK_LOOMY_VERSION
  const headers = {
    token,
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    traceparent: requestIds.traceparent ?? generateTraceparent(),
    [LOOMY_VERSION_HEADER]: version,
    ChatId: requestIds.chatId,
    MsgId: requestIds.msgId,
    TurnId: requestIds.turnId,
    InvokeOrigin: invokeOrigin,
    'X-Loomy-Request-Purpose': purpose,
  }
  return headers
}

/** The reduced header set the model directory needs. */
export function directoryHeaders(session) {
  const token = String(session ?? '').trim()
  if (token === '') return undefined
  return {
    token,
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    traceparent: generateTraceparent(),
    [LOOMY_VERSION_HEADER]: FALLBACK_LOOMY_VERSION,
  }
}

/** Resolve the effective upstream base URL. */
export function resolveBaseUrl({ baseUrl, env } = {}) {
  const candidates = [baseUrl, env, process.env[LOOMY_BASE_URL_ENV], DEFAULT_LOOMY_BASE_URL]
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate.trim() : ''
    if (value === '') continue
    if (!/^https?:\/\//i.test(value)) continue
    return value.replace(/\/+$/, '')
  }
  return DEFAULT_LOOMY_BASE_URL
}

/**
 * Error classes the shim maps onto HTTP statuses. Kept small: the upstream
 * mostly answers 200, 400, 401/403, 429 and 5xx.
 */
export const UPSTREAM_ERROR_KINDS = {
  sessionDead: 'session_dead',
  rate: 'rate_limited',
  credit: 'out_of_credit',
  client: 'invalid_request',
  server: 'upstream_error',
  network: 'network',
  timeout: 'timeout',
}

/** Classify one upstream response into a stable error kind. */
export function classifyUpstreamError(status, body) {
  const text = String(body ?? '').toLowerCase()
  if (status === 401 || status === 403) return UPSTREAM_ERROR_KINDS.sessionDead
  if (status === 402) return UPSTREAM_ERROR_KINDS.credit
  if (status === 429) return UPSTREAM_ERROR_KINDS.rate
  if (status >= 400 && status < 500) {
    if (/credit|quota|points|余额|积分|额度/.test(text)) return UPSTREAM_ERROR_KINDS.credit
    return UPSTREAM_ERROR_KINDS.client
  }
  if (status >= 500) return UPSTREAM_ERROR_KINDS.server
  return UPSTREAM_ERROR_KINDS.server
}

/** Extract a human-readable message from the upstream's error envelope. */
export function extractErrorMessage(body) {
  if (body === undefined || body === null || body === '') return ''
  try {
    const parsed = JSON.parse(body)
    return String(parsed?.error?.message ?? parsed?.message ?? parsed?.msg ?? '').slice(0, 400)
  } catch {
    return String(body).slice(0, 400)
  }
}

/**
 * Fetch the live model directory.
 *
 * Returns `{ ok: false }` with a message rather than throwing: a network blip
 * must not take the whole provider down, and the caller falls back to the
 * saved or compiled snapshot.
 */
export async function fetchLoomyModels({ session, baseUrl, timeoutMs = MODELS_TIMEOUT_MS, signal } = {}) {
  const headers = directoryHeaders(session)
  if (headers === undefined) return { ok: false, kind: UPSTREAM_ERROR_KINDS.sessionDead, message: 'no session token' }
  const url = `${resolveBaseUrl({ baseUrl })}/models`
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: withTimeout(signal, timeoutMs),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      return {
        ok: false,
        status: response.status,
        kind: classifyUpstreamError(response.status, body),
        message: extractErrorMessage(body) || `http ${response.status}`,
      }
    }
    const parsed = await response.json().catch(() => undefined)
    if (parsed === undefined) return { ok: false, kind: UPSTREAM_ERROR_KINDS.server, message: 'unparseable model directory' }
    const models = parseLoomyCatalogResponse(parsed)
    if (models.length === 0) return { ok: false, kind: UPSTREAM_ERROR_KINDS.server, message: 'model directory returned no chat models' }
    return { ok: true, models, raw: parsed }
  } catch (error) {
    if (isAbort(error)) return { ok: false, kind: UPSTREAM_ERROR_KINDS.timeout, message: 'timed out' }
    return { ok: false, kind: UPSTREAM_ERROR_KINDS.network, message: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Send one chat completion and return the raw response for the caller to pipe.
 *
 * The plugin never rewrites the response body. The upstream answers with
 * standard OpenAI chat completions — non-streaming `{choices:[{message}]}` and
 * streaming `chat.completion.chunk` frames — so the loopback shim can pass
 * bytes through untouched and let pi-ai's own OpenAI decoder do the work.
 *
 * Returns `{ ok: false }` with a classified kind on failure. On success the
 * `response` is still open and must be consumed or closed by the caller.
 */
export async function chatCompletion({
  session,
  baseUrl,
  body,
  signal,
  loomyVersion,
  purpose = LOOMY_PURPOSE_CHAT,
  timeoutMs = CHAT_TIMEOUT_MS,
} = {}) {
  const headers = buildLoomyHeaders({ session, loomyVersion, purpose })
  if (headers === undefined) return { ok: false, kind: UPSTREAM_ERROR_KINDS.sessionDead, message: 'no session token' }
  const url = `${resolveBaseUrl({ baseUrl })}/chat/completions`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
      signal: withTimeout(signal, timeoutMs),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return {
        ok: false,
        status: response.status,
        kind: classifyUpstreamError(response.status, text),
        message: extractErrorMessage(text) || `http ${response.status}`,
      }
    }
    return { ok: true, status: response.status, response, headers }
  } catch (error) {
    if (isAbort(error)) return { ok: false, kind: UPSTREAM_ERROR_KINDS.timeout, message: 'timed out' }
    return { ok: false, kind: UPSTREAM_ERROR_KINDS.network, message: error instanceof Error ? error.message : String(error) }
  }
}

/** Wrap an optional caller signal in a timeout that aborts it. */
function withTimeout(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (signal !== undefined) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  controller.signal.addEventListener('abort', () => clearTimeout(timer), { once: true })
  return controller.signal
}

/** Whether an error is an abort (caller cancellation or timeout). */
function isAbort(error) {
  return error !== null && typeof error === 'object' && error.name === 'AbortError'
}

/** The provider id this upstream serves, kept here for status payloads. */
export const LOOMY_IMODEL_PROVIDER_ID = LOOMY_IMODEL_PROVIDER
