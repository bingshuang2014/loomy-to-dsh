import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseLoomyCatalogResponse,
  parseRate,
  badgesOf,
  FALLBACK_LOOMY_MODELS,
  LoomyCatalog,
} from '../catalog.js'

/** A minimal but representative slice of the real GET /models response. */
const SAMPLE_MODELS_RESPONSE = {
  object: 'list',
  reasoning_enabled: true,
  data: [
    {
      id: 'DeepSeek-V4.1-Flash',
      name: 'DeepSeek V4.1 Flash(x2.0)',
      type: 'chat',
      protocol: 'openai_chat',
      context_length: 1048576,
      max_output_tokens: 384000,
      reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      default_reasoning_effort: 'low',
      capabilities: {
        reasoning: true,
        vision: true,
        function_calling: true,
        streaming: true,
        input_modalities: ['text', 'image'],
        output_modalities: ['text'],
      },
      is_default_model: true,
    },
    {
      id: 'qwen-3.8-max',
      name: 'Qwen 3.8 Max (x12.0)',
      type: 'chat',
      protocol: 'openai_chat',
      context_length: 1000000,
      max_output_tokens: 65536,
      reasoning_efforts: ['none', 'low', 'medium', 'high', 'xhigh'],
      default_reasoning_effort: 'low',
      capabilities: {
        reasoning: true,
        vision: false,
        function_calling: true,
        streaming: true,
        input_modalities: ['text'],
        output_modalities: ['text'],
      },
    },
    {
      id: 'Hy-Image-3.5-preview',
      name: 'Hy image 3.5 preview',
      type: 'image',
      protocol: 'openai_chat',
      context_length: 100000,
      capabilities: { reasoning: false, vision: true, function_calling: false, streaming: false },
    },
    {
      id: 'auto',
      name: '自动 · 均衡',
      type: 'chat',
      protocol: 'openai_chat',
    },
  ],
}

test('parseLoomyCatalogResponse drops image models and limit-less rows', () => {
  const models = parseLoomyCatalogResponse(SAMPLE_MODELS_RESPONSE)
  const ids = models.map((m) => m.id)
  assert.ok(ids.includes('DeepSeek-V4.1-Flash'))
  assert.ok(ids.includes('qwen-3.8-max'))
  assert.ok(!ids.includes('Hy-Image-3.5-preview'), 'image model must be dropped')
  assert.ok(!ids.includes('auto'), 'limit-less auto row must be dropped')
  assert.equal(models.length, 2)
})

test('parseLoomyCatalogResponse maps reasoning efforts excluding "none"', () => {
  const [ds] = parseLoomyCatalogResponse(SAMPLE_MODELS_RESPONSE).filter((m) => m.id === 'DeepSeek-V4.1-Flash')
  assert.equal(ds.reasoning.supports, true)
  // "none" is the off value and is surfaced via canDisableThinking, not efforts.
  assert.deepEqual(ds.reasoning.supportedEfforts, ['low', 'medium', 'high', 'xhigh'])
  assert.equal(ds.reasoning.canDisableThinking, true)
  assert.equal(ds.reasoning.defaultEffort, 'low')
  assert.equal(ds.supportsImages, true)
  assert.equal(ds.supportsTools, true)
  assert.equal(ds.rate, 2.0)
  assert.equal(ds.isDefault, true)
})

test('parseLoomyCatalogResponse: text-only model has supportsImages false', () => {
  const [qwen] = parseLoomyCatalogResponse(SAMPLE_MODELS_RESPONSE).filter((m) => m.id === 'qwen-3.8-max')
  assert.equal(qwen.supportsImages, false)
  assert.equal(qwen.rate, 12.0)
})

test('parseRate handles fullwidth and halfwidth parens', () => {
  assert.equal(parseRate('DeepSeek V4.1 Flash(x2.0)'), 2.0)
  assert.equal(parseRate('MiniMax M3（x4.0）'), 4.0)
  assert.equal(parseRate('Spark-X2.6 正式版（限时免费）(x0.0)'), 0.0)
  assert.equal(parseRate('auto'), undefined)
})

test('badgesOf detects promotional phrases', () => {
  assert.deepEqual(badgesOf('Spark-X2.6 正式版（限时免费）(x0.0)'), ['限时免费'])
  assert.deepEqual(badgesOf('DeepSeek V4.1 Flash(x2.0)'), [])
})

test('parseLoomyCatalogResponse tolerates a bare array', () => {
  const models = parseLoomyCatalogResponse([{ id: 'X', name: 'X', type: 'chat', context_length: 1000, max_output_tokens: 100, capabilities: { streaming: true, input_modalities: ['text'] } }])
  assert.equal(models.length, 1)
  assert.equal(models[0].id, 'X')
})

test('parseLoomyCatalogResponse drops a row whose type is not chat', () => {
  const models = parseLoomyCatalogResponse({ data: [{ id: 'img', type: 'image', context_length: 1, max_output_tokens: 1, capabilities: { streaming: true, input_modalities: ['text'] } }] })
  assert.equal(models.length, 0)
})

test('LoomyCatalog is hidden until setVisible(true)', () => {
  const catalog = new LoomyCatalog(FALLBACK_LOOMY_MODELS)
  catalog.useFallback()
  assert.equal(catalog.current().length, 0, 'hidden catalog serves nothing')
  assert.equal(catalog.setVisible(true), true)
  assert.ok(catalog.current().length > 0)
  assert.equal(catalog.setVisible(true), false, 'no-op set returns false')
})

test('LoomyCatalog.set replaces the roster', () => {
  const catalog = new LoomyCatalog(FALLBACK_LOOMY_MODELS)
  catalog.set([{ id: 'only', name: 'Only', contextWindow: 1, maxTokens: 1, supportsImages: false, supportsTools: false, reasoning: { supports: false, supportedEfforts: [] } }])
  catalog.setVisible(true)
  assert.equal(catalog.current().length, 1)
  assert.equal(catalog.current()[0].id, 'only')
})
