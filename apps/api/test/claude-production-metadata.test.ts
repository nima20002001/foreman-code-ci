import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import type { RegistryHarnessSelection } from '../src/modules/harnesses/installationRegistry.js'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { NativeConfigurationService } from '../src/modules/harnesses/nativeConfiguration.js'
import { productionClaudeMetadata } from '../src/modules/harnesses/claudeSdk/productionMetadata.js'
import { discoverClaudeMetadata } from '../src/modules/harnesses/claudeSdk/metadata.js'

vi.mock('../src/modules/harnesses/claudeSdk/metadata.js', () => ({ discoverClaudeMetadata: vi.fn() }))
afterEach(() => vi.resetAllMocks())

const configuration = { harness: 'claude' as const, model: 'observed-model', authMode: 'subscription' as const,
  configDirectory: '/profile', permissionMode: 'default' as const, sandbox: 'read-only' as const,
  tools: [], permissionRules: [], instructions: '', mcpServers: {} }
const metadata = { providerVersion: 'sdk-version', authenticated: true, nativeAgents: [],
  models: [{ id: 'observed-model', reasoningEfforts: [], variants: [], serviceTiers: [] }] }

function fixture() {
  const binding = { selection: { hostRef: { kind: 'main', mainId: 'current-host' }, instanceId: 'profile', instanceRevision: '1',
    driverId: 'claude', harnessInstallationId: 'installed-sdk', installationFingerprint: 'fingerprint' }, inventoryRevision: 1,
    installation: { launcher: { resolvedLauncher: '/installed/claude' }, environmentGeneration: 'env-1', connectionGeneration: 'connection-1' } }
  const defaults = vi.fn(async () => ({ ...DEFAULT_HARNESS_DEFAULTS, claude: configuration }))
  const pinAccepted = vi.fn(() => structuredClone(binding))
  const assertCurrent = vi.fn()
  const observeClaudeVersion = vi.fn(async () => ({ version: 'native-version' }))
  const reserveLaunch = vi.fn((owner: string) => ({ root: '/owned-recovery', owner }))
  const abandonReservedLaunch = vi.fn(async () => {})
  const closeOwner = vi.fn(async () => true)
  const input = { defaults, registry: { pinAccepted, installations: { assertCurrent } },
    factories: { observeClaudeVersion }, processes: { reserveLaunch, abandonReservedLaunch, closeOwner }, settings: {}, current: vi.fn() }
  const port = productionClaudeMetadata(input as unknown as Parameters<typeof productionClaudeMetadata>[0])
  return { ...input, binding, port }
}

function delayed() {
  let finish!: (value: typeof metadata) => void
  const value = new Promise<typeof metadata>(resolve => { finish = resolve })
  vi.mocked(discoverClaudeMetadata).mockReturnValueOnce(value)
  return finish
}

it('shares identical pending production discoveries, reuses the result for the same profile, and refreshes on request', async () => {
  const f = fixture(), finish = delayed()
  const service = new NativeConfigurationService('unused', '/workspace', undefined, f.port)
  try {
    const first = service.options('claude'), second = service.options('claude')
    await vi.waitFor(() => expect(discoverClaudeMetadata).toHaveBeenCalledOnce())
    expect(f.defaults).toHaveBeenCalledTimes(2)
    expect(f.registry.pinAccepted).toHaveBeenCalledTimes(2)
    finish(metadata)
    const results = await Promise.all([first, second])
    expect(results[0]).toMatchObject({ providerVersion: 'native-version', models: metadata.models })
    expect(results[1]).toMatchObject({ providerVersion: 'native-version', models: metadata.models })
    expect(f.factories.observeClaudeVersion).toHaveBeenCalledOnce()
    expect(f.processes.closeOwner).toHaveBeenCalledOnce()
    expect(await service.options('claude')).toMatchObject({ providerVersion: 'native-version', models: metadata.models })
    expect(discoverClaudeMetadata).toHaveBeenCalledOnce()
    expect(f.defaults).toHaveBeenCalledTimes(3)
    vi.mocked(discoverClaudeMetadata).mockResolvedValueOnce({ ...metadata, authenticated: false })
    expect(await service.refreshOptions('claude')).toMatchObject({ authenticated: false })
    expect(discoverClaudeMetadata).toHaveBeenCalledTimes(2)
  } finally { await service.shutdownChecks() }
})

