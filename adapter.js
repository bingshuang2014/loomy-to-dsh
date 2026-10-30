/**
 * The `loomy` pi-ai provider: one loopback-backed adapter registered into the
 * Harness LLM seam, assembled from public `dsh-llm-pi-ai` extension points the
 * way `dsh-workbuddy-connect` assembles its WorkBuddy route.
 *
 * @module loomy-to-dsh/adapter
 */

import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { resolveRetryPolicy, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { LOOMY_PROVIDER, LOOMY_DISPLAY_NAME, LOOMY_STREAM_IDLE_TIMEOUT_MS } from './version.js'

/** Provider route this bundle owns. */
export const LOOMY_PROVIDER_ID = LOOMY_PROVIDER

/** Image-request budgets at the dsh-llm-pi-ai defaults. */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
}

/**
 * Inert pi-ai auth plane. The loomy route authenticates only through the shim
 * shared secret resolved per request by `resolveApiKey`, so pi-ai's own
 * credential lifecycle and ambient discovery must never manufacture a
 * credential for it.
 */
const INERT_AUTH = {
  credentials: {
    async read() {
      return undefined
    },
    async list() {
      return []
    },
    async modify() {
      throw new Error('loomy-to-dsh: the loomy route has no pi-ai credential lifecycle')
    },
    async delete() {},
  },
  authContext: {
    async env() {
      return undefined
    },
    async fileExists() {
      return false
    },
  },
}

/** No per-token pricing is knowable for a subscription quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** The separator between a model name and its billing-rate suffix. */
const RATE_SEPARATOR = ' · '

/**
 * Resolve a Loomy model's reasoning capability into pi-ai's `thinkingLevelMap`.
 *
 * Loomy's directory declares `reasoning_efforts: ["none","low","medium","high",
 * "xhigh"]`. Two things differ from WorkBuddy's mapping:
 *
 * 1. `off` maps to the wire value `"none"` — Loomy uses `"none"` where
 *    WorkBuddy uses `"off"`. pi-ai's `openai` thinking format sends that as
 *    `reasoning_effort: "none"`, which the upstream accepts (it lists "none"
 *    in its efforts).
 * 2. `xhigh` is a real, declared level — offered. `max` is not declared by
 *    Loomy, so it is `null` (unsupported).
 */
function reasoningFields(info) {
  const reasoning = info.reasoning
  if (reasoning === undefined || reasoning.supports !== true) return { reasoning: false }
  const efforts = reasoning.supportedEfforts
  if (efforts === undefined || efforts.length === 0) return { reasoning: false }
  return {
    reasoning: true,
    thinkingLevelMap: {
      // "none" is Loomy's spelling for "thinking off"; only offer it when the
      // directory actually listed it (canDisableThinking).
      off: reasoning.canDisableThinking === true ? 'none' : null,
      minimal: null,
      low: efforts.includes('low') ? 'low' : null,
      medium: efforts.includes('medium') ? 'medium' : null,
      high: efforts.includes('high') ? 'high' : null,
      xhigh: efforts.includes('xhigh') ? 'xhigh' : null,
      max: null,
    },
  }
}

/** The billing-rate suffix appended to a model's display name. */
function displaySuffix(info) {
  const parts = []
  if (info.rate !== undefined) parts.push(`×${info.rate}`)
  if (Array.isArray(info.badges)) parts.push(...info.badges)
  return parts.length === 0 ? undefined : parts.join(RATE_SEPARATOR)
}

/** Append the catalog display suffix to one model's display name. */
function withCatalogDisplay(name, info) {
  const suffix = displaySuffix(info)
  return suffix === undefined ? name : `${name}${RATE_SEPARATOR}${suffix}`
}

/**
 * Translate the request-image contract across the two attachment-service
 * generations a link-installed plugin can straddle (copied from
 * dsh-workbuddy-connect): a 0.1.5 store wants `{ maxPixels }`, a 0.1.6+ store
 * wants `{ width, height, maxBytes }`. The wrapper fills the route's own pixel
 * budget into a target that lacks it.
 */
