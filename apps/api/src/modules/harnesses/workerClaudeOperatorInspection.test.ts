import { beforeEach, expect, it, vi } from 'vitest'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import { CLAUDE_QUALIFICATION_CHECKS } from '@foreman-code/contracts/claude-qualification'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { HostHarnessOverrideSchema, HostHarnessProfileEvidenceSchema } from '@foreman-code/contracts/harness-registry'
import { createInstalledClaudeOperatorInspection } from './installedClaudeOperatorInspection.js'
import { inspectInstalledClaude, type InstalledClaudeTarget } from './installedClaudeInspection.js'
import { createHostHarnessProfileCheckExtension } from './instanceSettings/profileChannel.js'
import { inspectWorkerClaudeOperatorConfiguration } from './workerClaudeOperatorInspection.js'
import { harnessConnectionGeneration } from './hostConnectionGeneration.js'
import { loadOfficialClaudeSdk } from './claudeSdk/official.js'
import type { ClaudeSdkClient, ClaudeSdkUserMessage } from './claudeSdk/port.js'
import type { AcceptedClaudeProfile } from './instanceSettings/acceptedProfile.js'
import type { NativeProcessRegistry } from './recovery/processRegistry.js'
import { CLAUDE_PROFILE_CHECK_REVISION } from './claudeSdk/profileRevision.js'
import { previousWorkerHarnessGeneration } from '../../../test/support/previousWorkerHarness.js'

vi.mock('./installedClaudeInspection.js', () => ({ inspectInstalledClaude: vi.fn() }))
vi.mock('./claudeSdk/official.js', () => ({ loadOfficialClaudeSdk: vi.fn() }))
beforeEach(() => vi.clearAllMocks())

