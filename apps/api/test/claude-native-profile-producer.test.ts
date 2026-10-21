import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import type { RegistryHarnessSelection } from '../src/modules/harnesses/installationRegistry.js'
import type { ClaudeSdkClient } from '../src/modules/harnesses/claudeSdk/port.js'
import { qualifyClaudeNativeProfile } from '../src/modules/harnesses/claudeSdk/nativeProfileQualification.js'
import { ClaudeBoundedQueue } from '../src/modules/harnesses/claudeSdk/queue.js'

const directories: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function fixture(models: unknown[], emitReceipt = false) {
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/unit/profile')
  const directory = await mkdtemp(join(tmpdir(), 'claude-producer-unit-')); directories.push(directory)
  const configuration = { harness: 'claude' as const, model: 'unit-model', effort: 'medium' as const, configDirectory: '/unit/profile',
    authMode: 'subscription' as const, permissionMode: 'default' as const, sandbox: 'danger-full-access' as const, tools: ['Write'], permissionRules: [], instructions: '', mcpServers: {} }
  const target = { hostRef: { kind: 'main' as const, mainId: '00000000-0000-4000-8000-000000000001' }, applicationInstallationId: '00000000-0000-4000-8000-000000000001', harnessInstallationId: 'unit-installation', installationFingerprint: 'unit-fingerprint' }
  const value: HostHarnessOverride = { instanceId: 'unit-profile', instanceRevision: '1', revision: 1, target, presetId: 'unit', enabled: true,
    driverId: 'claude', configuration, configurationFingerprint: 'unit-configuration', qualification: 'unqualified' }
  const binding = { installation: { driverRevision: '1', protocolRevision: 'unit-protocol', environmentGeneration: 'unit-env', connectionGeneration: 'unit-connection', launcher: { resolvedLauncher: '/unit/claude' } } } as RegistryHarnessSelection
  const offered = vi.fn(), close = vi.fn(), frames = new ClaudeBoundedQueue<unknown>(10)
  const environments: unknown[] = []
  const client: ClaudeSdkClient = { sdkVersion: '0.3.284', getSessionInfo: async sessionId => ({ sessionId }), getSessionMessages: async () => [], forkSession: async () => ({ sessionId: 'fork' }),
    query(input) {
      environments.push(input.options.env)
      void (async () => { for await (const prompt of input.prompt) {
        offered(prompt)
        if (emitReceipt) void frames.offer({ type: 'result', subtype: 'success', is_error: false, session_id: 'synthetic-unit-session',
          user_message_uuid: prompt.uuid, uuid: 'synthetic-result', result: 'Unrelated output' })
        frames.close()
      } })()
      return { [Symbol.asyncIterator]: () => frames[Symbol.asyncIterator](), initializationResult: async () => ({ models }),
        interrupt: async () => {}, close() { close(); frames.close() }, joinClosed: async () => {} }
    } }
  const loadClient = vi.fn(async () => client)
  return { offered, close, environments, value, input: { value, checkId: 'synthetic-unit-check', binding,
    pin: { sdkVersion: '0.3.284', sdkIntegrity: 'unit-integrity', cliVersion: '2.1.284', executableSha256: 'a'.repeat(64), profilePath: '/unit/profile', configRevision: '1' },
    directory, recovery: { root: directory, owner: 'unit-producer' }, signal: AbortSignal.timeout(3000), assertCurrent: async () => {}, loadClient } }
}

it('qualifies the selected profile without inheriting the API process profile or credentials', async () => {
  const f = await fixture([{ value: 'unit-model', supportedEffortLevels: ['medium'] }])
  vi.stubEnv('CLAUDE_CONFIG_DIR', '/other/profile')
  vi.stubEnv('ANTHROPIC_API_KEY', 'inherited-key')
  const result = await qualifyClaudeNativeProfile(f.input)
  expect(result).toMatchObject({ qualified: false, failure: { code: 'CLAUDE_NATIVE_RECEIPT_UNQUALIFIED' } })
  expect(f.input.loadClient).toHaveBeenCalledWith('/unit/profile', f.input.recovery, '/unit/claude', undefined)
  expect(f.environments).toHaveLength(1)
  expect(f.environments[0]).toMatchObject({ CLAUDE_CONFIG_DIR: '/unit/profile' })
  expect(f.environments[0]).not.toHaveProperty('ANTHROPIC_API_KEY')
  expect(process.env.CLAUDE_CONFIG_DIR).toBe('/other/profile')
})

