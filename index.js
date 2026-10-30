/**
 * loomy-to-dsh — bring the signed-in Loomy desktop app's models into
 * DeepSeek Harness with zero configuration.
 *
 * Registers one provider — `loomy` — whose models are served by a loopback
 * OpenAI-compatible shim that reuses the Loomy desktop app's on-disk session
 * token. Streaming, tool calls, compaction, and permissions stay
 * Harness-owned; the plugin only owns the credential and the wire rewrite.
 *
 * Architecture mirrors dsh-workbuddy-connect (one loopback shim + one pi-ai
 * adapter registered into the `llm` seam), specialised to Loomy's plaintext
 * session and the upstream wire quirks.
 *
 * @module loomy-to-dsh
 */

import { join } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { LOOMY_CONNECT_VERSION, LOOMY_PROVIDER, DEFAULT_LOOMY_BASE_URL, LOOMY_BASE_URL_ENV } from './version.js'
import {
  resolveProfileRoot,
  readSession,
  sessionFingerprint,
  sessionMtimeMs,
  accountKeyOf,
  maskSession,
  LOOMY_VERSION_ENV,
} from './session.js'
import { LoomyCatalog, LoomyCatalogStore, FALLBACK_LOOMY_MODELS } from './catalog.js'
import { LoomyVisibilityStore, loomyVisibilityPath, resolveDshHome } from './visibility.js'
import { fetchLoomyModels, chatCompletion } from './upstream.js'
import { createLoomyShim } from './shim.js'
import { createLoomyAdapter } from './adapter.js'
import { registerLoomyStatusRoute } from './status-route.js'

/** Stable Cordis plugin name (the bundle id in cordis.patch.yml). */
export const name = 'llm-loomy'

/** The model registry is required before the provider can register. */
export const inject = ['llm']

/** Plugin configuration. */
export const Config = z.object({
  /** Explicit Loomy profile root (parent of userData). Overrides discovery. */
  homeDir: z
    .string()
    .description('Loomy profile root (parent of userData); overrides auto-discovery')
    .default(''),
  /** Explicit Loomy userData directory. Overrides discovery. */
  userDataDir: z
    .string()
    .description('Loomy userData directory; overrides auto-discovery')
    .default(''),
  /** Explicit upstream base URL. Overrides opencode.json. */
  baseUrl: z
    .string()
    .description('Upstream base URL; overrides opencode.json (defaults to https://api.example.com/v1)')
    .default(''),
  /** How often, in ms, the session file is re-checked for a sign-in change. */
  pollMs: z
    .number()
    .description('Session poll interval in ms (default 30000)')
    .default(30000),
})

/** Default poll interval, in ms. */
const DEFAULT_POLL_MS = 30_000
const MIN_POLL_MS = 1_000
const MAX_POLL_MS = 24 * 60 * 60 * 1_000

/** Resolve the sweep interval, honoring the config override when usable. */
function pollMsOf(config) {
  const override = Number(config?.pollMs)
  if (!Number.isFinite(override) || override < MIN_POLL_MS) return DEFAULT_POLL_MS
  return Math.min(override, MAX_POLL_MS)
}

/**
 * The live session store: discovers the Loomy profile root once, then re-reads
 * the session file on demand. `current()` answers a normalised snapshot (or
 * undefined when signed out); `resolve()` answers the credential the shim
 * needs (throwing when signed out, so the shim surfaces a 401).
 */
class LoomySessionStore {
  constructor({ homeDir, userDataDir, baseUrlFallback, versionEnv }) {
    this.root = resolveProfileRoot({ homeDir, userDataDir })
    this.baseUrlFallback = baseUrlFallback
    this.versionEnv = versionEnv
    this.snapshot = undefined
    this.refresh()
  }

