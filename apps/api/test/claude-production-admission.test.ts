import { describe, expect, it, vi } from 'vitest'
import { McpDetectionService } from '../src/modules/harnesses/mcpDetection.js'
import { NativeHarnessFactories } from '../src/modules/harnesses/runtimeFactory.js'
import type { NativeProcessRecovery } from '../src/modules/harnesses/recovery/processRegistry.js'
import type { NativeHarnessEvent, NativeSessionReference } from '@foreman-code/contracts'
import { productionClaudeFixture, managementEndpoint } from './support/claudeProduction.js'
import { rejectableDeferred } from './helpers/deferred.js'

async function replay(f: ReturnType<typeof productionClaudeFixture>) {
  const observed: string[] = []
  const output = (async () => {
    for await (const event of f.manager.startInitialTurn(f.start, { prompt: 'Recorded input', clientCorrelationId: f.start.correlationId!,
      onSessionObserved: async session => { observed.push(`session:${session.nativeSessionId}`) },
      onMessageSubmitted: async receipt => { expect(observed).toEqual(['session:recorded-session']); observed.push(`message:${receipt.nativeMessageId}`) },
    })) observed.push(event.type)
  })()
  const message = (await (await f.ready.promise).next()).value!
  void f.frames.offer({ type: 'system', subtype: 'init', session_id: 'recorded-session', claude_code_version: '2.1.284', cwd: '/recorded/work' })
  void f.frames.offer({ type: 'assistant', uuid: 'recorded-reply', session_id: 'recorded-session', user_message_uuid: message.uuid,
    parent_tool_use_id: null, message: { id: 'recorded-api-message', content: [{ type: 'text', text: 'Recorded reply' }] } })
  void f.frames.offer({ type: 'result', uuid: 'recorded-result', session_id: 'recorded-session', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'Recorded reply' })
  await output
  return observed
}