it('does not turn initialization/model metadata into basic, auth or full-access proof', async () => {
  const f = await fixture([{ value: 'unit-model', supportedEffortLevels: ['medium'] }])
  const result = await qualifyClaudeNativeProfile(f.input)
  expect(result).toMatchObject({ authenticated: false, compatible: true, qualified: false, failure: { code: 'CLAUDE_NATIVE_RECEIPT_UNQUALIFIED' } })
  expect(result.claudeProof?.checks.sdkInitialization?.state).toBe('passed')
  expect(result.claudeProof?.checks.firstSecondTurn?.state).toBe('unverified')
  expect(result.claudeProof?.checks.fullAccessPolicy?.state).toBe('unverified')
  expect(f.close).toHaveBeenCalled()
})

it('loads the explicitly selected installed SDK during profile qualification', async () => {
  const f = await fixture([{ value: 'unit-model', supportedEffortLevels: ['medium'] }])
  const sdkEntrypoint = '/installed/claude/sdk.mjs'
  const loadClient = vi.fn(async (_profile: string, _recovery: unknown, _binary: string, selected?: string) => {
    if (selected !== sdkEntrypoint) throw new Error('The selected installed SDK was not used')
    return f.input.loadClient()
  })
  const result = await qualifyClaudeNativeProfile({ ...f.input, sdkEntrypoint, loadClient })
  expect(result).toMatchObject({ qualified: false, failure: { code: 'CLAUDE_NATIVE_RECEIPT_UNQUALIFIED' } })
  expect(f.offered).toHaveBeenCalledOnce()
  expect(f.close).toHaveBeenCalled()
})

it('rejects an unavailable accepted effort before offering any model input', async () => {
  const f = await fixture([{ value: 'unit-model', supportedEffortLevels: ['high'] }])
  const result = await qualifyClaudeNativeProfile(f.input)
  expect(result).toMatchObject({ qualified: false, failure: { code: 'CLAUDE_MODEL_UNAVAILABLE' } })
  expect(f.offered).not.toHaveBeenCalled()
})

it('accepts the exact resolved Haiku model with native-default effort without claiming qualification', async () => {
  const f = await fixture([{ value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', supportedEffortLevels: [] }])
  if (f.value.configuration.harness !== 'claude') throw new Error('Expected Claude fixture')
  f.value.configuration.model = 'claude-haiku-4-5-20251001'
  delete f.value.configuration.effort
  const result = await qualifyClaudeNativeProfile(f.input)
  expect(result).toMatchObject({ qualified: false, failure: { code: 'CLAUDE_NATIVE_RECEIPT_UNQUALIFIED' } })
  expect(result.claudeProof?.checks.sdkInitialization?.state).toBe('passed')
  expect(f.offered).toHaveBeenCalledOnce()
})

it('rejects an explicit Haiku effort absent from its native catalog before offering model input', async () => {
  const f = await fixture([{ value: 'haiku', resolvedModel: 'claude-haiku-4-5-20251001', supportedEffortLevels: [] }])
  if (f.value.configuration.harness !== 'claude') throw new Error('Expected Claude fixture')
  f.value.configuration.model = 'claude-haiku-4-5-20251001'
  const result = await qualifyClaudeNativeProfile(f.input)
  expect(result).toMatchObject({ qualified: false, failure: { code: 'CLAUDE_MODEL_UNAVAILABLE' } })
  expect(f.offered).not.toHaveBeenCalled()
})

it('does not accept a receipt whose actual answer failed the recorded marker scenario', async () => {
  const f = await fixture([{ value: 'unit-model', supportedEffortLevels: ['medium'] }], true)
  const result = await qualifyClaudeNativeProfile(f.input)
  expect(result.qualified).toBe(false)
  expect(result.claudeProof?.checks.firstSecondTurn?.state).toBe('unverified')
  expect(result.claudeProof?.checks.exactResume?.state).toBe('unverified')
})
