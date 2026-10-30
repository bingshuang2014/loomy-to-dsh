/**
 * End-to-end integration check: start the real loopback shim pointed at the
 * live upstream, send one tiny chat completion through it, and assert
 * the SSE/non-stream response comes back as a 200 OpenAI completion.
 *
 * Skipped unless LOOMY_INTEGRATION=1: it consumes the signed-in account's real
 * credits (one request, max_tokens 16) and needs the Loomy desktop app to be
 * logged in on this machine.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createLoomyShim } from '../shim.js'
import { chatCompletion, fetchLoomyModels } from '../upstream.js'
import { LoomyCatalog, FALLBACK_LOOMY_MODELS, parseLoomyCatalogResponse } from '../catalog.js'
import { resolveProfileRoot, readSession } from '../session.js'

const ENABLED = process.env['LOOMY_INTEGRATION'] === '1'

/** Resolve the real Loomy profile root and session on this machine. */
function realSession() {
  const root = resolveProfileRoot()
  if (root === undefined) return undefined
  const result = readSession(root, {})
  if (!result.found) return undefined
  return { root, ...result }
}

test('integration: shim forwards a chat completion to the live upstream', { skip: !ENABLED }, async () => {
  const session = realSession()
  assert.ok(session, 'no signed-in Loomy session found on this machine')
  // Pull the live catalog so /v1/models answers truthfully; fall back to the
  // snapshot so the shim still serves a roster if the directory fetch fails.
  const catalog = new LoomyCatalog(FALLBACK_LOOMY_MODELS)
  catalog.useFallback()
  catalog.setVisible(true)
  const dir = await fetchLoomyModels({ session: session.session.session, baseUrl: session.baseUrl })
  if (dir.ok) catalog.set(dir.models)

  const shim = createLoomyShim({
    store: {
      async resolve() {
        return { session: session.session.session, baseUrl: session.baseUrl, appVersion: session.appVersion }
      },
    },
    client: { chatCompletion },
    catalog,
  })
  try {
    await shim.ready
    const url = `${shim.baseUrl()}/v1/chat/completions`
    const body = JSON.stringify({
      model: 'DeepSeek-V4.1-Flash',
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 16,
      stream: false,
    })
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shim.token()}`,
      },
      body,
    })
    assert.equal(response.status, 200, `shim returned ${response.status}`)
    const parsed = await response.json()
    assert.equal(parsed.object, 'chat.completion')
    assert.ok(Array.isArray(parsed.choices), 'choices array present')
    assert.ok(typeof parsed.usage === 'object', 'usage present')
  } finally {
    await shim.close()
  }
})

test('integration: shim streams a chat completion as SSE', { skip: !ENABLED }, async () => {
  const session = realSession()
  assert.ok(session, 'no signed-in Loomy session found on this machine')
  const catalog = new LoomyCatalog(FALLBACK_LOOMY_MODELS)
  catalog.useFallback()
  catalog.setVisible(true)
  const shim = createLoomyShim({
    store: {
      async resolve() {
        return { session: session.session.session, baseUrl: session.baseUrl, appVersion: session.appVersion }
      },
    },
    client: { chatCompletion },
    catalog,
  })
  try {
    await shim.ready
    const url = `${shim.baseUrl()}/v1/chat/completions`
    const body = JSON.stringify({
      model: 'DeepSeek-V4.1-Flash',
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 16,
      stream: true,
    })
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${shim.token()}`,
      },
      body,
    })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)
    const text = await response.text()
    assert.match(text, /^data: /m, 'SSE frames present')
    assert.ok(text.includes('[DONE]') || text.includes('chat.completion.chunk'), 'stream body is OpenAI chunks')
  } finally {
    await shim.close()
  }
})

test('integration: shim rejects a request without the shared secret', { skip: !ENABLED }, async () => {
  const session = realSession()
  assert.ok(session, 'no signed-in Loomy session found on this machine')
  const catalog = new LoomyCatalog(FALLBACK_LOOMY_MODELS)
  catalog.useFallback()
  catalog.setVisible(true)
  const shim = createLoomyShim({
    store: { async resolve() { return { session: session.session.session, baseUrl: session.baseUrl, appVersion: session.appVersion } } },
    client: { chatCompletion },
    catalog,
  })
  try {
    await shim.ready
    const response = await fetch(`${shim.baseUrl()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
    assert.equal(response.status, 401, 'a request without the bearer must be rejected')
  } finally {
    await shim.close()
  }
})
