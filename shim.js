/**
 * Loopback OpenAI-compatible endpoint. The pi-ai provider points here; the
 * shim applies the Loomy wire quirks (the `token`/`TurnId`/`traceparent`/
 * `loomy-version` headers, the `chat.message` request purpose) and forwards
 * to the real upstream at loomyad.xunfei.cn.
 *
 * It binds 127.0.0.1 only and never serves another interface.
 *
 * Inbound hardening mirrors dsh-workbuddy-connect: the loopback bind alone is
 * not a trust boundary (any local process or a DNS-rebinding page can reach
 * 127.0.0.1), so every request must carry a loopback Host header, browser-sent
 * Origins must be loopback, chat POSTs must be application/json, and the
 * Authorization header must carry the shim's per-process shared secret. The
 * plugin's own client satisfies all four by construction.
 *
 * @module loomy-to-dsh/shim
 */

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { bindToUsablePort, hostIsLoopback, originIsLoopback } from './loopback.js'
import { chatCompletion, UPSTREAM_ERROR_KINDS as KIND, extractErrorMessage } from './upstream.js'

/** Minimal logger surface the plugin context already provides. */
export const SHIM_LOGGER = null

/** What the plugin needs from a running shim: { ready, baseUrl(), token(), close() }. */

/** HTTP status each upstream failure class surfaces as. */
const KIND_STATUS = {
  [KIND.sessionDead]: 401,
  [KIND.rate]: 429,
  [KIND.credit]: 402,
  [KIND.client]: 400,
  [KIND.server]: 502,
  [KIND.network]: 502,
  [KIND.timeout]: 504,
}

const REQUEST_BODY_LIMIT = 64 * 1024 * 1024

/** Chat-completion POSTs must carry a JSON body type. */
function isJsonContentType(req) {
  const type = req.headers['content-type']
  return typeof type === 'string' && type.trim().toLowerCase().startsWith('application/json')
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) })
  res.end(payload)
}

function writeOpenAIError(res, status, kind, message) {
  writeJson(res, status, { error: { message, type: kind, code: kind } })
}

/** Read a request body with a size cap; over-limit bodies fail the request. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > REQUEST_BODY_LIMIT) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/**
 * Start the loopback endpoint. Requests may carry any bearer; the loopback bind
 * is the boundary, and the upstream credential comes from the store alone.
 *
 * @param store - a `LoomySessionStore` whose `resolve()` answers the current
 * session or throws when signed out.
 * @param client - the upstream module (provides `chatCompletion`).
 * @param catalog - the live `LoomyCatalog`.
 */
export function createLoomyShim({ store, client, catalog, logger } = {}) {
  const log = logger
  // Per-process shared secret. Lives only in memory; the adapter resolves it
  // as the OpenAI apiKey, which pi-ai sends as `Authorization: Bearer ...`.
  const SHARED_SECRET = randomBytes(32).toString('base64url')

  /** Constant-time bearer check. */
  function bearerOk(req) {
    const header = req.headers.authorization
    if (typeof header !== 'string') return false
    const match = /^Bearer\s+(.+)$/i.exec(header.trim())
    if (match === null) return false
    const presented = match[1]
    const expected = SHARED_SECRET
    const a = Buffer.from(presented)
    const b = Buffer.from(expected)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  const server = createServer((req, res) => {
    void handle(req, res)
  })

  const ready = bindToUsablePort(server, {
    host: '127.0.0.1',
    onBlockedPort: (port, attempt) => {
      log?.warn(`loomy-to-dsh: port ${port} is blocked for fetch; rebinding (attempt ${attempt})`)
    },
  }).then(() => undefined)

  const baseUrl = () => {
    const address = server.address()
    if (address === null || typeof address === 'string') {
      throw new Error('loomy shim has no listening address')
    }
    return `http://127.0.0.1:${address.port}`
  }

  async function handle(req, res) {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, 'host_not_allowed', 'Host header must name the loopback interface')
        return
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, 'origin_not_allowed', 'Origin must be a loopback origin')
        return
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, 'unauthorized', 'missing or invalid Authorization bearer')
        return
      }
      const url = req.url ?? '/'
      if (req.method === 'GET' && (url === '/healthz' || url === '/healthz/')) {
        writeJson(res, 200, { ok: true })
        return
      }
      if (req.method === 'GET' && (url === '/v1/models' || url === '/v1/models/')) {
        writeJson(res, 200, {
          object: 'list',
          data: catalog.current().map((model) => ({
            id: model.id,
            object: 'model',
            created: 0,
            owned_by: 'loomy',
          })),
        })
        return
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/v1/chat/completions/')) {
        await chatCompletions(req, res)
        return
      }
      writeOpenAIError(res, 404, 'not_found', `no such route: ${req.method} ${url}`)
    } catch (error) {
      if (!res.headersSent) {
        writeOpenAIError(res, 500, 'internal', error instanceof Error ? error.message : String(error))
      } else {
        res.end()
      }
    }
  }

  async function chatCompletions(req, res) {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, 'unsupported_media_type', 'Content-Type must be application/json')
      return
    }
    let credential
    try {
      credential = await store.resolve()
    } catch (error) {
      writeOpenAIError(res, 401, 'not_signed_in', error instanceof Error ? error.message : String(error))
      return
    }
    if (credential === undefined) {
      writeOpenAIError(res, 401, 'not_signed_in', 'Loomy is signed out')
      return
    }

    const raw = (await readBody(req)).toString('utf8')

    const controller = new AbortController()
    req.on('close', () => controller.abort())
    const result = await client.chatCompletion({
      session: credential.session,
      baseUrl: credential.baseUrl,
      body: raw,
      signal: controller.signal,
      loomyVersion: credential.appVersion,
    })

    if (!result.ok) {
      const detail = extractErrorMessage(result.message) || (result.message ?? '').slice(0, 400)
      const status = KIND_STATUS[result.kind] ?? 502
      writeOpenAIError(res, status, result.kind, `loomy upstream ${result.kind}: ${detail}`)
      return
    }

    // Pass the bytes through untouched: the upstream answers standard OpenAI
    // chat completions (non-streaming {choices:[{message}]} and streaming
    // chat.completion.chunk frames), so pi-ai's own OpenAI decoder does the
    // work and the plugin never rewrites a response body.
    const contentType = result.response.headers.get('content-type') ?? 'application/json'
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    })
    let sawDone = false
    const body = Readable.fromWeb(result.response.body)
    body.on('data', (chunk) => {
      if (chunk instanceof Buffer && chunk.includes('[DONE]')) sawDone = true
    })
    body.on('error', (error) => {
      log?.warn('loomy-to-dsh: upstream stream failed mid-flight', error)
      if (!sawDone && res.writable) res.end('data: [DONE]\n\n')
    })
    body.pipe(res)
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () =>
      new Promise((resolve, reject) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
        server.once('error', reject)
      }),
  }
}
