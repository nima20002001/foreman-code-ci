import { fixtureProtocol, input } from './fixtures/codex-test-helpers.js'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { describe, expect, it, vi } from 'vitest'
import { NativeHarnessFactories, type NativeFactoryInfrastructure } from '../src/modules/harnesses/runtimeFactory.js'
import type { CodexSessionDependencies } from '../src/modules/harnesses/codexAppServer.js'
import type { NativeProcessRecovery } from '../src/modules/harnesses/recovery/processRegistry.js'
import { APP_MCP_SERVER_NAME, appLauncherConnection } from '../src/modules/harnesses/appMcpLauncher.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../src/modules/harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry, type HarnessInstallationRecord } from '../src/modules/harnesses/installationRegistry.js'

function codexInfrastructure() {
  const transports: Array<{ close: ReturnType<typeof vi.fn>; closed: () => boolean }> = []
  const qualify = vi.fn<NonNullable<CodexSessionDependencies['qualify']>>(async (binary) => ({
    binary, identity: 'fixture', protocol: fixtureProtocol, providerVersion: 'codex-cli 0.154.0',
    schemaManifestSha256: 'fixture', stableSchemaGitBlob: 'fixture', referenceSchemaManifestSha256: 'fixture',
  }))
  const transport = vi.fn<NonNullable<CodexSessionDependencies['transport']>>(() => {
    let closed = false
    const close = vi.fn(async () => { closed = true })
    const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
      if (method === 'config/read') return { config: { mcp_servers: {
        [APP_MCP_SERVER_NAME]: { enabled: false },
      } } }
      if (method === 'thread/start') return {
        thread: { id: 'fixture-thread', turns: [], ephemeral: false }, model: params.model,
        cwd: params.cwd, reasoningEffort: 'medium', serviceTier: null,
        approvalPolicy: params.approvalPolicy, approvalsReviewer: params.approvalsReviewer,
        sandbox: { type: 'readOnly', networkAccess: false },
      }
      throw new Error('Unexpected native method: ' + method)
    })
    transports.push({ close, closed: () => closed })
    return { start: vi.fn(async () => undefined), request, close,
      respond: vi.fn(async () => undefined), reject: vi.fn(async () => undefined) }
  })
  const runCommand = vi.fn<NonNullable<CodexSessionDependencies['runCommand']>>(async (_binary, args) => {
    if (args[1] === 'get' && args[2] !== APP_MCP_SERVER_NAME) return {
      exitCode: 1, stdout: '', stderr: "Error: No MCP server named '" + args[2] + "' found.",
    }
    const launcher = appLauncherConnection()
    const entry = { name: APP_MCP_SERVER_NAME, enabled: true, required: true, transport: {
      type: 'stdio', command: launcher.executable, args: launcher.arguments,
      env_vars: launcher.environmentVariables,
    } }
    return { exitCode: 0, stdout: JSON.stringify(args[1] === 'list' ? [entry] : entry), stderr: '' }
  })
  const codex: CodexSessionDependencies = {
    mode: 'native', qualify, transport, runCommand, environment: () => ({}),
    assertUnchanged: vi.fn(async () => undefined), qualifyModel: vi.fn(async () => undefined),
  }
  return { infrastructure: { mode: 'native' as const, codex }, qualify, transport, transports }
}

