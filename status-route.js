/**
 * The plugin's web status route: a same-origin GET endpoint the (optional)
 * plugin configuration card can poll. Hosted on the DSH web server, it reports
 * the live sign-in, the catalog source, and the served models — never the
 * session token itself.
 *
 * @module loomy-to-dsh/status-route
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/** Loopback hostnames the status route trusts (same as the shim's gate). */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * Whether a request is same-origin/loopback. The route is mounted on the host
 * web server, so the Host header is whatever the browser sent; a request that
 * names a loopback host or carries no forwarded-by chain is trusted.
 */
function loopbackRequest(req) {
  const host = String(req.headers?.host ?? '').trim().toLowerCase()
  if (host !== '') {
    const hostname = host.split(':')[0]
    if (LOOPBACK_HOSTS.has(hostname) || hostname === '::1') return true
  }
  // The DSH host web server itself is loopback-only in practice; a request
  // that escaped that bind would carry a forwarded chain, which we reject.
  const forwardedFor = String(req.headers?.['x-forwarded-for'] ?? '').trim()
  const forwardedHost = String(req.headers?.['x-forwarded-host'] ?? '').trim()
  return forwardedFor === '' && forwardedHost === ''
}

/** Write a JSON response. The host web server writes the status line. */
function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  })
  res.end(payload)
}

/**
 * Build the status document. Pulls the live session, catalog, and visibility
 * through the provided getters so a single read is consistent.
 */
export async function loomyWebStatus(deps) {
  const session = deps.session?.()
  const models = deps.models?.() ?? []
  const visibility = deps.visibility?.()
  const catalog = deps.catalog?.()
  const creditsResult = await fetchCredits()

  // 检查是否有错误
  const creditsError = creditsResult?.error ? {
    code: creditsResult.error,
    message: creditsResult.message,
  } : undefined

  // 只有成功时才返回积分数据
  const credits = creditsError ? null : creditsResult

  return {
    plugin: 'loomy-to-dsh',
    version: deps.version,
    provider: 'loomy',
    signedIn: session !== undefined,
    ...(session === undefined
      ? {}
      : {
          account: session.userid === '' ? undefined : session.userid,
          phoneMasked: maskPhone(session.phone),
          sessionMasked: session.sessionMasked,
          updatedAt: session.updatedAt,
        }),
    appVersion: deps.appVersion ?? '',
    baseUrl: deps.baseUrl ?? '',
    credits,
    ...(creditsError ? { creditsError } : {}),
    catalog: catalog ?? { source: 'unknown' },
    models: models.map((model) => ({
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      supportsImages: model.supportsImages,
      supportsTools: model.supportsTools,
      ...(model.rate === undefined ? {} : { rate: model.rate }),
      ...(Array.isArray(model.badges) && model.badges.length > 0 ? { badges: model.badges } : {}),
      reasoning:
        model.reasoning === undefined || model.reasoning.supports !== true
          ? false
          : { efforts: model.reasoning.supportedEfforts, canDisable: model.reasoning.canDisableThinking === true },
    })),
    visibility,
  }
}

/**
 * Fetch credits from Loomy web API.
 * Cookie 有效期至 2026-11-11
 */
async function fetchCredits() {
  // 优先从配置文件读取 cookie
  let cookieValue = null
  const cookieFile = join(homedir(), '.dsh', 'loomy-cookie.txt')

  try {
    if (existsSync(cookieFile)) {
      const content = readFileSync(cookieFile, 'utf-8').trim()
      if (content && !content.includes('\n')) {
        cookieValue = content
      }
    }
  } catch (error) {
    // 忽略错误，使用硬编码的 cookie
  }

  // 如果没有配置文件，使用硬编码的 cookie
  if (!cookieValue) {
    cookieValue =
      'mkHnfeu090Eol-m1c8NQH5WaUw01TdC4msa030I83xMTJ6MchHt1uT9ABOevJGbbdkt06a2VipYykJpc_eGklf8AzBWHptuAUNxU8ztk7u6D9PGwRysmOVKz3s0D8ktdXo1KRea0iOLTKXiot44X6NF6KDiWsl05yfV16lBIb7oucOlMHFhfMwsMc2NbwplGws1JMEXaWc1gMH0XQCgmKgMkrKRYPP4WRccQszrhfVItSbgG7q9zh2XGRjHQL0yPUqG7pD-mRgkMbm1Vqik-ze7T4tpg_A45qUI4Dul1mmzx'
  }

  const url = 'https://api.example.com/credits'

  try {
    const response = await fetch(url, {
      headers: {
        Cookie: `session_id=${cookieValue}`,
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    })

    if (response.status === 401 || response.status === 403) {
      return { error: 'cookie_expired', message: 'Cookie 已过期，请重新登录 Loomy 网页版' }
    }

    if (!response.ok) {
      return { error: 'api_error', message: `API 错误: ${response.status}` }
    }

    const data = await response.json()

    if (data.success && data.data) {
      return {
        permanent: data.data.permanent,
        daily: data.data.daily,
        total: data.data.permanent + data.data.daily,
      }
    }

    return { error: 'invalid_response', message: 'API 返回格式错误' }
  } catch (error) {
    return { error: 'network_error', message: `网络错误: ${error.message}` }
  }
}


/** Mask a phone number to its last four digits. */
function maskPhone(phone) {
  const value = String(phone ?? '')
  if (value.length <= 4) return value.length === 0 ? '' : '***'
  return `***${value.slice(-4)}`
}

/** The status route's request handler. */
export function loomyStatusHandler(deps) {
  return async (req, res) => {
    if (req.method !== 'GET') {
      json(res, 405, { error: 'method not allowed' })
      return
    }
    if (!loopbackRequest(req)) {
      json(res, 403, { error: 'request-not-trusted' })
      return
    }
    try {
      json(res, 200, await loomyWebStatus(deps))
    } catch (error) {
      json(res, 500, { error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/** Mount the GET status route on a webServer context. */
export function registerLoomyStatusRoute(ctx, deps) {
  const path = deps.path ?? '/loomy-to-dsh/status'
  ctx.effect(
    () => {
      const dispose = ctx.webServer.register({
        kind: 'exact',
        path,
        handler: loomyStatusHandler(deps),
      })
      return () => {
        dispose()
      }
    },
    'loomy-to-dsh: Web status route',
  )
}