function fixture() {
  const endpointUrl = 'https://main.example/mcp'
  const binding: DeviceSessionBinding = {
    mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222',
    workerInstallationId: '33333333-3333-4333-8333-333333333333',
    bootId: '44444444-4444-4444-8444-444444444444', keyRevision: 1, authorizationRevision: 1,
    connectionEpoch: '77777777-7777-4777-8777-777777777777', connectionGeneration: 1,
  }
  let current = binding
  const hostRef = { kind: 'device' as const, mainId: binding.mainId, deviceId: binding.deviceId }
  const configuration = { harness: 'claude' as const, model: 'worker-model', authMode: 'subscription' as const,
    configDirectory: '/worker/claude-profile', permissionMode: 'default' as const, sandbox: 'danger-full-access' as const,
    tools: ['Read'], permissionRules: [], instructions: 'Saved Operator instructions',
    mcpServers: { 'foreman-code': { type: 'http' as const, url: endpointUrl } } }
  const override = HostHarnessOverrideSchema.parse({
    instanceId: '55555555-5555-4555-8555-555555555555', revision: 1, instanceRevision: '1',
    target: { hostRef, applicationInstallationId: binding.workerInstallationId,
      harnessInstallationId: 'worker-claude', installationFingerprint: 'worker-payload' },
    presetId: 'claude', enabled: true, driverId: 'claude', configuration,
    configurationFingerprint: commandInputHash(withAdvancedDefaults(configuration)), qualification: 'qualified',
  })
  const pin = { sdkVersion: '0.3.284', sdkIntegrity: 'sha512-YQ==', cliVersion: '2.1.284',
    executableSha256: 'a'.repeat(64), profilePath: configuration.configDirectory, configRevision: '1' }
  const proof = HostHarnessProfileEvidenceSchema.parse({ target: override.target, instanceRevision: '1',
    configurationFingerprint: override.configurationFingerprint, driverId: 'claude', driverRevision: '1',
    protocolRevision: 'claude-sdk-0.3.284', suiteRevision: CLAUDE_PROFILE_CHECK_REVISION,
    environmentGeneration: 'worker-environment', connectionGeneration: harnessConnectionGeneration(binding),
    authenticated: true, compatible: true, qualified: true, checkedAt: new Date().toISOString(),
    claudeProof: { pin, observedTools: ['Read'], checks: Object.fromEntries(CLAUDE_QUALIFICATION_CHECKS.map(check =>
      [check, { state: 'passed', source: 'native_scenario', evidenceId: check, evidenceSha256: 'b'.repeat(64) }])) },
  })
  const accepted: AcceptedClaudeProfile = { override, persistedProof: proof,
    currentBinding: { ...proof, instanceId: override.instanceId, pin } }
  let installed: InstalledClaudeTarget = { binding, target: override.target,
    sdk: { entrypoint: '/worker/sdk/index.mjs', installedLockPath: '/worker/installed-lock.yaml',
      selectedExecutable: '/worker/bin/claude' },
    installation: { hostRef, harnessInstallationId: 'worker-claude', installationFingerprint: 'worker-payload',
      driverId: 'claude', driverRevision: '1', protocolRevision: proof.protocolRevision,
      environmentGeneration: proof.environmentGeneration, connectionGeneration: proof.connectionGeneration,
      observedVersion: null, installed: true, authenticated: null, compatible: null, qualified: false,
      claudeSdk: { version: pin.sdkVersion, integrity: pin.sdkIntegrity },
      launcher: { requested: '/worker/bin/claude', resolvedLauncher: '/worker/bin/claude', fingerprint: 'worker-payload',
        payloadFingerprints: [{ path: '/worker/bin/claude', fingerprint: pin.executableSha256 }],
        status: 'installed', interpreter: null, diagnostics: [], checkedAt: proof.checkedAt,
        environment: { generation: proof.environmentGeneration, provenance: 'worker', cwd: '/worker/state', path: '/usr/bin' } },
    } }
  vi.mocked(inspectInstalledClaude).mockImplementation(async () => ({
    inventory: { instances: [], installations: [installed.installation] }, currentTarget: installed,
  }))
  const inputs: ClaudeSdkUserMessage[] = []
  const queries: Parameters<ClaudeSdkClient['query']>[0][] = []
  const nativeClose = vi.fn()
  let afterStatus = () => {}
  vi.mocked(loadOfficialClaudeSdk).mockImplementation(async () => ({ sdkVersion: pin.sdkVersion,
    query(input: Parameters<ClaudeSdkClient['query']>[0]) {
      queries.push(input)
      const reading = (async () => { for await (const message of input.prompt) inputs.push(message) })()
      return {
        async *[Symbol.asyncIterator]() {},
        interrupt: async () => {}, initializationResult: async () => ({}),
        mcpServerStatus: async () => {
          afterStatus()
          return [{ name: 'foreman-code', status: 'needs-auth', config: { type: 'http', url: endpointUrl } }]
        },
        close: nativeClose, joinClosed: async () => { await reading },
      }
    },
    getSessionInfo: async () => undefined, getSessionMessages: async () => [],
    forkSession: async () => { throw new Error('Configuration inspection cannot fork') },
  }))
  const closeOwner = vi.fn(async () => true)
  const abandon = vi.fn(async () => {})
  const registry = { reserveLaunch: async (owner: string) => ({ owner, root: '/worker/registry', launchId: 'inspection-launch' }),
    abandonReservedLaunch: abandon, closeOwner } as unknown as NativeProcessRegistry
  const inspection = createInstalledClaudeOperatorInspection({ stateDirectory: '/worker/state', configuration: null,
    current: () => current, registry })
  const qualify = vi.fn(async () => proof)
  const extension = createHostHarnessProfileCheckExtension({ hostRef, applicationInstallationId: binding.workerInstallationId,
    qualifierForBinding: () => ({ qualify }), inspectConfiguration: inspection.inspect })
  const request = vi.fn(async (payload: unknown) => extension.handle(payload, { binding, signal: new AbortController().signal }))
  const captureRequest = vi.fn(() => ({ binding, request }))
  const revalidate = vi.fn(async () => {})
  const inspect = () => inspectWorkerClaudeOperatorConfiguration({ accepted,
    endpoint: { captureRequest, currentBinding: () => current, clockReason: () => null },
    expectedEndpoint: endpointUrl, signal: new AbortController().signal, revalidate })
  return { accepted, inspect, inspection, binding, endpointUrl, request, captureRequest, revalidate,
    queries, inputs, nativeClose, closeOwner, abandon, qualify,
    replaceConnection: () => { current = { ...binding, connectionEpoch: 'replacement', connectionGeneration: 2 } },
    replaceSdk: () => { installed = { ...installed, installation: { ...installed.installation,
      claudeSdk: { version: '0.3.285', integrity: pin.sdkIntegrity } } } },
    afterStatus: (callback: () => void) => { afterStatus = callback },
  }
}

it('inspects a previous Worker using its persisted session-scoped profile without rewriting the wire proof', async () => {
  const f = fixture()
  const generation = previousWorkerHarnessGeneration(f.binding)
  f.accepted.persistedProof.connectionGeneration = generation
  f.accepted.currentBinding.connectionGeneration = generation
  f.request.mockImplementation(async payload => {
    expect((payload as { proof: { connectionGeneration: string } }).proof.connectionGeneration).toBe(generation)
    return { payload: { status: 'configured', harness: 'claude', endpoint: f.endpointUrl, routing: 'fixed',
      checkedAt: new Date().toISOString() } }
  })
  expect(await f.inspect()).toMatchObject({ status: 'configured', harness: 'claude', endpoint: f.endpointUrl })
  expect(f.request).toHaveBeenCalledOnce()
  f.replaceConnection()
  await expect(f.inspect()).rejects.toMatchObject({ code: 'HARNESS_INVENTORY_STALE' })
})