describe('common admitted production Claude four-surface replay', () => {
  it('resumes a full production chat before the next message without replaying previous inputs', async () => {
    const f = productionClaudeFixture('agent')
    let session: NativeSessionReference | undefined
    const offered = new Set<string>()
    try {
      for (let index = 1; index <= 257; index++) {
        f.row.active_request_id = `request-${index}`
        const correlationId = `agent:request-${index}`
        const input = { prompt: `Message ${index}`, clientCorrelationId: correlationId,
          onMessageSubmitted: async (receipt: NonNullable<typeof f.row.payload.nativeSubmission>) => {
            f.row.payload.nativeSubmission = receipt
          } }
        const events: NativeHarnessEvent[] = []
        const stream = session ? f.manager.startTurn(session, input)
          : f.manager.startInitialTurn(f.start, { ...input, onSessionObserved: async observed => {
            session = observed
            f.row.native_session_id = observed.nativeSessionId
            f.row.provider_version = observed.providerVersion
          } })
        const output = (async () => { for await (const event of stream) events.push(event) })()
        await vi.waitFor(() => expect(f.queries).toHaveLength(index > 256 ? 2 : 1))
        const message = (await f.queries.at(-1)!.messages.next()).value!
        expect(offered.has(message.uuid)).toBe(false)
        offered.add(message.uuid)
        expect(message.message.content).toBe(input.prompt)
        if (index === 1) await f.frames.offer({ type: 'system', subtype: 'init', session_id: 'recorded-session',
          claude_code_version: '2.1.284', cwd: '/recorded/work' })
        await f.frames.offer({ type: 'assistant', uuid: `reply-${index}`, session_id: 'recorded-session',
          user_message_uuid: message.uuid, message: { id: `message-${index}`, content: [{ type: 'text', text: 'answer' }] } })
        await f.frames.offer({ type: 'result', uuid: `result-${index}`, session_id: 'recorded-session',
          user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'answer' })
        await output
        expect(events.at(-1)?.payload.result).toEqual({ outcome: 'succeeded', output: 'answer' })
      }
      expect(offered.size).toBe(257)
      expect(f.sdkQuery.mock.calls[1]![0].options.resume).toBe(session!.nativeSessionId)
      expect((await f.manager.reconcile(session!, 'agent:request-1')).terminalResult?.outcome).toBe('succeeded')
      const replay = f.manager.startTurn(session!, { prompt: 'Message 1', clientCorrelationId: 'agent:request-1' })
      await expect(replay[Symbol.asyncIterator]().next()).rejects.toThrow('already offered')
    } finally { await f.manager.dispose?.() }
  }, 30_000)

  it.each(['workflow', 'operator', 'agent', 'selected-run'] as const)('loads exact profile and existing %s domain before observed native message', async surface => {
    const f = productionClaudeFixture(surface)
    expect(f.loadClient).not.toHaveBeenCalled(); expect(f.query).not.toHaveBeenCalled()
    expect((await replay(f)).some(value => value === 'claude.text')).toBe(true)
    expect(f.sdkQuery).toHaveBeenCalledOnce()
    expect(f.loadClient).toHaveBeenCalledWith({ profilePath: '/recorded/profile', recovery: { root: '/forbidden-native-recovery', owner: surface }, binary: '/recorded/claude' })
    const options = f.sdkQuery.mock.calls[0]![0].options
    expect(options.canUseTool).toBeTypeOf('function'); expect(options.settingSources).toEqual([])
    expect(options.env).not.toHaveProperty('GRAPHQL_MCP_TOKEN')
    expect(options.env).not.toHaveProperty('FOREMAN_CODE_MCP_TOKEN')
    if (surface === 'agent' || surface === 'selected-run') expect(options.mcpServers).not.toHaveProperty('graphql')
    await f.manager.dispose?.()
  })
  it('shares one configured factory while all four domain owners retain separate SDK queries', async () => {
    const workflow = productionClaudeFixture('workflow')
    const owners = [workflow, productionClaudeFixture('operator', workflow.factories), productionClaudeFixture('agent', workflow.factories), productionClaudeFixture('selected-run', workflow.factories)]
    expect(workflow.factories.instances.list()).toHaveLength(1)
    expect(new Set(owners.map(owner => owner.manager)).size).toBe(4)
    const outputs = await Promise.all(owners.map(replay))
    expect(outputs.every(events => events.includes('claude.text'))).toBe(true)
    await workflow.manager.dispose?.()
    expect(owners.slice(1).every(owner => owner.loadClient.mock.calls.length === 1)).toBe(true)
    for (const owner of owners.slice(1)) expect(await owner.manager.capabilities()).toMatchObject({ provider: 'claude', persistentSessions: true })
    await Promise.all(owners.slice(1).map(owner => owner.manager.dispose?.()))
  })
  it.each(['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN'])(
    'rejects a workflow %s credential copied into Agent chat before opening the SDK query', async tokenName => {
    const f = productionClaudeFixture('agent')
    const iterator = f.manager.startInitialTurn({ ...f.start, environment: { agentId: 'agent', variables: { [tokenName]: 'copied-token' } } }, {
      prompt: 'Recorded input', clientCorrelationId: 'agent:request-1', onSessionObserved: async () => {},
    })[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toThrow('cannot inherit')
    expect(f.loadClient).not.toHaveBeenCalled()
    await f.manager.dispose?.()
  })
  it('requires the actual retained-query HTTP ACK before common credential detection is connected', async () => {
    const endpoint = await managementEndpoint()
    const f = productionClaudeFixture('operator', undefined, endpoint.url)
    const detection = new McpDetectionService(f.factories.inspector(f.manager), f.harness.mcpServers.graphql.url)
    const context = { harness: 'claude' as const, runnerId: 'runner-local', workingDirectory: '/recorded/work' }
    expect((await detection.inspect(context)).detection.credentialArrangement).toEqual({ kind: 'unknown' })
    const start = { ...f.start, environment: { agentId: 'operator', variables: { GRAPHQL_MCP_TOKEN: 'synthetic-scoped-token' } } }
    const servers = { graphql: { type: 'http', url: f.harness.mcpServers.graphql.url, headers: { Authorization: 'Bearer synthetic-scoped-token' } } }
    await f.manager.refreshInspectionCredentials(start, servers)
    const evidence = await f.factories.inspector(f.manager).inspect({ ...context, serverName: 'graphql' })
    expect(evidence.entry?.credentialArrangement).toMatchObject({ kind: 'scoped_http_header', acknowledgement: {
      source: 'sdk_set_mcp_servers', generation: evidence.generation, authorizationScope: evidence.authorizationScope,
    } })
    expect((await detection.preflight(context)).detection).toMatchObject({ state: 'connected', credentialEnvironmentVariable: null,
      credentialArrangement: { kind: 'scoped_http_header' } })
    expect(f.setMcpServers).toHaveBeenCalledExactlyOnceWith(servers)
    expect(f.sdkQuery).toHaveBeenCalledOnce()
    expect(JSON.stringify(evidence)).not.toContain('synthetic-scoped-token')
    await f.manager.dispose?.()
    await endpoint.app.close()
  })
  it('rejects a stale exact profile before loading any SDK client', async () => {
    const f = productionClaudeFixture('agent'); f.proof.connectionGeneration = 'changed'
    await expect(f.manager.capabilities()).rejects.toThrow('stale')
    expect(f.loadClient).not.toHaveBeenCalled(); expect(f.sdkQuery).not.toHaveBeenCalled()
    await f.manager.dispose?.()
  })
  it('joins disposal during exact profile admission without constructing a native query', async () => {
    const f = productionClaudeFixture('agent'), entered = rejectableDeferred<void>(), release = rejectableDeferred<void>()
    const actualAdmission = f.profiles.admit.bind(f.profiles)
    vi.spyOn(f.profiles, 'admit').mockImplementation(async (owner, selector) => {
      entered.resolve(); await release.promise
      return actualAdmission(owner, selector)
    })
    const pending = expect(f.manager.capabilities()).rejects.toThrow('disposed')
    await entered.promise
    const disposal = f.manager.dispose!()
    expect(f.loadClient).not.toHaveBeenCalled()
    release.resolve()
    await Promise.all([pending, disposal])
    expect(f.sdkQuery).not.toHaveBeenCalled()
  })
  it('disposes an unopened allocation without looking up a profile or SDK', async () => {
    const f = productionClaudeFixture('operator'), admit = vi.spyOn(f.profiles, 'admit')
    await f.manager.dispose?.()
    expect(admit).not.toHaveBeenCalled(); expect(f.loadClient).not.toHaveBeenCalled()
  })
})

describe('actual common owned Claude version command', () => {
  function ownedVersion() {
    const f = productionClaudeFixture('operator')
    const recovery: NativeProcessRecovery = {
      root: '/forbidden-registry', owner: 'diagnostics:recorded', launchId: 'recorded-launch',
    }
    const command = vi.fn(async () => ({ exitCode: 0, stdout: '2.1.284 (Claude Code)\n', stderr: '' }))
    const close = vi.fn(async () => {})
    const abandon = vi.fn(async () => {})
    const admit = vi.fn()
    const factories = new NativeHarnessFactories({ codexBinary: '/forbidden',
      instances: f.factories.instances, installations: f.installations, installationDiscovery: async () => f.launcher,
      auxiliaryRecovery: () => recovery, admitRecovery: admit, abandonRecovery: abandon, closeRecovery: close, claudeVersionCommand: command })
    return { ...f, factories, recovery, command, close, abandon, admit }
  }
  it('returns version evidence only after positive original-owner cleanup and never supplies auth variables', async () => {
    const f = ownedVersion(), entered = rejectableDeferred<void>(), release = rejectableDeferred<void>()
    f.close.mockImplementation(async () => { entered.resolve(); await release.promise })
    let settled = false
    const probe = f.factories.observeClaudeVersion(f.binding, '/recorded-neutral').then(result => { settled = true; return result })
    await entered.promise
    expect(settled).toBe(false)
    const call = f.command.mock.calls[0] as unknown as [string, string[], string, AbortSignal, NodeJS.ProcessEnv, { recovery: unknown; maxOutputBytes: number }]
    expect(call.slice(0, 3)).toEqual(['/recorded/claude', ['--version'], '/recorded-neutral'])
    expect(call[4]).not.toHaveProperty('GRAPHQL_MCP_TOKEN'); expect(call[4]).not.toHaveProperty('ANTHROPIC_API_KEY')
    expect(call[5]).toEqual({ recovery: f.recovery, maxOutputBytes: 16_384 })
    release.resolve()
    expect(await probe).toMatchObject({ version: '2.1.284', positiveProcessClosure: true,
      installationFingerprint: f.binding.selection.installationFingerprint })
    expect(f.admit).toHaveBeenCalledExactlyOnceWith(f.recovery)
    expect(f.abandon).toHaveBeenCalledExactlyOnceWith(f.recovery)
    await f.manager.dispose?.()
  })
  it('retains a failed physical close and blocks fresh version inspection until retry succeeds', async () => {
    const f = ownedVersion()
    f.close.mockRejectedValueOnce(new Error('closure pending'))
    await expect(f.factories.observeClaudeVersion(f.binding, '/recorded-neutral')).rejects.toThrow('closure pending')
    await expect(f.factories.observeClaudeVersion(f.binding, '/recorded-neutral')).rejects.toThrow('Retry retained')
    expect(f.command).toHaveBeenCalledOnce()
    await f.factories.disposeAuxiliaries()
    expect(f.close).toHaveBeenCalledTimes(2)
    await f.manager.dispose?.()
  })
  it('closes a version diagnostic without attempting abandonment when no reservation remains', async () => {
    const f = ownedVersion()
    delete f.recovery.launchId
    f.abandon.mockImplementation(async () => { throw new Error('Invalid native launch abandonment scope.') })
    try {
      expect(await f.factories.observeClaudeVersion(f.binding, '/recorded-neutral'))
        .toMatchObject({ version: '2.1.284', positiveProcessClosure: true })
      expect(f.abandon).not.toHaveBeenCalled()
      expect(f.close).toHaveBeenCalledExactlyOnceWith(f.recovery)
    } finally {
      await f.factories.disposeAuxiliaries()
      await f.manager.dispose?.()
    }
  })
  it('preserves reservation failure before a version process starts without requesting missing closure', async () => {
    const f = ownedVersion()
    delete f.recovery.launchId
    const failure = new Error('Reservation storage is full.')
    f.admit.mockImplementation(() => { throw failure })
    f.close.mockImplementation(async () => { throw new Error('No process closure exists.') })
    try {
      await expect(f.factories.observeClaudeVersion(f.binding, '/recorded-neutral')).rejects.toBe(failure)
      expect(f.command).not.toHaveBeenCalled()
      expect(f.abandon).not.toHaveBeenCalled()
      expect(f.close).not.toHaveBeenCalled()
    } finally {
      await f.factories.disposeAuxiliaries()
      await f.manager.dispose?.()
    }
  })
  it('aborts and joins an in-flight version command during the existing factory shutdown phase', async () => {
    const f = ownedVersion(), entered = rejectableDeferred<void>()
    f.command.mockImplementation((...args: unknown[]) => new Promise((_resolve, reject) => {
      const signal = args[3] as AbortSignal
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      entered.resolve()
    }))
    const probe = expect(f.factories.observeClaudeVersion(f.binding, '/recorded-neutral')).rejects.toThrow('shutting down')
    await entered.promise
    f.factories.stopAuxiliaries()
    await Promise.all([probe, f.factories.disposeAuxiliaries()])
    expect(f.close).toHaveBeenCalledOnce()
    await f.manager.dispose?.()
  })
})
