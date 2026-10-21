import { RECORDED_CODEX_VERSION } from './fixtures/codex-version.js'
import { expect, it, vi } from 'vitest'
import type { CodexSessionDependencies, CodexTransport } from '../src/modules/harnesses/codexAppServer.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import type { NativeProcessRecovery } from '../src/modules/harnesses/recovery/processRegistry.js'
import { fixtureProtocol, input } from './fixtures/codex-test-helpers.js'
import { ReplayGate } from './support/harnessReplay.js'

function fixture() {
  const source = input('/recorded-workspace')
  if (source.request.configuration.harness.harness !== 'codex') throw new Error('Expected Codex fixture.')
  source.request.configuration.harness.advanced!.sessionPersistence = 'ephemeral'
  source.environment = { ...source.environment!, variables: { ...source.environment!.variables, CUSTOM_APPLICATION_BEARER: 'writer-only' } }
  const ambient = { CUSTOM_APPLICATION_BEARER: 'ambient-bearer', FOREMAN_CODE_MCP_TOKEN: 'ambient-main',
    GRAPHQL_MCP_TOKEN: 'legacy-ambient-main', HOST_ONLY: 'host-config' }
  const close = vi.fn(async () => undefined)
  const requests: string[] = []
  const transport: CodexTransport = { start: async () => undefined, close, respond: async () => undefined, reject: async () => undefined,
    request: async (method, params) => {
      requests.push(method)
      if (method === 'config/mcpServer/reload') return {}
      if (method !== 'thread/start') throw new Error(`Unexpected transport method ${method}`)
      const config = params!.config as Record<string, unknown>
      return { thread: { id: 'recorded-thread', turns: [], ephemeral: true }, model: params!.model, modelProvider: 'openai',
        cwd: params!.cwd, reasoningEffort: config.model_reasoning_effort, serviceTier: null,
        approvalPolicy: params!.approvalPolicy, approvalsReviewer: params!.approvalsReviewer,
        sandbox: { type: 'readOnly', networkAccess: false } }
    } }
  const commands: { args: readonly string[]; environment: NodeJS.ProcessEnv; recovery: NativeProcessRecovery }[] = []
  let blockDiagnostic: ((signal: AbortSignal) => Promise<void>) | undefined
  const dependencies: CodexSessionDependencies = { mode: 'native', environment: (scope) => ({ ...ambient, ...scope?.variables }),
    qualify: async (binary) => ({ binary, identity: 'recorded-identity', protocol: fixtureProtocol,
      providerVersion: RECORDED_CODEX_VERSION, schemaManifestSha256: 'recorded-schema', stableSchemaGitBlob: 'recorded-stable',
      referenceSchemaManifestSha256: 'recorded-reference' }),
    assertUnchanged: async () => undefined, qualifyModel: async () => undefined,
    id: () => 'recorded-connection', now: () => new Date('2026-10-01T00:00:00Z'), transport: () => transport,
    runCommand: async (_binary, args, _cwd, signal, environment, options) => {
      if (options?.recovery) {
        if (environment && ('beforeSpawn' in environment || 'expectedAgentId' in environment)) throw new Error('Unexpected credential scope adapter.')
        commands.push({ args: [...args], environment: { ...environment as NodeJS.ProcessEnv }, recovery: options.recovery })
        await blockDiagnostic?.(signal!)
      }
      if (args[0] === 'mcp' && args[1] === 'list') return {
        stdout: JSON.stringify([{ name: 'foreman-code' }]), stderr: '', exitCode: 0, exitSignal: null,
      }
      if (args[0] === 'mcp' && args[1] === 'get' && args[2] === 'graphql') return {
        stdout: '', stderr: "Error: No MCP server named 'graphql' found.", exitCode: 1, exitSignal: null,
      }
      if (args[0] !== 'mcp' || args[1] !== 'get' || args[2] !== 'foreman-code') {
        throw new Error(`Unexpected command ${args.join(' ')}`)
      }
      return { stdout: JSON.stringify({ enabled: true, transport: { type: 'streamable_http',
        url: 'http://127.0.0.1:3000/mcp', bearer_token_env_var: 'CUSTOM_APPLICATION_BEARER' } }),
      stderr: '', exitCode: 0, exitSignal: null }
    } }
  let sequence = 0
  const admit = vi.fn((scope: NativeProcessRecovery) => { scope.launchId = `recorded-launch-${++sequence}` })
  const abandon = vi.fn<(scope: NativeProcessRecovery) => Promise<void>>().mockResolvedValue(undefined)
  const closeRecovery = vi.fn<(scope: NativeProcessRecovery) => Promise<void>>().mockResolvedValue(undefined)
  const writer = { root: '/recorded-registry', owner: 'execution:writer' }
  const factories = new NativeHarnessFactories({ codexBinary: '/recorded-codex',
    auxiliaryRecovery: () => ({ root: writer.root, owner: `diagnostics:${sequence + 1}` }),
    admitRecovery: admit, abandonRecovery: abandon, closeRecovery }, { mode: 'native', codex: dependencies })
  const allocation = factories.allocate({ harness: 'codex', role: 'workflow', workingDirectory: source.request.workingDirectory,
    ownerAgentId: source.request.configuration.agentId, processRecovery: writer, appMcpAccess: 'scoped' })
  if (allocation.harness !== 'codex') throw new Error('Expected Codex manager.')
  return { manager: allocation.manager, factories, source, writer, ambient, requests, commands, close, admit, abandon, closeRecovery,
    block: (value: NonNullable<typeof blockDiagnostic>) => { blockDiagnostic = value } }
}

