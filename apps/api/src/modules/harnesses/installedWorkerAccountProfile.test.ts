import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, withAdvancedDefaults } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import type { ResolvedProviderAccount } from '../provider-accounts/service.js'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import type { createInstalledNativeQualifier } from './installedNativeQualification.js'
import { createInstalledWorkerProfileChecks } from './installedWorkerProfileChecks.js'
import { codexQualificationSuite } from './qualification/suites/codex.js'
import { nativeQualification } from './nativeQualification.js'
import { DomainError } from '../errors.js'

const native = vi.hoisted(() => ({ qualify: vi.fn(), model: vi.fn(), command: vi.fn() }))
vi.mock('./codexProtocol.js', () => ({ qualifyCodex: native.qualify, assertCodexUnchanged: async () => {} }))
vi.mock('./process.js', () => ({ runCommand: native.command }))
vi.mock('./codexQualification.js', () => ({ qualifyNativeCodexModel: native.model }))
vi.mock('./installedNativeQualification.js', async () => {
  const { harnessConnectionGeneration } = await import('./hostConnectionGeneration.js')
  return {
    createInstalledNativeQualifier: (ports: Parameters<typeof createInstalledNativeQualifier>[0]) => ({
      qualify: async (profile: HostHarnessOverride, request: { signal: AbortSignal }) => {
        const result = await ports.checkConfiguration(profile, '/unused', request.signal, {} as never, async () => {})
        return { target: profile.target, instanceRevision: profile.instanceRevision,
          configurationFingerprint: profile.configurationFingerprint, driverId: 'codex', driverRevision: '1',
          protocolRevision: 'native', suiteRevision: 'profile', environmentGeneration: 'environment',
          connectionGeneration: harnessConnectionGeneration(ports.binding), authenticated: result.authenticated,
          compatible: result.structuredEvents, qualified: result.ready, checkedAt: new Date().toISOString() }
      }, close: async () => {},
    }),
  }
})

it('checks authentication and model support using the selected Worker account', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-account-profile-'))
  const connection = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    bootId: randomUUID(), connectionEpoch: 'connection', connectionGeneration: 1,
    keyRevision: 1, authorizationRevision: 1 }
  const accountId = randomUUID()
  const target = { hostRef: { kind: 'device' as const, mainId: connection.mainId, deviceId: connection.deviceId },
    applicationInstallationId: connection.workerInstallationId }
  const binding: ProviderAccountBinding = { kind: 'slot', accountId, provider: 'codex', target: { ...target, keyRevision: 1,
    authorizationRevision: 1 }, profileRef: accountId, bindingRevision: 1, subject: null }
  const account = { id: accountId, provider: 'codex', name: 'Selected account', authMode: 'subscription',
    isDefault: false, revision: 1, status: 'signed-in', identity: null, removedAt: null, binding }
  const slots = join(directory, 'provider-account-slots')
  await mkdir(slots, { mode: 0o700 })
  await writeFile(join(slots, `${accountId}.json`), JSON.stringify(account), { mode: 0o600 })
  const homePath = join(directory, 'selected', 'home')
  const resolve = vi.fn(async (): Promise<ResolvedProviderAccount> => ({ accountId, homePath, authMode: 'subscription', binding }))
  const configuration = { ...withAdvancedDefaults(DEFAULT_HARNESS_DEFAULTS.codex), accountId }
  const value = { instanceId: randomUUID(), instanceRevision: '1', revision: 1,
    target: { ...target, harnessInstallationId: 'codex', installationFingerprint: 'installed' },
    driverId: 'codex', presetId: 'codex', enabled: true, configuration,
    configurationFingerprint: commandInputHash(configuration), qualification: 'unqualified' } as HostHarnessOverride
  const path = join(directory, 'selection.json')
  await writeFile(path, JSON.stringify({ schemaVersion: 1, codexBinary: '/installed/codex',
    expectedVersion: 'codex-cli 0.161.0', payloadPaths: [], appMcpLauncher: '/installed/mcp' }), { mode: 0o600 })
  native.qualify.mockImplementation(async (binary, _cwd, environment) => {
    if (environment.CODEX_HOME !== homePath) throw new DomainError('CODEX_SIGNED_OUT', 'Default account signed out.', 409)
    return { binary, providerVersion: 'codex-cli 0.161.0' }
  })
  native.model.mockImplementation(async (settings, _binary, _cwd, environment) => {
    expect(environment.CODEX_HOME).toBe(homePath)
    expect(environment.HOME).toBe(join(directory, 'selected'))
    return nativeQualification(settings, 'codex-cli 0.161.0')
  })
  const checker = await createInstalledWorkerProfileChecks({ stateDirectory: directory,
    configuration: { path, ownerUid: process.getuid!() }, pairing: connection as never,
    current: () => connection, registry: {} as never, accounts: () => ({ resolve }) })
  try {
    await expect(checker!.extension.handle({ checkId: randomUUID(), override: value },
      { binding: connection, signal: new AbortController().signal }))
      .resolves.toMatchObject({ payload: { authenticated: true, qualified: true } })
    expect(resolve).toHaveBeenCalledWith('codex', accountId,
      expect.objectContaining({ acceptedBinding: binding, allowDefault: false }))
    native.model.mockRejectedValueOnce(new DomainError('CODEX_MODEL_UNAVAILABLE', 'Selected account lacks the model.', 409))
    await expect(checker!.extension.handle({ checkId: randomUUID(), override: value },
      { binding: connection, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'CODEX_MODEL_UNAVAILABLE' })
  } finally { await checker?.close(); await rm(directory, { recursive: true, force: true }) }
})


it('runs native lifecycle qualification with the selected account environment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'worker-native-account-'))
  const binary = join(directory, 'codex')
  const bytes = Buffer.from('owned-native-fixture')
  await writeFile(binary, bytes)
  const environment = { HOME: join(directory, 'account'), CODEX_HOME: join(directory, 'account', 'home') }
  native.command.mockImplementation(async (_binary, args, _cwd, _signal, actual) => {
    if (actual.CODEX_HOME !== environment.CODEX_HOME) throw new Error('Default account signed out')
    if (args[0] === '--version') return { exitCode: 0, stdout: 'codex-cli 0.161.0', stderr: '' }
    throw new Error('Fixture supplies no native schema')
  })
  try {
    const result = await codexQualificationSuite.run({ binary, version: '0.161.0',
      binarySha256: createHash('sha256').update(bytes).digest('hex'), profile: 'codex-0.156',
      model: 'model', workDirectory: directory, signal: new AbortController().signal, environment })
    expect(result.checks.find(check => check.id === 'version')).toMatchObject({ passed: true })
    expect(result.checks.find(check => check.id === 'schema')).toMatchObject({ passed: false })
  } finally { await rm(directory, { recursive: true, force: true }) }
})
