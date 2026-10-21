import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { HarnessOptions } from '@foreman-code/contracts/management'
import { codexModelOptions } from '../src/modules/harnesses/operatorOptions.js'
import { latestNativeModel, nativeModelDefaults } from '../src/modules/harnesses/modelDefaults.js'

const catalog = (harness: HarnessOptions['harness'], models: HarnessOptions['models']): HarnessOptions => ({ harness,
  providerVersion: 'observed', authenticated: true, models, nativeAgents: ['build'], settings: [], restrictions: [], checkedAt: new Date().toISOString() })
const model = (id: string, rest: Partial<HarnessOptions['models'][number]> = {}): HarnessOptions['models'][number] => ({
  id, reasoningEfforts: ['low', 'medium', 'high'], variants: ['', 'medium', 'max'], serviceTiers: ['standard'], ...rest })

it('uses native preference when IDs do not establish recency and excludes hidden Codex helpers', () => {
  const models = codexModelOptions({ models: [{ slug: 'older-z', priority: 9, supported_reasoning_levels: [{ effort: 'high' }, { effort: 'medium' }] },
    { slug: 'newer-a', priority: 1, supported_reasoning_levels: [{ effort: 'medium' }] }, { slug: 'hidden-helper', priority: 0, visibility: 'hide', supported_reasoning_levels: [] }] })
  expect(latestNativeModel(catalog('codex', models)).id).toBe('newer-a')
  expect(nativeModelDefaults(DEFAULT_HARNESS_DEFAULTS.codex, catalog('codex', models))).toMatchObject({
    model: 'newer-a', reasoningEffort: 'medium', sandbox: DEFAULT_HARNESS_DEFAULTS.codex.sandbox })
})

it('does not invent model ordering', () => {
  expect(() => latestNativeModel(catalog('codex', [model('newer-looking-id')]))).toThrow('no release date or default model preference')
})

it('selects advertised medium Claude effort while preserving its profile and sandbox', () => {
  const configuration = { harness: 'claude' as const, model: 'placeholder', configDirectory: '/actual/profile', authMode: 'subscription' as const,
    permissionMode: 'default' as const, sandbox: 'danger-full-access' as const, tools: [], permissionRules: [], instructions: '', mcpServers: {} }
  expect(nativeModelDefaults(configuration, catalog('claude', [model('actual-canonical-model', { defaultPriority: -1 })]))).toEqual({
    ...configuration, model: 'actual-canonical-model', effort: 'medium' })
  expect(nativeModelDefaults({ ...configuration, effort: 'max' as const }, catalog('claude', [model('no-effort-model', {
    defaultPriority: -1, reasoningEfforts: [],
  })])).effort).toBeUndefined()
})