it('configuration reinspection uses a separate owner while the original Codex session remains open', async () => {
  const f = fixture()
  try {
    await f.manager.createSession(f.source)
    const earlierCommands = f.commands.length
    const inspected = await f.factories.inspector(f.manager).inspect({
      harness: 'codex', runnerId: 'runner-local', workingDirectory: '/recorded-workspace',
      serverName: 'foreman-code', phase: 'configuration',
    })
    expect(inspected.entry).toMatchObject({ name: 'foreman-code', enabled: true })
    const scope = f.admit.mock.calls[0]![0]
    expect(scope.owner).not.toBe(f.writer.owner)
    expect(f.commands.slice(earlierCommands).every(command => command.recovery === scope)).toBe(true)
    expect(f.closeRecovery).toHaveBeenCalledExactlyOnceWith(scope)
    expect(f.abandon).toHaveBeenCalledExactlyOnceWith(scope)
    expect(f.close).not.toHaveBeenCalled()
    expect(f.requests).toEqual(['thread/start'])
  } finally {
    await f.manager.dispose()
    await f.factories.disposeAuxiliaries()
  }
})

it('same-process ephemeral reload uses separately admitted diagnostics with no scoped application credentials', async () => {
  const f = fixture()
  try {
    const session = await f.manager.createSession(f.source)
    await f.manager.reloadNativeMcp(session)
    expect(f.requests).toEqual(['thread/start', 'config/mcpServer/reload'])
    expect(f.close).not.toHaveBeenCalled()
    expect(f.admit).toHaveBeenCalledTimes(1)
    const scope = f.admit.mock.calls[0]![0]
    expect(scope.owner).not.toBe(f.writer.owner)
    expect(f.commands.map(command => command.args)).toEqual([
      ['mcp', 'get', 'foreman-code', '--json'], ['mcp', 'get', 'graphql', '--json'],
    ])
    for (const command of f.commands) {
      expect(command.recovery).toBe(scope)
      expect(command.environment).toEqual({ HOST_ONLY: 'host-config' })
    }
    expect(f.source.environment!.variables.CUSTOM_APPLICATION_BEARER).toBe('writer-only')
    expect(f.ambient.CUSTOM_APPLICATION_BEARER).toBe('ambient-bearer')
    expect(f.abandon).toHaveBeenCalledExactlyOnceWith(scope)
    expect(f.closeRecovery).toHaveBeenCalledExactlyOnceWith(scope)
  } finally { await f.manager.dispose(); await f.factories.disposeAuxiliaries() }
})

it('factory shutdown aborts and joins diagnostics without closing the live writer or sending reload', async () => {
  const f = fixture()
  const entered = new ReplayGate<void>()
  f.block((signal) => { entered.release(); return new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) })
  try {
    const session = await f.manager.createSession(f.source)
    const reloading = f.manager.reloadNativeMcp(session)
    await entered.promise
    f.factories.stopAuxiliaries()
    await expect(reloading).rejects.toThrow('shutting down')
    await f.factories.disposeAuxiliaries()
    expect(f.requests).toEqual(['thread/start'])
    expect(f.close).not.toHaveBeenCalled()
    expect(f.closeRecovery).toHaveBeenCalledTimes(1)
  } finally { await f.manager.dispose(); await f.factories.disposeAuxiliaries() }
})

it('retains uncertain diagnostic cleanup for retry and refuses reload until closure is positive', async () => {
  const f = fixture()
  f.closeRecovery.mockRejectedValueOnce(new Error('Diagnostic closure is unconfirmed.'))
  try {
    const session = await f.manager.createSession(f.source)
    await expect(f.manager.reloadNativeMcp(session)).rejects.toThrow('unconfirmed')
    expect(f.requests).toEqual(['thread/start'])
    expect(f.close).not.toHaveBeenCalled()
    const retained = f.admit.mock.calls[0]![0]
    await expect(f.manager.reloadNativeMcp(session)).rejects.toThrow('Retry retained diagnostic cleanup')
    expect(f.admit).toHaveBeenCalledTimes(1)
    await f.factories.disposeAuxiliaries()
    expect(f.closeRecovery).toHaveBeenCalledTimes(2)
    expect(f.closeRecovery.mock.calls.every(([scope]) => scope === retained)).toBe(true)
  } finally { await f.manager.dispose(); await f.factories.disposeAuxiliaries() }
})

it.each(['factory', 'caller'] as const)('fences %s cancellation during successful diagnostic physical cleanup', async (cancel) => {
  const f = fixture()
  const cleanupEntered = new ReplayGate<void>()
  const finishCleanup = new ReplayGate<void>()
  const caller = new AbortController()
  let cleanupReleased = false
  let reloading: Promise<void> | undefined
  f.closeRecovery.mockImplementation(async () => { cleanupEntered.release(); await finishCleanup.promise })
  try {
    const session = await f.manager.createSession(f.source)
    reloading = f.manager.reloadNativeMcp(session, caller.signal)
    await cleanupEntered.promise
    if (cancel === 'factory') f.factories.stopAuxiliaries()
    else caller.abort(new Error('Caller canceled during cleanup.'))
    cleanupReleased = true
    finishCleanup.release()
    await expect(reloading).rejects.toThrow(cancel === 'factory' ? 'shutting down' : 'Caller canceled')
    await f.factories.disposeAuxiliaries()
    expect(f.requests).toEqual(['thread/start'])
    expect(f.close).not.toHaveBeenCalled()
    expect(f.closeRecovery).toHaveBeenCalledTimes(1)
  } finally {
    if (!cleanupReleased) finishCleanup.release()
    await Promise.allSettled(reloading ? [reloading] : [])
    await f.manager.dispose(); await f.factories.disposeAuxiliaries()
  }
})