it('discovers again when the default profile changes, and rejects a cached result for a stale host', async () => {
  const f = fixture()
  vi.mocked(discoverClaudeMetadata).mockResolvedValueOnce(metadata)
  await f.port.discover('/workspace', AbortSignal.timeout(3000))
  f.defaults.mockResolvedValue({ ...DEFAULT_HARNESS_DEFAULTS, claude: { ...configuration, model: 'other-model' } })
  vi.mocked(discoverClaudeMetadata).mockResolvedValueOnce({ ...metadata, models: [{ ...metadata.models[0]!, id: 'other-model' }] })
  expect(await f.port.discover('/workspace', AbortSignal.timeout(3000))).toMatchObject({ models: [{ id: 'other-model' }] })
  expect(vi.mocked(discoverClaudeMetadata).mock.calls[1]![0]).toMatchObject({ model: 'other-model' })
  f.registry.installations.assertCurrent.mockImplementation(() => { throw new Error('stale selected host') })
  await expect(f.port.discover('/workspace', AbortSignal.timeout(3000))).rejects.toThrow('stale selected host')
  expect(discoverClaudeMetadata).toHaveBeenCalledTimes(2)
})

it('serves an expired result immediately while one background discovery refreshes it', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const f = fixture(), finish = (vi.mocked(discoverClaudeMetadata).mockResolvedValueOnce(metadata), delayed())
    await f.port.discover('/workspace', AbortSignal.timeout(3000))
    vi.setSystemTime(Date.now() + 300_000)
    expect(await f.port.discover('/workspace', AbortSignal.timeout(3000))).toMatchObject({ authenticated: true })
    expect(await f.port.discover('/workspace', AbortSignal.timeout(3000))).toMatchObject({ authenticated: true })
    await vi.waitFor(() => expect(discoverClaudeMetadata).toHaveBeenCalledTimes(2))
    finish({ ...metadata, authenticated: false })
    await vi.waitFor(async () => expect(await f.port.discover('/workspace', AbortSignal.timeout(3000))).toMatchObject({ authenticated: false }))
    expect(discoverClaudeMetadata).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})

it('keeps serving the last good result when a background refresh fails', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    const f = fixture()
    vi.mocked(discoverClaudeMetadata).mockResolvedValueOnce(metadata)
    await f.port.discover('/workspace', AbortSignal.timeout(3000))
    vi.setSystemTime(Date.now() + 300_000)
    vi.mocked(discoverClaudeMetadata).mockRejectedValue(new Error('discovery timed out'))
    expect(await f.port.discover('/workspace', AbortSignal.timeout(3000))).toMatchObject({ authenticated: true })
    await vi.waitFor(() => expect(discoverClaudeMetadata).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(f.processes.closeOwner).toHaveBeenCalledTimes(2))
    expect(await f.port.discover('/workspace', AbortSignal.timeout(3000))).toMatchObject({ authenticated: true,
      models: [expect.objectContaining({ id: 'observed-model' })] })
  } finally { vi.useRealTimers() }
})

it.each(['profile', 'installation', 'host', 'inventory', 'directory'] as const)('does not share overlapping discoveries when the %s changes', async change => {
  const f = fixture(), firstFinish = delayed(), secondFinish = delayed()
  const first = f.port.discover('/workspace', AbortSignal.timeout(3000))
  await vi.waitFor(() => expect(discoverClaudeMetadata).toHaveBeenCalledOnce())
  if (change === 'profile') f.defaults.mockResolvedValue({ ...DEFAULT_HARNESS_DEFAULTS, claude: { ...configuration, configDirectory: '/other-profile' } })
  if (change === 'installation') f.binding.installation.connectionGeneration = 'connection-2'
  if (change === 'host') f.binding.selection.hostRef.mainId = 'other-host'
  if (change === 'inventory') f.binding.inventoryRevision = 2
  const second = f.port.discover(change === 'directory' ? '/other-workspace' : '/workspace', AbortSignal.timeout(3000))
  await vi.waitFor(() => expect(discoverClaudeMetadata).toHaveBeenCalledTimes(2))
  firstFinish(metadata); secondFinish(metadata)
  await Promise.all([first, second])
  expect(f.processes.closeOwner).toHaveBeenCalledTimes(2)
})

