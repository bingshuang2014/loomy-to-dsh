import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildLoomyHeaders,
  directoryHeaders,
  generateTraceparent,
  generateRequestIds,
  classifyUpstreamError,
  resolveBaseUrl,
  UPSTREAM_ERROR_KINDS,
} from '../upstream.js'

test('buildLoomyHeaders always includes TurnId (the one header that is actually mandatory)', () => {
  const headers = buildLoomyHeaders({ session: 'tok', loomyVersion: '0.9.38' })
  assert.equal(headers.Authorization, 'Bearer tok')
  assert.equal(headers.token, 'tok')
  assert.ok(typeof headers.TurnId === 'string' && headers.TurnId.length > 0, 'TurnId must be present')
  assert.ok(typeof headers.ChatId === 'string' && headers.ChatId.length > 0)
  assert.ok(typeof headers.MsgId === 'string' && headers.MsgId.length > 0)
  assert.equal(headers['X-Loomy-Request-Purpose'], 'chat.message')
  assert.equal(headers.InvokeOrigin, 'user')
  assert.equal(headers['loomy-version'], '0.9.38')
})

test('buildLoomyHeaders TurnId echoes the MsgId (the combination that passes validation)', () => {
  const ids = generateRequestIds()
  assert.equal(ids.turnId, ids.msgId)
  const headers = buildLoomyHeaders({ session: 'tok', ids })
  assert.equal(headers.TurnId, ids.msgId)
})

test('buildLoomyHeaders returns undefined for an empty session', () => {
  assert.equal(buildLoomyHeaders({ session: '' }), undefined)
  assert.equal(buildLoomyHeaders({}), undefined)
})

test('buildLoomyHeaders falls back to a default version when none is given', () => {
  const headers = buildLoomyHeaders({ session: 'tok' })
  assert.ok(typeof headers['loomy-version'] === 'string' && headers['loomy-version'] !== '')
})

test('generateTraceparent is W3C-shaped: 00-<32hex>-<16hex>-01', () => {
  const tp = generateTraceparent()
  assert.match(tp, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
})

test('directoryHeaders omits the chat-only tracking ids', () => {
  const headers = directoryHeaders('tok')
  assert.equal(headers.Authorization, 'Bearer tok')
  assert.equal(headers.token, 'tok')
  assert.equal(headers.TurnId, undefined)
  assert.equal(headers.ChatId, undefined)
})

test('classifyUpstreamError maps auth and rate statuses', () => {
  assert.equal(classifyUpstreamError(401, ''), UPSTREAM_ERROR_KINDS.sessionDead)
  assert.equal(classifyUpstreamError(403, ''), UPSTREAM_ERROR_KINDS.sessionDead)
  assert.equal(classifyUpstreamError(402, ''), UPSTREAM_ERROR_KINDS.credit)
  assert.equal(classifyUpstreamError(429, ''), UPSTREAM_ERROR_KINDS.rate)
  assert.equal(classifyUpstreamError(400, '请求参数错误'), UPSTREAM_ERROR_KINDS.client)
  assert.equal(classifyUpstreamError(500, ''), UPSTREAM_ERROR_KINDS.server)
})

test('classifyUpstreamError detects credit exhaustion from the body', () => {
  assert.equal(classifyUpstreamError(400, '积分不足'), UPSTREAM_ERROR_KINDS.credit)
  assert.equal(classifyUpstreamError(400, '额度已用完'), UPSTREAM_ERROR_KINDS.credit)
})

test('resolveBaseUrl prefers an explicit value and strips trailing slashes', () => {
  assert.equal(resolveBaseUrl({ baseUrl: 'https://example.com/api/v1///' }), 'https://example.com/api/v1')
  assert.equal(resolveBaseUrl({}), 'https://loomyad.xunfei.cn/api/v1')
  assert.equal(resolveBaseUrl({ baseUrl: 'not-a-url' }), 'https://loomyad.xunfei.cn/api/v1')
})