  /** Re-read the session file and update the cached snapshot. */
  refresh() {
    const result = readSession(this.root, {
      baseUrlFallback: this.baseUrlFallback,
      versionEnv: this.versionEnv,
    })
    if (result.found) {
      this.snapshot = {
        session: result.session.session,
        userid: result.session.userid,
        phone: result.session.phone,
        ...(result.session.updatedAt === undefined ? {} : { updatedAt: result.session.updatedAt }),
        sessionMasked: maskSession(result.session.session),
        baseUrl: result.baseUrl,
        appVersion: result.appVersion,
      }
    } else {
      this.snapshot = undefined
    }
    return this.snapshot
  }

  /** The current normalised session, or undefined when signed out. */
  current() {
    return this.snapshot
  }

  /** The credential the shim forwards as, or throws when signed out. */
  async resolve() {
    const snapshot = this.snapshot
    if (snapshot === undefined) {
      throw new Error('Loomy is signed out (no auth-session.json with a session token)')
    }
    return { session: snapshot.session, baseUrl: snapshot.baseUrl, appVersion: snapshot.appVersion }
  }
}

/**
 * Start the plugin: discover the session, build the catalog, stand up the
 * loopback shim, register the `loomy` provider, and poll for sign-in changes.
 */
export function apply(ctx, config) {
  const baseUrlFallback = resolveBaseUrlFallback(config)
  const versionEnv = (process.env[LOOMY_VERSION_ENV] || '').trim()
  const store = new LoomySessionStore({
    homeDir: config?.homeDir,
    userDataDir: config?.userDataDir,
    baseUrlFallback,
    versionEnv,
  })

  // The catalog starts hidden: nothing is served until an account is actually
  // adopted, so a signed-out machine shows no group rather than a roster whose
  // models could only fail. `adoptIdentity` reveals it.
  const catalog = new LoomyCatalog(FALLBACK_LOOMY_MODELS)
  catalog.setVisible(false)
  const catalogStore = new LoomyCatalogStore(loomyCatalogPath())
  const visibilityStore = new LoomyVisibilityStore()

  /** The visibility account key currently in effect, or undefined. */
  let account = () => {
    const snapshot = store.current()
    return snapshot === undefined ? undefined : accountKeyOf(snapshot)
  }

  /** Hidden model ids for the current account (empty when signed out). */
  const hidden = () => {
    const key = account()
    return key === undefined ? [] : visibilityStore.disabled(key)
  }

  // Stand up the loopback shim. The provider's models read the shim origin at
  // construction time, so registration waits for the listener to hold a port.
  const shim = createLoomyShim({
    store,
    client: { chatCompletion },
    catalog,
    logger: ctx.logger,
  })

  /** Invalidate: rebuild the profile map and tell the host the answers moved. */
  let invalidate = () => {}

  /** Whether the provider registered successfully. */
  let registered = false

  /**
   * Point the catalog at one account's best-known roster and reveal/hide the
   * group. Called on startup, on every sweep that sees a new identity, and on
   * a manual refresh.
   */
  const adoptIdentity = async () => {
    const snapshot = store.current()
    const key = snapshot === undefined ? undefined : accountKeyOf(snapshot)
    if (snapshot === undefined) {
      catalog.setVisible(false)
      catalog.useFallback()
      invalidate()
      return
    }
    // Serve this account's saved catalog until a live fetch lands; the saved
    // roster is preferred over the compiled snapshot (it is what this account
    // was actually served last).
    const saved = catalogStore.get(key)
    if (saved !== undefined) {
      catalog.set(saved.models)
      catalog.source = 'saved'
      catalog.fetchedAt = saved.fetchedAt
    } else {
      catalog.useFallback()
    }
    catalog.setVisible(true)
    invalidate()
    // Fetch the live directory in the background; a failure leaves the saved
    // or fallback roster in place.
    await fetchCatalog(key, snapshot)
  }

  /** Fetch the live model directory and install it if it succeeds. */
  const fetchCatalog = async (key, snapshot) => {
    const result = await fetchLoomyModels({
      session: snapshot.session,
      baseUrl: snapshot.baseUrl,
    })
    // A late response from a previous identity must not overwrite a newer one:
    // re-check the account after the await.
    if (account() !== key) return
    if (result.ok) {
      catalog.set(result.models)
      catalog.source = 'live'
      catalog.fetchedAt = Date.now()
      catalog.error = undefined
      if (key !== undefined) catalogStore.set(key, result.models, catalog.fetchedAt)
      invalidate()
    } else {
      catalog.error = result.message ?? result.kind
      invalidate()
    }
  }

  // Register the provider once the shim holds a port.
  void (async () => {
    try {
      await shim.ready
    } catch (error) {
      ctx.logger.error('loomy-to-dsh: loopback endpoint failed to start', error)
      return
    }
    try {
      const built = createLoomyAdapter({
        shim,
        catalog,
        resolveAttachments: () => ctx.get('attachments'),
        resolveImageAccess: (attachments, ref) =>
          resolveImageAttachmentAccess(attachments, (hostPath) => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
        hidden,
      })
      invalidate = () => {
        built.invalidate()
        ctx.emit('llm/adapters-updated')
      }
      const releaseAdapter = ctx.llm.registerAdapter([LOOMY_PROVIDER], built.adapter)
      try {
        ctx.effect(
          () => () => {
            releaseAdapter()
            shim.close()
          },
          'loomy-to-dsh: adapter + shim',
        )
      } catch {
        releaseAdapter()
        void shim.close()
      }
      registered = true
      // Reveal the group for whatever sign-in state is current.
      void adoptIdentity()
    } catch (error) {
      ctx.logger.error('loomy-to-dsh: provider registration failed', error)
      void shim.close()
    }
  })()

  // Poll the session file for a sign-in / sign-out / rotation. A cheap
  // existence + mtime check first; a changed file is re-read and the identity
  // re-adopted. Never contacts the network on its own.
  const poll = pollMsOf(config)
  let lastFingerprint = sessionFingerprint(store.root)
  const timer = setInterval(() => {
    if (store.root === undefined) return
    const mtime = sessionMtimeMs(store.root)
    const fingerprint = sessionFingerprint(store.root)
    if (fingerprint === lastFingerprint && mtime === 0) return
    if (fingerprint === lastFingerprint) return
    lastFingerprint = fingerprint
    store.refresh()
    void adoptIdentity()
  }, poll)
  // The host unrefs background timers so they do not keep the process alive.
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(
    () => () => {
      clearInterval(timer)
    },
    'loomy-to-dsh: session poll',
  )

  // Same-origin status route; the webServer service is optional (a headless
  // profile serves no browser, and the plugin still serves its models).
  ctx.inject(['webServer'], (webCtx) => {
    registerLoomyStatusRoute(webCtx, {
      version: LOOMY_CONNECT_VERSION,
      path: '/loomy-to-dsh/status',
      session: () => {
        const snapshot = store.current()
        if (snapshot === undefined) return undefined
        return snapshot
      },
      models: () => catalog.current(),
      visibility: () => {
        const key = account()
        return key === undefined ? undefined : { account: key, disabled: visibilityStore.disabled(key) }
      },
      catalog: () => ({
        source: catalog.source,
        ...(catalog.fetchedAt === undefined ? {} : { fetchedAt: catalog.fetchedAt }),
        ...(catalog.error === undefined ? {} : { error: catalog.error }),
      }),
      appVersion: store.current()?.appVersion ?? '',
      baseUrl: store.current()?.baseUrl ?? baseUrlFallback,
    })
  })
}

/** Resolve the upstream base URL fallback from config + env. */
function resolveBaseUrlFallback(config) {
  const candidates = [config?.baseUrl, process.env[LOOMY_BASE_URL_ENV], DEFAULT_LOOMY_BASE_URL]
  for (const candidate of candidates) {
    const value = typeof candidate === 'string' ? candidate.trim() : ''
    if (value === '' || !/^https?:\/\//i.test(value)) continue
    return value.replace(/\/+$/, '')
  }
  return DEFAULT_LOOMY_BASE_URL
}

/** The persisted-catalog file path, under the DSH home. */
function loomyCatalogPath() {
  return join(resolveDshHome(), '.loomy-catalog.json')
}