it('rejects shared stale-host results and performs a new discovery after failure', async () => {
  const f = fixture(), finish = delayed()
  const first = f.port.discover('/workspace', AbortSignal.timeout(3000)), second = f.port.discover('/workspace', AbortSignal.timeout(3000))
  const rejected = Promise.allSettled([first, second])
  await vi.waitFor(() => expect(discoverClaudeMetadata).toHaveBeenCalledOnce())
  f.registry.installations.assertCurrent.mockImplementation(() => { throw new Error('stale selected host') })
  finish(metadata)
  expect(await rejected).toEqual([expect.objectContaining({ status: 'rejected' }), expect.objectContaining({ status: 'rejected' })])
  expect(f.processes.closeOwner).toHaveBeenCalledOnce()
  f.registry.installations.assertCurrent.mockReset()
  vi.mocked(discoverClaudeMetadata).mockResolvedValueOnce(metadata)
  await f.port.discover('/workspace', AbortSignal.timeout(3000))
  expect(discoverClaudeMetadata).toHaveBeenCalledTimes(2)
})

it('cancels one reader without canceling another reader of the same native discovery', async () => {
  const f = fixture(), finish = delayed(), controller = new AbortController()
  const first = f.port.discover('/workspace', controller.signal), second = f.port.discover('/workspace', AbortSignal.timeout(3000))
  const rejected = expect(first).rejects.toThrow('caller cancelled')
  await vi.waitFor(() => expect(discoverClaudeMetadata).toHaveBeenCalledOnce())
  controller.abort(new Error('caller cancelled'))
  await rejected
  expect(vi.mocked(discoverClaudeMetadata).mock.calls[0]![0].signal.aborted).toBe(false)
  finish(metadata)
  await second
  expect(f.processes.closeOwner).toHaveBeenCalledOnce()
})

it('cancels native discovery when its last reader leaves, and does not reuse the cancelled operation', async () => {
  const f = fixture(), controller = new AbortController()
  vi.mocked(discoverClaudeMetadata).mockImplementationOnce(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }))
  const first = f.port.discover('/workspace', controller.signal)
  const rejected = expect(first).rejects.toThrow('caller cancelled')
  await vi.waitFor(() => expect(discoverClaudeMetadata).toHaveBeenCalledOnce())
  controller.abort(new Error('caller cancelled'))
  await rejected
  expect(vi.mocked(discoverClaudeMetadata).mock.calls[0]![0].signal.aborted).toBe(true)
  expect(f.processes.closeOwner).toHaveBeenCalledOnce()
  vi.mocked(discoverClaudeMetadata).mockResolvedValueOnce(metadata)
  await f.port.discover('/workspace', AbortSignal.timeout(3000))
  expect(discoverClaudeMetadata).toHaveBeenCalledTimes(2)
})

it('never returns discovery success when owned process closure is unconfirmed', async () => {
  const f = fixture()
  vi.mocked(discoverClaudeMetadata).mockResolvedValueOnce(metadata)
  f.processes.closeOwner.mockResolvedValue(false)
  await expect(f.port.discover('/workspace', AbortSignal.timeout(3000))).rejects.toThrow('closure is unconfirmed')
})

it('discovers account models through that account\'s selected installation and retains owned cleanup', async () => {
  const f = fixture()
  const mainId = randomUUID()
  const account: ProviderAccountBinding = { kind: 'slot', provider: 'claude', accountId: randomUUID(),
    profileRef: 'selected-profile', bindingRevision: 1, subject: null,
    target: { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId,
      keyRevision: null, authorizationRevision: null } }
  const selectAccount = vi.fn(() => ({ ...f.binding,
    selection: { ...f.binding.selection, hostRef: account.target.hostRef },
    installation: { ...f.binding.installation, launcher: { resolvedLauncher: '/fixture/selected-claude' } },
  } as unknown as RegistryHarnessSelection))
  const port = productionClaudeMetadata({ ...f, selectAccount, accounts: { resolve: async () => ({
    accountId: account.accountId, homePath: '/fixture/selected-profile', authMode: 'subscription', binding: account,
  }) } } as unknown as Parameters<typeof productionClaudeMetadata>[0])
  vi.mocked(discoverClaudeMetadata).mockResolvedValueOnce(metadata)
  expect(await port.discoverAccount('/workspace', AbortSignal.timeout(3000), account)).toMatchObject({ models: metadata.models })
  expect(selectAccount).toHaveBeenCalledWith(account)
  expect(f.registry.pinAccepted).not.toHaveBeenCalled()
  expect(vi.mocked(discoverClaudeMetadata).mock.calls[0]![0]).toMatchObject({
    binary: '/fixture/selected-claude', profilePath: '/fixture/selected-profile', accountId: account.accountId,
  })
  expect(f.processes.closeOwner).toHaveBeenCalledOnce()
})