function withLegacyImageBudget(store) {
  return new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'imageHostPath') {
        return target.imageHostPath.bind(target)
      }
      if (property !== 'readImageRequest') return Reflect.get(target, property, receiver)
      return (...args) => {
        const [ref, policy, signal] = args
        const present = policy?.maxPixels
        const withPixels =
          Number.isSafeInteger(present) && present > 0
            ? policy
            : { ...policy, maxPixels: REQUEST_IMAGE_BUDGETS.requestImagePixelBudget }
        return target.readImageRequest(ref, withPixels, signal)
      }
    },
  })
}

/** Build one pi-ai model descriptor pointing at the loopback shim. */
function toPiModel(info, baseUrl, providerId) {
  return {
    id: info.id,
    name: info.name,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    input: info.supportsImages === true ? ['text', 'image'] : ['text'],
    ...reasoningFields(info),
    cost: NO_COST,
    contextWindow: info.contextWindow,
    maxTokens: info.maxTokens,
    compat: { maxTokensField: 'max_tokens' },
  }
}

/**
 * The Loomy route's adapter: `PiAiAdapter` with the billing rate folded into
 * the catalog answers it returns to the DSH model pickers (display-only; the
 * wire request is built from `model.id`, so a name suffix never affects
 * routing). Streaming, capability resolution, and effort mapping stay exactly
 * as `dsh-llm-pi-ai` implements them.
 */
class LoomyPiAiAdapter extends PiAiAdapter {
  constructor(catalog, hidden, options) {
    super(options)
    this.catalog = catalog
    this.hidden = hidden
  }

  /** Catalog entry for one model id, or undefined when the catalog omits it. */
  infoFor(model) {
    return this.catalog.current().find((entry) => entry.id === model)
  }

  async listModels(provider) {
    const models = await super.listModels(provider)
    const hidden = new Set(this.hidden())
    return models.flatMap((model) => {
      if (hidden.has(model.id)) return []
      const info = this.infoFor(model.id)
      if (info === undefined) return [model]
      return [{ ...model, name: withCatalogDisplay(model.name, info) }]
    })
  }

  async resolveModel(provider, model, signal) {
    const resolved = await super.resolveModel(provider, model, signal)
    const info = this.infoFor(model)
    if (info === undefined) return resolved
    return { ...resolved, name: withCatalogDisplay(resolved.name, info) }
  }
}

/**
 * Assemble the adapter. The provider's `getModels` reads the live catalog,
 * and every model's `baseUrl` is re-resolved per read so the shim's ephemeral
 * port applies from the first snapshot after startup.
 *
 * @returns `{ adapter, invalidate }`.
 */
export function createLoomyAdapter(options) {
  const { shim, catalog, resolveAttachments, resolveImageAccess, hidden } = options
  const providerId = LOOMY_PROVIDER_ID
  const displayName = LOOMY_DISPLAY_NAME

  const buildModels = () => {
    const baseUrl = `${shim.baseUrl()}/v1`
    return catalog.current().map((info) => toPiModel(info, baseUrl, providerId))
  }

  const provider = {
    ...createProvider({
      id: providerId,
      name: displayName,
      auth: {
        apiKey: {
          name: 'Loomy session token',
          async resolve({ credential }) {
            const apiKey = credential?.key
            return apiKey === undefined || apiKey.length === 0
              ? undefined
              : { auth: { apiKey }, source: 'Loomy' }
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  }

  const profile = {
    provider: providerId,
    displayName,
    streamIdleTimeoutMs: LOOMY_STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'loomy-to-dsh retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  }

  let profiles = new Map([[providerId, profile]])

  return {
    adapter: new LoomyPiAiAdapter(catalog, hidden ?? (() => []), {
      profiles: () => profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
      ...(resolveAttachments === undefined
        ? {}
        : {
            resolveAttachments: () => {
              const store = resolveAttachments()
              return store === undefined ? undefined : withLegacyImageBudget(store)
            },
          }),
      ...(resolveImageAccess === undefined ? {} : { resolveImageAccess }),
    }),
    invalidate: () => {
      profiles = new Map([[providerId, profile]])
    },
  }
}
