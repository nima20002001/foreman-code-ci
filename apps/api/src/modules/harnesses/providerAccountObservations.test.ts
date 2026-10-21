import { CodexHarnessConfigurationSchema } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { HarnessConfiguration } from '@foreman-code/contracts'
import type { ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { NativeConfigurationService } from './nativeConfiguration.js'
import type { NativeHarnessAllocation, NativeHarnessFactories } from './runtimeFactory.js'

function binding(): ProviderAccountBinding {
  return { kind: 'slot', provider: 'codex', accountId: randomUUID(), profileRef: randomUUID(), bindingRevision: 1,
    subject: null, target: { hostRef: { kind: 'main', mainId: randomUUID() }, applicationInstallationId: randomUUID(),
      keyRevision: null, authorizationRevision: null } }
}
function fixture() {
  let generation = 1
  const allocations: NativeHarnessAllocation[] = []
  const discover = vi.fn(async (account: ProviderAccountBinding | undefined) => ({ providerVersion: 'test-release',
    models: [{ id: account?.accountId ?? 'legacy-model', name: 'Selected model',
      reasoningEfforts: [], variants: [], serviceTiers: [] }] }))
  const disposeAuxiliary = vi.fn(async () => undefined)
  const qualifyConfiguration = vi.fn(async () => {
    throw new DomainError('HARNESS_MODEL_UNAVAILABLE', 'The model is unavailable for the selected account.', 409)
  })
  const factories = { qualifyConfiguration, cacheIdentity: vi.fn(async (_harness: 'codex', _directory: string, _configuration?: HarnessConfiguration,
      account?: ProviderAccountBinding) =>
    JSON.stringify([account, generation])),
    allocate: (input: NativeHarnessAllocation) => {
      allocations.push(input)
      return { harness: 'codex', manager: { discoverModels: () => discover(input.accountBinding as ProviderAccountBinding) } }
    }, disposeAuxiliary }
  const service = new NativeConfigurationService('/native/codex', '/qualification', factories as unknown as NativeHarnessFactories)
  return { service, allocations, discover, disposeAuxiliary, qualifyConfiguration, changeInstallation: () => { generation++ } }
}

describe('account-scoped native observations', () => {
  it('keeps separate A/B model catalogs and accepted account selections', async () => {
    const f = fixture()
    const first = binding()
    const second = binding()
    expect((await f.service.options('codex', first)).models.map(model => model.id)).toEqual([first.accountId])
    expect((await f.service.options('codex', second)).models.map(model => model.id)).toEqual([second.accountId])
    expect((await f.service.options('codex', first)).models.map(model => model.id)).toEqual([first.accountId])
    expect(f.discover).toHaveBeenCalledTimes(2)
    expect(f.allocations.map(value => value.accountBinding)).toEqual([first, second])
    expect(f.disposeAuxiliary).toHaveBeenCalledTimes(2)
    await f.service.shutdownChecks()
  })

  it('invalidates observations for changed binary/configuration/environment/connection identity', async () => {
    const f = fixture()
    const account = binding()
    await f.service.options('codex', account)
    f.changeInstallation()
    await f.service.options('codex', account)
    await f.service.options('codex', { ...account, bindingRevision: 2, profileRef: randomUUID() })
    expect(f.discover).toHaveBeenCalledTimes(3)
    await f.service.shutdownChecks()
  })

  it('rejects a late native model result when the selected installation changes', async () => {
    const f = fixture()
    let entered!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    let finish!: (value: Awaited<ReturnType<typeof f.discover>>) => void
    const reply = new Promise<Awaited<ReturnType<typeof f.discover>>>(resolve => { finish = resolve })
    f.discover.mockImplementation(async () => { entered(); return reply })
    const pending = f.service.options('codex', binding())
    await started
    f.changeInstallation()
    finish({ providerVersion: 'test-release', models: [] })
    await expect(pending).rejects.toThrow('changed during discovery')
    await f.service.shutdownChecks()
  })

  it('rejects scoped Claude discovery when the selected native interface is unsupported', async () => {
    const f = fixture()
    await expect(f.service.options('claude', { ...binding(), provider: 'claude' }))
      .rejects.toThrow('Account-scoped Claude discovery is unavailable')
    expect(f.allocations).toHaveLength(0)
    await f.service.shutdownChecks()
  })
})


it('fails an unavailable selected model for B without retrying A or changing the model', async () => {
  const f = fixture()
  const first = binding()
  const second = binding()
  await f.service.options('codex', first)
  await f.service.options('codex', second)
  const configuration = CodexHarnessConfigurationSchema.parse({ harness: 'codex', accountId: second.accountId,
    model: first.accountId, reasoningEffort: 'medium', sandbox: 'read-only', serviceTier: 'standard' })
  await expect(f.service.qualifyConfiguration(configuration)).rejects.toThrow('unavailable for the selected account')
  expect(f.qualifyConfiguration).toHaveBeenCalledTimes(1)
  expect(f.qualifyConfiguration).toHaveBeenCalledWith(configuration, '/qualification', expect.anything())
  expect(f.allocations.map(value => value.accountBinding)).toEqual([first, second])
  await f.service.shutdownChecks()
})
