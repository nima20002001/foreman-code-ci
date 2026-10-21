import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { workerHarnessCatalogFixture } from '../../../test/helpers/workerHarnessCatalog.js'
import { createInstalledWorkerHarnessOptions } from './installedWorkerHarnessOptions.js'
import { readNativeCodexModelCatalog } from './codexModelCatalog.js'
import { qualifyCodex } from './codexProtocol.js'
import { loadOfficialClaudeSdk } from './claudeSdk/official.js'
import { DomainError } from '../errors.js'

const nativeAccount = vi.hoisted(() => ({ read: vi.fn<(environment: NodeJS.ProcessEnv) => Promise<Record<string, unknown>>>(async environment =>
  (await import('../../../test/helpers/workerHarnessCatalog.js')).catalogCodexAccount(environment)) }))

vi.mock('./codexStdioTransport.js', async importOriginal => ({
  ...await importOriginal<typeof import('./codexStdioTransport.js')>(),
  CodexStdioTransport: class {
    constructor(_binary: string, _cwd: string, private readonly environment: NodeJS.ProcessEnv) {}
    async start() {}
    request(method: string) {
      expect(method).toBe('account/read')
      return nativeAccount.read(this.environment)
    }
    async close() {}
  },
}))

vi.mock('./codexProtocol.js', async importOriginal => ({ ...await importOriginal<typeof import('./codexProtocol.js')>(),
  qualifyCodex: vi.fn((await import('../../../test/helpers/workerHarnessCatalog.js')).catalogCodexQualification),
  assertCodexUnchanged: async () => {} }))
vi.mock('./codexModelCatalog.js', async importOriginal => ({ ...await importOriginal<typeof import('./codexModelCatalog.js')>(),
  readNativeCodexModelCatalog: vi.fn((await import('../../../test/helpers/workerHarnessCatalog.js')).catalogCodexModels) }))
vi.mock('./claudeSdk/official.js', () => ({ loadOfficialClaudeSdk: vi.fn(async (profile: string) =>
  (await import('../../../test/helpers/workerHarnessCatalog.js')).catalogClaudeClient(profile)) }))
vi.mock('./process.js', async importOriginal => ({ ...await importOriginal<typeof import('./process.js')>(),
  runCommand: async () => ({ stdout: '2.1.284 (Claude Code)', stderr: '', exitCode: 0 }) }))

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers() })

it('keeps a shared catalog load alive when its first reader is cancelled', async () => {
  const f = await workerHarnessCatalogFixture()
  const catalog = createInstalledWorkerHarnessOptions(f.input)
  let finishNative!: (value: Awaited<ReturnType<typeof readNativeCodexModelCatalog>>) => void
  const native = new Promise<Awaited<ReturnType<typeof readNativeCodexModelCatalog>>>(resolve => { finishNative = resolve })
  vi.mocked(readNativeCodexModelCatalog).mockImplementationOnce(() => native)
  const controller = new AbortController()
  const first = catalog.discover(f.request('codex'), f.context(controller.signal))
  const firstRejected = expect(first).rejects.toThrow('First reader left')
  try {
    await vi.waitFor(() => expect(readNativeCodexModelCatalog).toHaveBeenCalledOnce())
    const secondController = new AbortController()
    const subscribe = vi.spyOn(secondController.signal, 'addEventListener')
    const second = catalog.discover(f.request('codex'), f.context(secondController.signal))
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledWith('abort', expect.any(Function), { once: true }))
    controller.abort(new Error('First reader left'))
    await firstRejected
    finishNative({ models: [{ slug: 'shared-model' }] })
    await expect(second).resolves.toMatchObject({ models: [{ id: 'shared-model' }] })
    expect(readNativeCodexModelCatalog).toHaveBeenCalledOnce()
  } finally {
    finishNative({ models: [] })
    await catalog.close()
    await f.close()
  }
})

it.each(['codex', 'claude'] as const)('changes the native %s catalog when its login changes before cache expiry', async harness => {
  const f = await workerHarnessCatalogFixture()
  const catalog = createInstalledWorkerHarnessOptions(f.input)
  try {
    await expect(catalog.discover(f.request(harness), f.context()))
      .resolves.toMatchObject({ authenticated: true, models: [{ id: 'first-model' }] })
    await expect(catalog.discover(f.request(harness), f.context()))
      .resolves.toMatchObject({ models: [{ id: 'first-model' }] })
    const reads = harness === 'codex' ? vi.mocked(readNativeCodexModelCatalog) : vi.mocked(loadOfficialClaudeSdk)
    expect(reads).toHaveBeenCalledOnce()
    await f.setLogin(harness, 'second')
    await expect(catalog.discover(f.request(harness), f.context()))
      .resolves.toMatchObject({ authenticated: true, models: [{ id: 'second-model' }] })
    expect(reads).toHaveBeenCalledTimes(2)
    await f.setLogin(harness, null)
    const signedOut = catalog.discover(f.request(harness), f.context())
    if (harness === 'codex') await expect(signedOut).rejects.toMatchObject({ code: 'CODEX_SIGNED_OUT' })
    else await expect(signedOut).resolves.toMatchObject({ authenticated: false, models: [] })
  } finally { await catalog.close(); await f.close() }
})