it('routes setup through the selected Worker SDK with zero model input and deny-all tool callbacks', async () => {
  const f = fixture()
  try {
    expect(await f.inspect()).toMatchObject({ status: 'configured', harness: 'claude', endpoint: f.endpointUrl, routing: 'fixed' })
    expect(f.captureRequest).toHaveBeenCalledWith(f.binding.deviceId, 'host-harness-check-v1')
    expect(f.request).toHaveBeenCalledWith(expect.objectContaining({ operation: 'operator-configuration-inspect',
      override: f.accepted.override, proof: f.accepted.persistedProof, endpoint: f.endpointUrl }), expect.anything())
    expect(loadOfficialClaudeSdk).toHaveBeenCalledWith('/worker/claude-profile', expect.anything(),
      '/worker/bin/claude', '/worker/sdk/index.mjs')
    expect(f.revalidate).toHaveBeenCalledTimes(2)
    expect(f.qualify).not.toHaveBeenCalled()
    expect(f.inputs).toEqual([])
    expect(f.queries).toHaveLength(1)
    const options = f.queries[0]!.options
    expect(options).toMatchObject({ tools: [], settingSources: [], strictMcpConfig: true, systemPrompt: '', cwd: '/worker/state' })
    const canUseTool = options.canUseTool as () => Promise<{ behavior: string }>
    expect(await canUseTool()).toMatchObject({ behavior: 'deny' })
    const hooks = options.hooks as { PreToolUse: { hooks: (() => Promise<unknown>)[] }[] }
    expect(await hooks.PreToolUse[0]!.hooks[0]!()).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
    expect(options.mcpServers).toEqual({ 'foreman-code': { type: 'http', url: f.endpointUrl } })
    expect(f.nativeClose).toHaveBeenCalledOnce()
    expect(f.abandon).toHaveBeenCalledOnce()
    expect(f.closeOwner).toHaveBeenCalledOnce()
  } finally { await f.inspection.close() }
})

it('rejects a changed Worker connection before sending its inspection request', async () => {
  const f = fixture()
  try {
    f.replaceConnection()
    await expect(f.inspect()).rejects.toMatchObject({ code: 'HARNESS_INVENTORY_STALE' })
    expect(f.request).not.toHaveBeenCalled()
    expect(f.queries.length).toBe(0)
  } finally { await f.inspection.close() }
})

it('rejects an installed Worker SDK that differs from the saved native proof', async () => {
  const f = fixture()
  try {
    f.replaceSdk()
    await expect(f.inspect()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
    expect(f.queries.length).toBe(0)
  } finally { await f.inspection.close() }
})

it('rejects authority lost during Worker SDK inspection and still closes the owned query', async () => {
  const f = fixture()
  try {
    f.afterStatus(f.replaceConnection)
    await expect(f.inspect()).rejects.toMatchObject({ code: 'HARNESS_INVENTORY_STALE' })
    expect(f.inputs).toEqual([])
    expect(f.nativeClose).toHaveBeenCalledOnce()
    expect(f.closeOwner).toHaveBeenCalledOnce()
  } finally { await f.inspection.close() }
})

it('rejects a Worker reply for a different MCP endpoint', async () => {
  const f = fixture()
  try {
    f.request.mockResolvedValueOnce({ payload: { status: 'configured', harness: 'claude', routing: 'fixed',
      endpoint: 'https://other.example/mcp', checkedAt: new Date().toISOString() } })
    await expect(f.inspect()).rejects.toMatchObject({ code: 'HARNESS_CONFIGURATION_MISMATCH' })
  } finally { await f.inspection.close() }
})

it('rejects a channel replacement after receiving the selected Worker reply', async () => {
  const f = fixture()
  try {
    f.request.mockImplementationOnce(async () => {
      f.replaceConnection()
      return { payload: { status: 'configured', harness: 'claude', routing: 'fixed',
        endpoint: f.endpointUrl, checkedAt: new Date().toISOString() } }
    })
    await expect(f.inspect()).rejects.toMatchObject({ code: 'HARNESS_INVENTORY_STALE' })
    expect(f.revalidate).toHaveBeenCalledTimes(2)
  } finally { await f.inspection.close() }
})

it('returns no configured result when native query closure is unconfirmed', async () => {
  const f = fixture()
  try {
    f.closeOwner.mockResolvedValueOnce(false)
    await expect(f.inspect()).rejects.toMatchObject({ code: 'CLAUDE_PROCESS_CLOSURE_PENDING' })
    expect(f.inputs).toEqual([])
  } finally { await f.inspection.close() }
})

it('keeps qualification requests separate from read-only configuration inspection', async () => {
  const f = fixture()
  try {
    const extension = createHostHarnessProfileCheckExtension({
      hostRef: { kind: 'device', mainId: f.binding.mainId, deviceId: f.binding.deviceId },
      applicationInstallationId: f.binding.workerInstallationId, qualifierForBinding: () => ({ qualify: f.qualify }),
    })
    const result = await extension.handle({ checkId: '66666666-6666-4666-8666-666666666666', override: f.accepted.override },
      { binding: f.binding, signal: new AbortController().signal })
    expect(result.payload.qualified).toBe(true)
    expect(f.qualify).toHaveBeenCalledOnce()
    expect(f.queries.length).toBe(0)
  } finally { await f.inspection.close() }
})