describe('native runtime construction', () => {
  it('allocates diagnostics against the canonical default and fences changed payload bytes before native startup', async () => {
    const instances = new HarnessInstanceRegistry(localHarnessDrivers)
    instances.reload([{ instanceId: 'local-default:codex', instanceRevision: '8', driverId: 'codex',
      enabled: true, configuration: DEFAULT_HARNESS_DEFAULTS.codex }])
    const installations = new HarnessInstallationRegistry(instances)
    const installation: HarnessInstallationRecord = { hostRef: { kind: 'main', mainId: 'recorded-main' },
      harnessInstallationId: 'recorded-installation', installationFingerprint: 'original-payload', driverId: 'codex',
      driverRevision: '1', protocolRevision: 'recorded-protocol', environmentGeneration: 'env', connectionGeneration: 'connection',
      launcher: { requested: 'codex', resolvedLauncher: '/recorded/selected-codex', fingerprint: 'original-payload',
        status: 'installed', interpreter: null, diagnostics: [], checkedAt: '2026-10-01T00:00:00.000Z',
        environment: { generation: 'env', provenance: 'worker', cwd: '/recorded', path: '/recorded' },
        payloadFingerprints: [{ path: '/recorded/selected-codex', fingerprint: 'original-payload' }] },
      installed: true, observedVersion: null, authenticated: null, compatible: null, qualified: null }
    installations.refresh([installation])
    const discovery = vi.fn(async () => ({ ...installation.launcher }))
    const native = codexInfrastructure()
    const factories = new NativeHarnessFactories({ codexBinary: '/unused',
      instances, installations, installationDiscovery: discovery,
      selectDefault: () => installations.pin({ instanceId: 'local-default:codex', hostRef: installation.hostRef,
        harnessInstallationId: installation.harnessInstallationId, connectionGeneration: 'connection', environmentGeneration: 'env' }),
    }, native.infrastructure)
    const allocation = factories.allocate({ harness: 'codex', role: 'diagnostics',
      workingDirectory: '/recorded', ownerAgentId: 'diagnostic-owner', appMcpAccess: 'none' })
    expect(discovery).not.toHaveBeenCalled()
    await allocation.manager.capabilities()
    expect(native.qualify.mock.calls[0]![0]).toBe('/recorded/selected-codex')
    discovery.mockResolvedValue({ ...installation.launcher, fingerprint: 'changed-payload' })
    await expect(allocation.manager.capabilities()).rejects.toThrow('payload changed')
    expect(native.qualify).toHaveBeenCalledTimes(1)
    expect(native.transport).not.toHaveBeenCalled()
    await factories.disposeAuxiliary(allocation.manager)
  })

  it('allocates real role-isolated managers without starting infrastructure and disposes only its own child', async () => {
    const native = codexInfrastructure()
    const factories = new NativeHarnessFactories({ codexBinary: 'fixture-codex' }, native.infrastructure)
    const configured = { instanceId: 'agent-1', instanceRevision: 'configuration-1', driverId: 'codex', enabled: true,
      configuration: DEFAULT_HARNESS_DEFAULTS.codex }
    const roles = ['workflow', 'operator', 'agent-chat'] as const
    const bindings = roles.map((role) => factories.allocate({ harness: 'codex', role, configured,
      workingDirectory: '/project', ownerAgentId: role, appMcpAccess: role === 'agent-chat' ? 'none' : 'scoped',
      processRecovery: { root: '/unused-registry', owner: role + ':owner' },
    }))
    expect(new Set(bindings.map(({ manager }) => manager)).size).toBe(3)
    expect(native.qualify).not.toHaveBeenCalled()
    expect(native.transport).not.toHaveBeenCalled()
    expect(factories.instances.select('agent-1').instanceRevision).toBe('configuration-1')
    expect(factories.inspector(bindings[0]!.manager)).toBe(bindings[0]!.inspector)
    try {
      for (const [index, binding] of bindings.entries()) {
        const start = input('/project', roles[index])
        if (roles[index] === 'agent-chat') delete start.environment
        await binding.manager.createSession(start)
      }
      expect(native.transport.mock.calls.map(args => args[8]?.owner)).toEqual(roles.map(role => role + ':owner'))
      await bindings[2]!.manager.dispose()
      expect(native.transports[2]!.closed()).toBe(true)
      expect(native.transports[0]!.closed()).toBe(false)
      expect(native.transports[1]!.closed()).toBe(false)
    } finally {
      await Promise.all(bindings.map(binding => binding.manager.dispose()))
    }
  })

  it.each(['agent-chat', 'diagnostics', 'qualification'] as const)('rejects scoped application authority for %s before allocation', (role) => {
    const native = codexInfrastructure()
    const factories = new NativeHarnessFactories({ codexBinary: 'unused' }, native.infrastructure)
    expect(() => factories.allocate({ harness: 'codex', role, workingDirectory: '/project',
      ownerAgentId: role, appMcpAccess: 'scoped' })).toThrow('no application MCP credentials')
    expect(native.qualify).not.toHaveBeenCalled()
    expect(native.transport).not.toHaveBeenCalled()
  })

  it('keeps combined file and management capabilities limited to Operator chat', async () => {
    const native = codexInfrastructure()
    const factories = new NativeHarnessFactories({ codexBinary: 'unused' }, native.infrastructure)
    const common = { harness: 'codex' as const, workingDirectory: '/project',
      ownerAgentId: 'agent-a', appMcpAccess: 'scoped' as const }
    const prepare = vi.fn(async () => undefined)
    const chatFiles = { prepare }
    expect(() => factories.allocate({ ...common, chatFiles, role: 'workflow' })).toThrow('Only Operator chat')
    expect(() => factories.allocate({ ...common, chatFiles, role: 'agent-chat' })).toThrow('no application MCP credentials')
    expect(native.qualify).not.toHaveBeenCalled()
    expect(native.transport).not.toHaveBeenCalled()
    const { manager } = factories.allocate({ ...common, chatFiles, role: 'operator' })
    const start = input('/project')
    await expect(manager.createSession(start)).rejects.toMatchObject({
      result: { error: { code: 'CODEX_FILE_CHAT_ISOLATION_REQUIRED' } },
    })
    expect(prepare).not.toHaveBeenCalled()
    expect(native.qualify).not.toHaveBeenCalled()
    expect(native.transport).not.toHaveBeenCalled()
    await manager.dispose()
  })

  it('fails closed for incomplete replay infrastructure rather than constructing native clients', () => {
    expect(() => new NativeHarnessFactories({ codexBinary: 'unused' },
      { mode: 'replay' } as NativeFactoryInfrastructure)).toThrow('every provider infrastructure port')
  })

  it('rejects mutation of a pinned configured revision', () => {
    const factories = new NativeHarnessFactories({ codexBinary: 'unused' })
    const input = { harness: 'codex' as const, role: 'workflow' as const, workingDirectory: '/project',
      ownerAgentId: 'agent-1', appMcpAccess: 'scoped' as const,
      configured: { instanceId: 'agent-1', instanceRevision: 'configuration-1', driverId: 'codex', enabled: true,
        configuration: DEFAULT_HARNESS_DEFAULTS.codex } }
    factories.allocate(input)
    expect(() => factories.allocate({ ...input, configured: { ...input.configured,
      configuration: { ...input.configured.configuration, reasoningEffort: 'high' } } })).toThrow('immutable')
  })

  it('retains failed diagnostic recovery closure and retries the same owner after admission stops', async () => {
    const recovery = { root: '/unused-registry', owner: 'diagnostics:recorded' }
    const abandonRecovery = vi.fn(async () => { throw new Error('Invalid native launch abandonment scope.') })
    const closeRecovery = vi.fn<(scope: typeof recovery) => Promise<void>>()
      .mockRejectedValueOnce(new Error('Closure is unconfirmed.')).mockResolvedValue(undefined)
    const factories = new NativeHarnessFactories({ codexBinary: 'unused',
      auxiliaryRecovery: () => recovery, abandonRecovery, closeRecovery }, { mode: 'native' })
    const allocation = factories.allocate({ harness: 'codex', role: 'diagnostics',
      ownerAgentId: 'diagnostics', workingDirectory: '/project', appMcpAccess: 'none' })
    await factories.admitAuxiliary(allocation.manager)
    await expect(factories.disposeAuxiliary(allocation.manager)).rejects.toThrow('unconfirmed')
    factories.stopAuxiliaries()
    expect(() => factories.allocate({ harness: 'codex', role: 'qualification', ownerAgentId: 'qualification',
      workingDirectory: '/project', appMcpAccess: 'none' })).toThrow('shutting down')
    await factories.disposeAuxiliaries()
    expect(closeRecovery).toHaveBeenCalledTimes(2)
    expect(closeRecovery.mock.calls.every(([scope]) => scope === recovery)).toBe(true)
    expect(abandonRecovery).not.toHaveBeenCalled()
    await expect(allocation.manager.capabilities()).rejects.toThrow('shutting down')
    await factories.disposeAuxiliaries()
    expect(closeRecovery).toHaveBeenCalledTimes(2)
  })

  it('retains a partially failed reservation and fences native work until cleanup succeeds', async () => {
    const recovery: NativeProcessRecovery = { root: '/unused-registry', owner: 'diagnostics:partial' }
    const admitRecovery = vi.fn(() => {
      recovery.launchId = 'recorded-launch'
      throw new Error('Reservation failed partway through.')
    })
    const abandonRecovery = vi.fn(async () => undefined)
    const closeRecovery = vi.fn<(scope: typeof recovery) => Promise<void>>().mockResolvedValue(undefined)
    const factories = new NativeHarnessFactories({ codexBinary: 'unused',
      auxiliaryRecovery: () => recovery, admitRecovery, abandonRecovery, closeRecovery })
    const allocation = factories.allocate({ harness: 'codex', role: 'diagnostics', ownerAgentId: 'diagnostics',
      workingDirectory: '/project', appMcpAccess: 'none' })
    await expect(factories.admitAuxiliary(allocation.manager)).rejects.toThrow('Reservation failed')
    await expect(factories.admitAuxiliary(allocation.manager)).rejects.toThrow('Reservation failed')
    expect(admitRecovery).toHaveBeenCalledTimes(1)
    await factories.disposeAuxiliary(allocation.manager)
    expect(abandonRecovery).toHaveBeenCalledExactlyOnceWith(recovery)
    expect(closeRecovery).toHaveBeenCalledExactlyOnceWith(recovery)
    await factories.disposeAuxiliary(allocation.manager)
    expect(closeRecovery).toHaveBeenCalledTimes(1)
  })

  it('preserves failed admission before a reservation exists and never retries native work through that owner', async () => {
    const recovery = { root: '/unused-registry', owner: 'qualification:failed-admission' }
    const failure = new Error('Reservation storage is full.')
    const admitRecovery = vi.fn(() => { throw failure })
    const closeRecovery = vi.fn(async () => { throw new Error('No process closure exists.') })
    const factories = new NativeHarnessFactories({ codexBinary: 'unused',
      auxiliaryRecovery: () => recovery, admitRecovery, closeRecovery })
    const allocation = factories.allocate({ harness: 'codex', role: 'qualification',
      ownerAgentId: 'qualification', workingDirectory: '/project', appMcpAccess: 'none' })
    await expect(factories.admitAuxiliary(allocation.manager)).rejects.toThrow(failure)
    await expect(factories.admitAuxiliary(allocation.manager)).rejects.toThrow(failure)
    await factories.disposeAuxiliary(allocation.manager)
    expect(admitRecovery).toHaveBeenCalledOnce()
    expect(closeRecovery).not.toHaveBeenCalled()
    await expect(allocation.manager.capabilities()).rejects.toThrow('shutting down')
    await factories.disposeAuxiliaries()
  })

  it.each(['diagnostics', 'qualification'] as const)(
    'closes an admitted %s owner without treating an unreserved scope as a launch', async role => {
      const recovery = { root: '/unused-registry', owner: `${role}:unreserved` }
      const admitRecovery = vi.fn()
      const abandonRecovery = vi.fn(async () => { throw new Error('Invalid native launch abandonment scope.') })
      const closeRecovery = vi.fn(async () => undefined)
      const factories = new NativeHarnessFactories({ codexBinary: 'unused',
        auxiliaryRecovery: () => recovery, admitRecovery, abandonRecovery, closeRecovery })
      const allocation = factories.allocate({ harness: 'codex', role,
        ownerAgentId: role, workingDirectory: '/project', appMcpAccess: 'none' })
      await factories.admitAuxiliary(allocation.manager)
      await factories.disposeAuxiliary(allocation.manager)
      await factories.disposeAuxiliary(allocation.manager)
      expect(admitRecovery).toHaveBeenCalledExactlyOnceWith(recovery)
      expect(abandonRecovery).not.toHaveBeenCalled()
      expect(closeRecovery).toHaveBeenCalledExactlyOnceWith(recovery)
      await expect(allocation.manager.capabilities()).rejects.toThrow('shutting down')
    })
})