it.each(['codex', 'claude'] as const)('does not retain a stale %s success after authentication refresh fails', async harness => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const f = await workerHarnessCatalogFixture()
  const catalog = createInstalledWorkerHarnessOptions(f.input)
  try {
    await expect(catalog.discover(f.request(harness), f.context()))
      .resolves.toMatchObject({ authenticated: true, models: [{ id: 'first-model' }] })
    vi.setSystemTime(Date.now() + 300_001)
    const failure = new DomainError('PROVIDER_AUTHENTICATION_REQUIRED', 'The native session expired.', 409)
    if (harness === 'codex') vi.mocked(qualifyCodex).mockRejectedValue(failure)
    else vi.mocked(loadOfficialClaudeSdk).mockRejectedValue(failure)
    await expect(catalog.discover(f.request(harness), f.context())).rejects.toBe(failure)
    await expect(catalog.discover(f.request(harness), f.context())).rejects.toBe(failure)
  } finally { await catalog.close(); await f.close() }
})

it('invalidates a keyring catalog after account switches and sign-out without credential file changes', async () => {
  const f = await workerHarnessCatalogFixture()
  await writeFile(join(f.homes.codex, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n')
  await rm(join(f.homes.codex, 'auth.json'))
  const before = await readFile(join(f.homes.codex, 'config.toml'), 'utf8')
  let subject: string | null = 'first'
  vi.mocked(qualifyCodex).mockImplementation(async () => {
    if (!subject) throw new DomainError('CODEX_SIGNED_OUT', 'The selected keyring login is signed out.', 409)
    return { binary: f.selection.codexBinary, providerVersion: 'codex-cli 0.162.0' } as never
  })
  vi.mocked(readNativeCodexModelCatalog).mockImplementation(async () => ({ models: [{ slug: `${subject}-model` }] }))
  nativeAccount.read.mockImplementation(async () => ({
    account: subject ? { type: 'chatgpt', email: 'reader@example.test', planType: 'plus' } : null,
    requiresOpenaiAuth: true, workspaceRouting: subject ? { chatgptAccountId: subject,
      backendOrigin: 'https://provider.example', accountRoutingOverride: 'NO_CONSTRAINT' } : null,
  }))
  const catalog = createInstalledWorkerHarnessOptions(f.input)
  try {
    await expect(catalog.discover(f.request('codex'), f.context()))
      .resolves.toMatchObject({ authenticated: true, models: [{ id: 'first-model' }] })
    await expect(catalog.discover(f.request('codex'), f.context()))
      .resolves.toMatchObject({ models: [{ id: 'first-model' }] })
    expect(readNativeCodexModelCatalog).toHaveBeenCalledOnce()
    subject = 'second'
    await expect(catalog.discover(f.request('codex'), f.context()))
      .resolves.toMatchObject({ authenticated: true, models: [{ id: 'second-model' }] })
    expect(readNativeCodexModelCatalog).toHaveBeenCalledTimes(2)
    subject = null
    await expect(catalog.discover(f.request('codex'), f.context())).rejects.toMatchObject({ code: 'CODEX_SIGNED_OUT' })
    expect(await readFile(join(f.homes.codex, 'config.toml'), 'utf8')).toBe(before)
    await expect(readFile(join(f.homes.codex, 'auth.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await catalog.close(); await f.close() }
})

it('single-flights authentication checks for concurrent cached catalog reads', async () => {
  const f = await workerHarnessCatalogFixture()
  const catalog = createInstalledWorkerHarnessOptions(f.input)
  try {
    await catalog.discover(f.request('codex'), f.context())
    nativeAccount.read.mockClear()
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      catalog.discover(f.request('codex'), f.context())))
    for (const result of results) expect(result.models).toMatchObject([{ id: 'first-model' }])
    expect(nativeAccount.read).toHaveBeenCalledTimes(2)
    expect(readNativeCodexModelCatalog).toHaveBeenCalledOnce()
  } finally { await catalog.close(); await f.close() }
})

it('does not reuse catalogs across workspaces when older native readback omits workspace identity', async () => {
  const f = await workerHarnessCatalogFixture()
  await writeFile(join(f.homes.codex, 'config.toml'), 'cli_auth_credentials_store = "keyring"\n')
  await rm(join(f.homes.codex, 'auth.json'))
  let workspace = 'first'
  vi.mocked(qualifyCodex).mockResolvedValue({ binary: f.selection.codexBinary,
    providerVersion: 'codex-cli 0.154.0' } as never)
  nativeAccount.read.mockResolvedValue({ account: { type: 'chatgpt', email: 'reader@example.test', planType: 'plus' },
    requiresOpenaiAuth: true })
  vi.mocked(readNativeCodexModelCatalog).mockImplementation(async () => ({ models: [{ slug: `${workspace}-model` }] }))
  const catalog = createInstalledWorkerHarnessOptions(f.input)
  try {
    await expect(catalog.discover(f.request('codex'), f.context()))
      .resolves.toMatchObject({ models: [{ id: 'first-model' }] })
    workspace = 'second'
    const results = await Promise.all(Array.from({ length: 8 }, () =>
      catalog.discover(f.request('codex'), f.context())))
    for (const result of results) expect(result.models).toMatchObject([{ id: 'second-model' }])
    expect(readNativeCodexModelCatalog).toHaveBeenCalledTimes(2)
  } finally { await catalog.close(); await f.close() }
})
