import { expect, it, vi } from 'vitest'
import { parseCodexModelCatalog, readNativeCodexModelCatalog, type CodexModelInspection } from './codexModelCatalog.js'
import { qualifyNativeCodexModel } from './codexQualification.js'
import type { QualifiedCodex } from './codexProtocol.js'
import { HarnessExecutionError } from './errors.js'

const configuration = { harness: 'codex' as const, model: 'selected-model', reasoningEffort: 'high' as const,
  sandbox: 'read-only' as const, serviceTier: 'standard' as const }
const selected = { model: configuration.model, displayName: 'Selected model', hidden: false,
  supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }

function inspection(data: unknown[] = [selected], refreshOnClose = false) {
  const close = vi.fn(async () => {})
  const transportFactory: NonNullable<CodexModelInspection['transportFactory']> = (...args) => ({
    start: async () => {}, reject: async () => {},
    request: async () => {
      if (!refreshOnClose) args[10]?.()
      return { data, nextCursor: null }
    },
    close: async () => { if (refreshOnClose) args[10]?.(); await close() },
  })
  const value: CodexModelInspection = {
    qualified: { binary: '/installed/codex', providerVersion: '0.161.0' } as QualifiedCodex,
    assertUnchanged: async () => {},
    runCommand: async () => ({ exitCode: 0, stdout: '[]', stderr: '' }), transportFactory,
  }
  return { value, close }
}

it.each([false, true])('uses a valid native catalog when refresh fails (warning during close: %s)', async late => {
  const f = inspection([selected], late)
  await expect(readNativeCodexModelCatalog(f.value, '/workspace', {}))
    .resolves.toMatchObject({ modelCatalogSource: 'cached', models: [{ slug: configuration.model }] })
  expect(f.close).toHaveBeenCalledTimes(1)
})

it('accepts the selected model and effort from a cached catalog during native admission', async () => {
  const f = inspection()
  await expect(qualifyNativeCodexModel(configuration, '/installed/codex', '/workspace', {},
    undefined, undefined, f.value)).resolves.toMatchObject({ modelCatalogSource: 'cached' })
})

it.each([
  { data: [], code: 'CODEX_MODEL_UNAVAILABLE' },
  { data: [{ ...selected, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], code: 'CODEX_SETTING_UNSUPPORTED' },
  { data: [{ ...selected, supportedReasoningEfforts: null }], code: 'CODEX_MODEL_CATALOG_INVALID' },
])('preserves the catalog validation failure after a refresh warning: $code', async ({ data, code }) => {
  const f = inspection(data)
  await expect(qualifyNativeCodexModel(configuration, '/installed/codex', '/workspace', {},
    undefined, undefined, f.value)).rejects.toMatchObject({ result: { error: { code } } })
  expect(f.close).toHaveBeenCalledTimes(1)
})

it('validates successful CLI fallback data instead of replacing a missing model with a refresh failure', () => {
  expect(parseCodexModelCatalog({ exitCode: 0, stdout: '{"models":[]}',
    stderr: 'failed to refresh available models: unavailable' }))
    .toMatchObject({ models: [], modelCatalogSource: 'cached' })
})

it('retries unavailable catalog inspection on the native admission path', async () => {
  const f = inspection()
  const runCommand = vi.fn<NonNullable<CodexModelInspection['runCommand']>>()
    .mockRejectedValueOnce(new HarnessExecutionError('CODEX_MODEL_CATALOG_UNAVAILABLE', 'Unavailable', true))
    .mockResolvedValue({ exitCode: 0, stdout: '[]', stderr: '' })
  await expect(qualifyNativeCodexModel(configuration, '/installed/codex', '/workspace', {},
    undefined, undefined, { ...f.value, runCommand })).resolves.toMatchObject({ modelCatalogSource: 'cached' })
  expect(runCommand).toHaveBeenCalledTimes(2)
})

it('retains model/list windows and fills missing ones from the selected installation cache', async () => {
  const f = inspection([
    { ...selected, contextWindow: 272000 },
    { ...selected, model: 'cached-model' },
    { ...selected, model: 'unknown-model' },
  ])
  const readCachedModels = vi.fn(async () => [
    { slug: selected.model, context_window: 128000 },
    { slug: 'cached-model', context_window: 200000 },
    { slug: 'unlisted-model', context_window: 1000000 },
  ])
  const catalog = await readNativeCodexModelCatalog({ ...f.value, readCachedModels }, '/workspace', {})
  expect(catalog.models).toMatchObject([
    { slug: selected.model, context_window: 272000 },
    { slug: 'cached-model', context_window: 200000 },
    { slug: 'unknown-model' },
  ])
  expect(catalog.models[2]).not.toHaveProperty('context_window')
  expect(catalog.models).toHaveLength(3)
  expect(readCachedModels).toHaveBeenCalledOnce()
})