describe('original Codex lifetime factory capability', () => {
  it('never admits an unopened wrapper or an unowned manager through passive lookup', async () => {
    const factories = new NativeHarnessFactories({ codexBinary: 'unused' })
    const prepare = vi.fn()
    const wrapped = factories.allocateAdmitted('codex', prepare)
    const source = input('/recorded')
    const session = { harness: 'codex' as const, providerVersion: '0.154.0', nativeSessionId: 'original' }
    expect(factories.originalCodexSession(wrapped.manager, session, source, () => {})).toBeUndefined()
    expect(prepare).not.toHaveBeenCalled()
    const foreign = new NativeHarnessFactories({ codexBinary: 'unused' })
      .allocate({ harness: 'codex', role: 'workflow', workingDirectory: '/recorded', ownerAgentId: 'owner', appMcpAccess: 'scoped' })
    expect(factories.originalCodexSession(foreign.manager, session, source, () => {})).toBeUndefined()
  })

  it('composes the actual adapter pin with the caller fence before and after awaits', async () => {
    const factories = new NativeHarnessFactories({ codexBinary: 'unused' })
    const allocation = factories.allocate({ harness: 'codex', role: 'workflow', workingDirectory: '/recorded', ownerAgentId: 'owner', appMcpAccess: 'scoped' })
    if (allocation.harness !== 'codex') throw new Error('Wrong test allocation')
    const source = input('/recorded'), session = { harness: 'codex' as const, providerVersion: '0.154.0', nativeSessionId: 'original' }
    const providerFence = vi.fn(), ownerFence = vi.fn()
    const lookup = vi.spyOn(allocation.manager, 'originalSessionLifetime').mockReturnValue({
      residency: { session, connectionId: 'original-channel', runtimeGeneration: 0, nativeTurnId: 'original-turn' }, assertCurrent: providerFence })
    const reattach = vi.spyOn(allocation.manager, 'reattachOriginalSession').mockResolvedValue(session)
    const original = factories.originalCodexSession(allocation.manager, session, source, ownerFence)!
    Object.assign(original.residency, { connectionId: 'mutated-readback' })
    expect(await original.reattach()).toEqual(session)
    expect(lookup).toHaveBeenCalledExactlyOnceWith(session, source)
    expect(reattach.mock.calls[0]![2].connectionId).toBe('original-channel')
    reattach.mockImplementation(async () => { ownerFence.mockImplementation(() => { throw new Error('Original lease lost') }); return session })
    await expect(original.reattach()).rejects.toThrow('Original lease lost')
    expect(providerFence).toHaveBeenCalled()
    expect(() => original.assertCurrent()).toThrow('Original lease lost')
  })

  it('withdraws an admitted wrapper capability on disposal without reallocation', async () => {
    const factories = new NativeHarnessFactories({ codexBinary: 'unused' })
    const allocation = factories.allocate({ harness: 'codex', role: 'workflow', workingDirectory: '/recorded', ownerAgentId: 'owner', appMcpAccess: 'scoped' })
    if (allocation.harness !== 'codex') throw new Error('Wrong test allocation')
    const source = input('/recorded'), session = { harness: 'codex' as const, providerVersion: '0.154.0', nativeSessionId: 'original' }
    vi.spyOn(allocation.manager, 'originalSessionLifetime').mockReturnValue({
      residency: { session, connectionId: 'original-channel', runtimeGeneration: 0, nativeTurnId: 'original-turn' }, assertCurrent: () => {} })
    vi.spyOn(allocation.manager, 'capabilities').mockResolvedValue({} as Awaited<ReturnType<typeof allocation.manager.capabilities>>)
    vi.spyOn(factories, 'allocate').mockReturnValue(allocation)
    const wrapped = factories.allocateAdmitted('codex', async () => ({ harness: 'codex', role: 'workflow', workingDirectory: '/recorded', ownerAgentId: 'owner', appMcpAccess: 'scoped' }))
    await wrapped.manager.capabilities()
    const original = factories.originalCodexSession(wrapped.manager, session, source, () => {})!
    expect(original).toBeDefined()
    await wrapped.manager.dispose?.()
    expect(() => original.assertCurrent()).toThrow('no longer current')
    expect(factories.originalCodexSession(wrapped.manager, session, source, () => {})).toBeUndefined()
  })
})
