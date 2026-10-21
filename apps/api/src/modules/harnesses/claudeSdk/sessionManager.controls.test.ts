import { describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { NativeSessionStart } from '../port.js'
import type { NativeResponseAvailabilityQuery } from '../responseAvailability.js'
import { claudePromptUuid, type ClaudeMessageTurnInput } from './sessionManager.js'
import { qualification, start, fixture, workflowRequest, deferred, drain } from './__tests__/sessionManager.js'

describe('Claude native session manager admission', () => {
  it('rebinds only the managed credential on a retired live session and rejects busy or changed scope', async () => {
    const http = { type: 'http', url: 'http://127.0.0.1:3000/mcp/app' }
    const f = fixture(undefined, { appMcpAccess: 'management', sdkOptions: { mcpServers: { graphql: http } } })
    const admitted = { ...start, environment: { agentId: 'operator', variables: { FOREMAN_CODE_MCP_TOKEN: 'first-token' } } }
    const updated = { ...admitted, correlationId: 'second',
      environment: { agentId: 'operator', variables: { FOREMAN_CODE_MCP_TOKEN: 'second-token' } } }
    const servers = { graphql: { ...http, headers: { Authorization: 'Bearer second-token' } } }
    try {
      const session = await f.manager.attachSession({ harness: 'claude', providerVersion: '2.1.284', nativeSessionId: 'native-session' }, admitted)
      const running = drain(f.manager.startTurn(session, { prompt: 'First', clientCorrelationId: 'first' }))
      const message = await f.nextMessage()
      await expect(f.manager.refreshSessionCredentials(session, updated, servers)).rejects.toThrow('idle')
      expect(f.setServers).not.toHaveBeenCalled()
      void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'reply-first',
        user_message_uuid: message.uuid })
      void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'result-first',
        user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'Done' })
      await running
      await f.manager.retireTurn!(session, 'first')
      await expect(f.manager.refreshSessionCredentials(session, { ...updated, workingDirectory: '/other' } as NativeSessionStart,
        servers)).rejects.toThrow('owner/configuration')
      await expect(f.manager.refreshSessionCredentials(session, updated,
        { graphql: { ...servers.graphql, url: 'http://127.0.0.1:9999/mcp' } })).rejects.toThrow('server names, endpoints')
      expect(f.setServers).not.toHaveBeenCalled()
      const result = await f.manager.refreshSessionCredentials(session, updated, servers)
      expect(result.httpCredentialAcknowledgement?.endpoint).toBe(http.url)
      expect(f.setServers).toHaveBeenCalledExactlyOnceWith(servers)
      expect(f.queries).toHaveBeenCalledTimes(1)
    } finally { await f.manager.dispose?.() }
  })

  it('inspects only the exact live callback generation/message and performs no SDK response or pending-row lookup', async () => {
    const inspect = vi.fn(async (query: import('./callbackAvailability.js').ClaudeLiveCallbackQuery) => ({
      nativeSessionId: query.nativeSessionId, nativeRequestId: query.nativeRequestId, nativeRequestType: query.nativeRequestType,
      nativeMessageId: query.nativeMessageId, generation: query.generation, qualified: true, state: 'available' as const, path: 'live_callback' as const, reason: 'live_callback' as const,
    }))
    const pending = vi.fn(async () => undefined); const respond = vi.fn(async () => undefined)
    const f = fixture(() => (raw) => {
      const frame = raw as { type: string; session_id?: string; message?: { id: string; content: { id: string }[] } }
      return frame.type === 'assistant' ? [{ type: 'claude.tool', payload: { nativeSessionId: frame.session_id,
        messageId: frame.message?.id, toolUseId: frame.message?.content[0]?.id } }] : []
    }, { qualification: { ...qualification, interactions: true }, liveCallbacks: { inspectCallbackAvailability: inspect }, interactionPort: { pending, respond } })
    const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const subscriber = f.manager.startTurn(session, { prompt: 'one', clientCorrelationId: 'request-one' })[Symbol.asyncIterator]()
    const message = await f.nextMessage()
    const commonQuery: NativeResponseAvailabilityQuery = {
      nativeRequestId: 'native-request-one',
      nativeRequestType: 'can_use_tool',
      expectedNativeTurnId: undefined,
      expectedNativeMessageId: undefined,
      expectedGeneration: undefined,
    }
    const query: import('./callbackAvailability.js').ClaudeResponseAvailabilityQuery = commonQuery
    expect((await f.manager.inspectResponseAvailability!(session, query)).reason).toBe('callback_lost')
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'root-frame', user_message_uuid: message.uuid,
      message: { id: 'api-one', content: [{ type: 'tool_use', id: 'root-tool-one', name: 'Bash', input: {} }] } })
    await subscriber.next(); await subscriber.next()
    const context = f.manager.nativeCallbackContext(session.nativeSessionId, 'root-tool-one')!
    expect(context.nativeMessageId).toBe(message.uuid); expect(context.generation).toBeTruthy()
    const result = await f.manager.inspectResponseAvailability!(session, query)
    expect(result.state).toBe('available'); expect(result.generation).toBe(context.generation); expect(result.nativeTurnId).toBeUndefined()
    expect(inspect).toHaveBeenCalledWith({ ...query, nativeSessionId: session.nativeSessionId, nativeMessageId: message.uuid, generation: context.generation })
    expect(pending).not.toHaveBeenCalled(); expect(respond).not.toHaveBeenCalled()
    expect((await f.manager.inspectResponseAvailability!(session, { ...query, expectedNativeTurnId: 'not-a-native-turn' })).reason).toBe('identity_mismatch')
    query.expectedNativeMessageId = message.uuid
    query.expectedGeneration = context.generation
    expect((await f.manager.inspectResponseAvailability!(session, query)).state).toBe('available')
    const beforeMismatch = inspect.mock.calls.length
    query.expectedNativeMessageId = 'older-native-message'
    expect((await f.manager.inspectResponseAvailability!(session, query)).reason).toBe('identity_mismatch')
    query.expectedNativeMessageId = message.uuid
    query.expectedGeneration = 'older-runtime-generation'
    expect((await f.manager.inspectResponseAvailability!(session, query)).reason).toBe('identity_mismatch')
    expect(inspect.mock.calls.length).toBe(beforeMismatch)
    query.expectedGeneration = context.generation
    inspect.mockImplementationOnce(async q => ({ nativeSessionId: q.nativeSessionId, nativeRequestId: q.nativeRequestId,
      nativeRequestType: q.nativeRequestType, nativeMessageId: 'wrong-resident-message', generation: q.generation,
      qualified: true, state: 'available', path: 'live_callback', reason: 'live_callback' }))
    expect((await f.manager.inspectResponseAvailability!(session, query)).reason).toBe('identity_mismatch')

    inspect.mockImplementation(async (q) => ({ nativeSessionId: q.nativeSessionId, nativeRequestId: q.nativeRequestId,
      nativeRequestType: q.nativeRequestType, nativeMessageId: q.nativeMessageId, generation: 'old-generation', qualified: true, state: 'available', path: 'live_callback', reason: 'live_callback' }))
    expect((await f.manager.inspectResponseAvailability!(session, query)).reason).toBe('identity_mismatch')
    await subscriber.return?.(); await f.manager.close(session)
    expect((await f.manager.inspectResponseAvailability!(session, query)).reason).toBe('session_closed')
    await f.manager.dispose?.()
  })

  it('does not recreate callback availability from a persisted accepted receipt after restart', async () => {
    const inspect = vi.fn()
    const f = fixture(undefined, { qualification: { ...qualification, interactions: true }, liveCallbacks: { inspectCallbackAvailability: inspect } })
    const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    f.client.getSessionMessages = async () => [{ type: 'user', uuid: claudePromptUuid('request-old'), session_id: session.nativeSessionId, parent_tool_use_id: null }]
    await f.manager.reconcile(session, 'request-old')
    const result = await f.manager.inspectResponseAvailability!(session, { nativeRequestId: 'persisted-question', nativeRequestType: 'can_use_tool' })
    expect(result.reason).toBe('callback_lost'); expect(result.state).toBe('unavailable'); expect(inspect).not.toHaveBeenCalled()
    await f.manager.dispose?.()
  })

  it('offers exactly one initial input before observed SID, then persists SID before its native input receipt', async () => {
    const f = fixture(); const order: string[] = []
    let boundSession: import('@foreman-code/contracts').NativeSessionReference | undefined
    const result = drain(f.manager.startInitialTurn(start, { prompt: 'first accepted prompt', clientCorrelationId: 'operator:one',
      onSessionObserved: async (session) => { order.push('session'); boundSession = session },
      onMessageSubmitted: async (receipt) => { expect(boundSession?.nativeSessionId).toBe(receipt.nativeSessionId); order.push('message') },
    }))
    expect(boundSession).toBeUndefined()
    const input = await f.nextMessage()
    expect(input.uuid).toBe(claudePromptUuid('operator:one'))
    void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply', user_message_uuid: input.uuid, message: { id: 'api-first', content: [] } })
    void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result', user_message_uuid: input.uuid, subtype: 'success', is_error: false, result: 'done' })
    await result
    expect(order).toEqual(['session', 'message'])
    expect((await f.manager.reconcile(boundSession!, 'operator:one')).terminalResult?.output).toBe('done')
    // A retry returns the existing attempt; it cannot start another SDK process or offer another input.
    const retry = f.manager.startInitialTurn(start, { prompt: 'first accepted prompt', clientCorrelationId: 'operator:one', onSessionObserved: async () => undefined })
    expect(await drain(retry)).toEqual([])
    await f.manager.dispose?.()
  })

  it('publishes the body only after observed native SID persistence completes', async () => {
    const sentinel = 'Body after session persistence'
    const f = fixture(() => raw => {
      const frame = raw as { type: string; message?: { content: { text: string }[] } }
      return frame.type === 'assistant'
        ? [{ type: 'claude.text', payload: { text: frame.message!.content[0]!.text } }]
        : []
    })
    const saving = deferred<void>()
    const entered = deferred<void>()
    const submitted = vi.fn(async () => undefined)
    const received: import('@foreman-code/contracts').NativeHarnessEvent[] = []
    const result = (async () => {
      for await (const event of f.manager.startInitialTurn(start, {
        prompt: 'first', clientCorrelationId: 'operator:one',
        onSessionObserved: async () => { entered.resolve(); await saving.promise },
        onMessageSubmitted: submitted,
      })) received.push(event)
    })()
    try {
      const input = await f.nextMessage()
      void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply',
        user_message_uuid: input.uuid, message: { id: 'api-reply', content: [{ type: 'text', text: sentinel }] } })
      void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result',
        user_message_uuid: input.uuid, subtype: 'success', is_error: false, result: 'done' })
      await entered.promise
      await new Promise(resolve => setImmediate(resolve))
      expect(submitted).not.toHaveBeenCalled()
      expect(received.filter(event => event.type === 'claude.text')).toEqual([])
      saving.resolve()
      await result
      expect(submitted).toHaveBeenCalledTimes(1)
      expect(received.filter(event => event.type === 'claude.text')).toMatchObject([
        { payload: { text: sentinel } },
      ])
    } finally {
      saving.resolve()
      await f.manager.dispose?.()
    }
  })

  it('inspects real SDK control health before input and retains exactly the same query for the first turn', async () => {
    const f = fixture(undefined, { expectedMcp: { serverName: 'graphql', url: 'http://127.0.0.1:3000/mcp/app' } })
    const inspection = await f.manager.prepareInspection(start)
    expect(inspection.initializationAnswered).toBe(true)
    expect(inspection.servers[0]?.status).toBe('connected')
    expect(JSON.stringify(inspection)).not.toContain('secret-token')
    expect((await f.manager.inspectMcp()).state).toBe('connected')
    expect(f.queries).toHaveBeenCalledTimes(1)
    let observed: import('@foreman-code/contracts').NativeSessionReference | undefined
    const result = drain(f.manager.startInitialTurn(start, { prompt: 'first', clientCorrelationId: 'operator:one', onSessionObserved: async (session) => { observed = session } }))
    const input = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply', user_message_uuid: input.uuid })
    void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result', user_message_uuid: input.uuid, subtype: 'success', is_error: false, result: 'done' })
    await result
    expect(observed?.nativeSessionId).toBe('native-session'); expect(f.queries).toHaveBeenCalledTimes(1)
    await f.manager.dispose?.()
  })

  it('keeps the complete accepted workflow request through JSON readback', async () => {
    const f = fixture()
    const request = workflowRequest()
    const workflow = { request, correlationId: 'execution:execution' }
    const readback = { correlationId: workflow.correlationId,
      request: { ...request, input: { second: 'two', first: 'one' } } }
    const prompt = 'first\nworkflow notice'
    try {
      await f.manager.prepareInspection(workflow)
      await f.manager.prepareInspection(readback)
      await expect(f.manager.prepareInspection({ ...workflow, request: { ...request,
        input: { first: 'changed', second: 'two' } } })).rejects.toThrow('immutable inspection context')
      await expect(f.manager.prepareInspection({ ...workflow, request: { ...request,
        initialPrompt: 'changed' } })).rejects.toThrow('immutable inspection context')
      await expect(f.manager.prepareInspection({ ...workflow, request: { ...request,
        executionContext: { parentRequest: { requestId: 'foreign', requesterNodeId: 'foreign' } } } }))
        .rejects.toThrow('immutable inspection context')
      const running = drain(f.manager.startInitialTurn(readback, { prompt,
        clientCorrelationId: 'execution:execution', onSessionObserved: async () => undefined }))
      const input = await f.nextMessage()
      void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply', user_message_uuid: input.uuid })
      void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result', user_message_uuid: input.uuid,
        subtype: 'success', is_error: false, result: 'done' })
      await running
      await drain(f.manager.startInitialTurn(workflow, { prompt,
        clientCorrelationId: 'execution:execution', onSessionObserved: async () => undefined }))
      expect(() => f.manager.startInitialTurn(readback, { prompt: 'changed',
        clientCorrelationId: 'execution:execution', onSessionObserved: async () => undefined }))
        .toThrow('another accepted scope')
      expect(f.queries).toHaveBeenCalledTimes(1)
      expect(f.offers).toHaveBeenCalledTimes(1)
    } finally {
      await f.manager.dispose?.()
    }
  })

  it.each(['native-v1', 'legacy'] as const)('delivers pinned Agent instructions through the %s channel', async delivery => {
    const f = fixture(undefined, { sdkOptions: { systemPrompt: 'Harness policy' } })
    const request = workflowRequest()
    const text = 'Follow the saved output format.'
    request.configuration.prompt.system = 'Return one raw JSON object.'
    request.configuration.assignedSkills = [{ skillId: 'format', version: '1' }]
    request.configuration.resolvedSkills = [{ skillId: 'format', version: '1', name: 'Format', instructions: text,
      contentHash: `sha256:${createHash('sha256').update(text).digest('hex')}` }]
    if (delivery === 'native-v1') request.configuration.instructionDelivery = 'native-v1'
    try {
      await f.manager.prepareInspection({ request, correlationId: 'execution:execution' })
      const options = f.queries.mock.calls[0]![0].options
      if (delivery === 'native-v1') {
        expect(options.systemPrompt).toBe('Harness policy\n\nReturn one raw JSON object.\n\n# Skill: Format (format@1)\n\n' + text)
      } else {
        expect(options.systemPrompt).toBe('Harness policy')
      }
      expect(f.offers).not.toHaveBeenCalled()
    } finally {
      await f.manager.dispose?.()
    }
  })

  it('retains the original attributed result in terminal history for workflow validation', async () => {
    const f = fixture(() => raw => {
      const frame = raw as Record<string, unknown>
      return frame.type === 'result' ? [{ type: 'claude.result', payload: { source: { eventId: frame.uuid } } }] : []
    })
    let history: import('../port.js').NativeHistory | undefined
    try {
      const running = drain(f.manager.startInitialTurn(start, { prompt: 'first', clientCorrelationId: 'operator:one',
        onSessionObserved: async () => undefined, onTerminal: async terminal => { history = terminal.history } }))
      const input = await f.nextMessage()
      void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply', user_message_uuid: input.uuid })
      const result = { type: 'result', session_id: 'native-session', uuid: 'result', user_message_uuid: input.uuid,
        subtype: 'success', is_error: false, result: 'done' }
      void f.frames.offer(result)
      await running
      expect(history?.events.find(event => event.type === 'claude.result')?.payload.nativeResult).toEqual(result)
    } finally {
      await f.manager.dispose?.()
    }
  })

  it('does not treat saved MCP config as live connected or replace a prepared owner/query', async () => {
    const f = fixture(undefined, { expectedMcp: { serverName: 'graphql', url: 'http://127.0.0.1:3000/mcp/app' } })
    f.statuses.mockResolvedValueOnce([{ name: 'graphql', status: 'pending', source: 'dynamic', config: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app', headers: { Authorization: 'secret-token' } }, tools: [] }])
    const snapshot = await f.manager.prepareInspection(start)
    expect(snapshot.servers[0]?.status).toBe('pending')
    await expect(f.manager.prepareInspection({ ...start, workingDirectory: '/foreign' } as NativeSessionStart)).rejects.toThrow('working directory')
    await expect(f.manager.prepareInspection({ ...start, correlationId: 'other-owner' } as NativeSessionStart)).rejects.toThrow('immutable inspection context')
    expect(f.queries).toHaveBeenCalledTimes(1)
    await f.manager.dispose?.()
  })

  it('refreshes only the managed HTTP credential while retaining the same in-process SDK server', async () => {
    const instance: { self?: unknown } = {}
    instance.self = instance
    const fileServer = { type: 'sdk', name: 'graphql-files', instance }
    const http = { type: 'http', url: 'http://127.0.0.1:3000/mcp/app' }
    const base = { graphql: http, 'graphql-files': fileServer }
    const f = fixture(undefined, { sdkOptions: { mcpServers: base }, appMcpAccess: 'management' })
    const tokenFree = { ...start, environment: { agentId: 'operator', variables: {} } }
    const credentialed = { ...start, environment: { agentId: 'operator',
      variables: { FOREMAN_CODE_MCP_TOKEN: 'scoped-credential' } } }
    const servers = { ...base, graphql: { ...http, headers: { Authorization: 'Bearer scoped-credential' } } }
    try {
      await f.manager.prepareInspection(tokenFree)
      const inspected = await f.manager.refreshInspectionCredentials(credentialed, servers)
      expect(inspected.httpCredentialAcknowledgement?.endpoint).toBe(http.url)
      expect(f.setServers).toHaveBeenCalledWith(servers)
      expect(f.queries).toHaveBeenCalledOnce()
      await expect(f.manager.refreshInspectionCredentials(credentialed, {
        ...servers, 'graphql-files': { ...fileServer, instance: {} },
      })).rejects.toThrow('unrelated native MCP servers')
      await expect(f.manager.refreshInspectionCredentials(credentialed, {
        ...servers, graphql: { ...servers.graphql, url: 'http://127.0.0.1:9999/mcp' },
      })).rejects.toThrow('server names, endpoints')
      expect(f.setServers).toHaveBeenCalledOnce()
    } finally { await f.manager.dispose?.() }
  })

  it('refreshes a token-free failed HTTP connection on the same query before offering input', async () => {
    const endpoint = 'http://127.0.0.1:3000/mcp/app'
    const servers = { graphql: { type: 'http', url: endpoint } }
    const f = fixture(undefined, { sdkOptions: { mcpServers: servers }, appMcpAccess: 'management',
      expectedMcp: { serverName: 'graphql', url: endpoint } })
    f.statuses.mockResolvedValueOnce([{ name: 'graphql', status: 'failed', source: 'dynamic',
      config: { type: 'http', url: endpoint, headers: { Authorization: '' } }, tools: [] }])
    try {
      const tokenFree = { ...start, environment: { agentId: 'operator', variables: {} } }
      const inspection = await f.manager.prepareInspection(tokenFree)
      expect(inspection.servers[0]?.status).toBe('failed')
      expect(inspection.httpCredentialAcknowledgement).toBeUndefined()
      expect(f.offers).not.toHaveBeenCalled()
      const credentialed = { ...start, environment: { agentId: 'operator', variables: {
        FOREMAN_CODE_MCP_TOKEN: 'scoped-token',
      } } }
      await f.manager.refreshInspectionCredentials(credentialed, {
        graphql: { ...servers.graphql, headers: { Authorization: 'Bearer scoped-token' } },
      })
      expect(await f.manager.inspectMcp()).toMatchObject({ state: 'connected',
        credentialArrangement: { kind: 'scoped_http_header' } })
      expect(f.queries).toHaveBeenCalledTimes(1)
      expect(f.offers).not.toHaveBeenCalled()
    } finally {
      await f.manager.dispose?.()
    }
  })

  it.each([
    ['GRAPHQL_MCP_TOKEN', 'GRAPHQL_MCP_TOKEN'],
    ['GRAPHQL_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN'],
    ['FOREMAN_CODE_MCP_TOKEN', 'GRAPHQL_MCP_TOKEN'],
    ['FOREMAN_CODE_MCP_TOKEN', 'FOREMAN_CODE_MCP_TOKEN'],
  ])('delivers scoped %s credentials and starts with %s on the same inspected query', async (refreshName, startName) => {
    const baseServers = { graphql: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app' } }
    const f = fixture(undefined, { sdkOptions: { mcpServers: baseServers }, appMcpAccess: 'management', credentialEnvironmentVariables: ['GRAPHQL_MCP_TOKEN'] })
    const tokenFree = { ...start, environment: { agentId: 'operator', variables: {} } }
    const credentialed = { ...start, environment: { agentId: 'operator', variables: { [refreshName]: 'scoped-token' } } }
    await f.manager.prepareInspection(tokenFree)
    const servers = { graphql: { ...baseServers.graphql, headers: { Authorization: 'Bearer scoped-token' } } }
    const health = await f.manager.refreshInspectionCredentials(credentialed, servers)
    expect(health.servers[0]?.status).toBe('connected')
    expect(f.setServers).toHaveBeenCalledWith(servers); expect(f.queries).toHaveBeenCalledTimes(1)
    const admitted = { ...start, environment: { agentId: 'operator', variables: { [startName]: 'scoped-token' } } }
    expect(await f.manager.prepareInspection(admitted)).toMatchObject({
      generation: health.generation, currentAuthorizationScope: health.currentAuthorizationScope,
      httpCredentialAcknowledgement: health.httpCredentialAcknowledgement,
    })
    await expect(f.manager.prepareInspection({ ...admitted, environment: {
      agentId: 'operator', variables: { [startName]: 'another-token' },
    } })).rejects.toThrow('immutable inspection context')
    expect(f.offers).not.toHaveBeenCalled()
    const result = drain(f.manager.startInitialTurn(admitted, { prompt: 'one', clientCorrelationId: 'operator:one', onSessionObserved: async () => undefined }))
    const input = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply', user_message_uuid: input.uuid })
    void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result', user_message_uuid: input.uuid, subtype: 'success', is_error: false, result: 'done' })
    await result
    const session = { harness: 'claude' as const, providerVersion: '2.1.284', nativeSessionId: 'native-session' }
    expect(await f.manager.attachSession(session, credentialed)).toEqual(session)
    expect(f.offers).toHaveBeenCalledOnce()
    expect(f.queries).toHaveBeenCalledTimes(1)
    await f.manager.dispose?.()
  })

  it('does not turn static configured headers, environment or connected health into an HTTP credential ACK', async () => {
    const servers = { graphql: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app', headers: { Authorization: 'Bearer static-secret' } } }
    const f = fixture(undefined, { sdkOptions: { mcpServers: servers }, appMcpAccess: 'management', expectedMcp: { serverName: 'graphql', url: servers.graphql.url } })
    const credentialed = { ...start, environment: { agentId: 'operator', variables: { GRAPHQL_MCP_TOKEN: 'static-secret' } } }
    const snapshot = await f.manager.prepareInspection(credentialed)
    expect(snapshot.httpCredentialAcknowledgement).toBeUndefined()
    expect((await f.manager.inspectMcp()).credentialArrangement).toEqual({ kind: 'unknown' })
    expect(JSON.stringify(snapshot)).not.toContain('static-secret')
    expect(f.setServers).not.toHaveBeenCalled()
    await f.manager.dispose?.()
  })

  it('retains only the actual managed HTTP update ACK across readback and rotates its opaque credential scope', async () => {
    const servers = { graphql: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app' } }
    const f = fixture(undefined, { sdkOptions: { mcpServers: servers }, appMcpAccess: 'management', expectedMcp: { serverName: 'graphql', url: servers.graphql.url } })
    const admitted = (token: string) => ({ ...start, environment: { agentId: 'operator', variables: { GRAPHQL_MCP_TOKEN: token } } })
    const configured = (token: string) => ({ graphql: { ...servers.graphql, headers: { Authorization: `Bearer ${token}` } } })
    const initial = await f.manager.prepareInspection({ ...start, environment: { agentId: 'operator', variables: {} } })
    const update = deferred<Awaited<ReturnType<typeof f.setServers>>>()
    const health = deferred<Awaited<ReturnType<typeof f.statuses>>>()
    const entered = deferred<void>(); const healthEntered = deferred<void>()
    f.statuses.mockImplementationOnce(() => { healthEntered.resolve(); return health.promise })
    f.setServers.mockImplementationOnce(() => { entered.resolve(); return update.promise })
    const refreshing = f.manager.refreshInspectionCredentials(admitted('private-first-token'), configured('private-first-token'))
    await entered.promise
    expect(initial.httpCredentialAcknowledgement).toBeUndefined()
    expect(f.offers).not.toHaveBeenCalled()
    await expect(f.manager.inspectMcp()).rejects.toThrow('another control operation')
    update.resolve({ added: ['graphql'], removed: [], errors: {} })
    await healthEntered.promise
    await expect(f.manager.refreshInspectionCredentials(admitted('private-first-token'), configured('private-first-token'))).rejects.toThrow('another owned SDK control operation')
    health.resolve(await f.statuses.mock.results[0]!.value)
    const first = await refreshing
    expect(first.httpCredentialAcknowledgement).toEqual({ source: 'sdk_set_mcp_servers', serverName: 'graphql', endpoint: servers.graphql.url,
      generation: first.generation, authorizationScope: first.currentAuthorizationScope })
    expect(first.currentAuthorizationScope).toMatch(/^[a-f0-9]{64}$/)
    expect((await f.manager.prepareInspection(admitted('private-first-token'))).httpCredentialAcknowledgement).toEqual(first.httpCredentialAcknowledgement)
    expect((await f.manager.inspectMcp()).credentialArrangement).toEqual({ kind: 'scoped_http_header' })
    const second = await f.manager.refreshInspectionCredentials(admitted('private-second-token'), configured('private-second-token'))
    expect(second.currentAuthorizationScope).not.toBe(first.currentAuthorizationScope)
    expect(second.httpCredentialAcknowledgement?.authorizationScope).toBe(second.currentAuthorizationScope)
    expect(second.generation).toBe(first.generation)
    const connected: Awaited<ReturnType<typeof f.statuses>> = await f.statuses.mock.results[0]!.value
    f.statuses.mockResolvedValueOnce(connected.map((row) => ({ ...row, status: 'pending' })))
    expect((await f.manager.inspectMcp()).credentialArrangement).toEqual({ kind: 'unknown' })
    expect((await f.manager.prepareInspection(admitted('private-second-token'))).httpCredentialAcknowledgement).toEqual(second.httpCredentialAcknowledgement)
    expect(JSON.stringify([first, second, await f.manager.inspectMcp()])).not.toMatch(/private-(first|second)-token/)
    expect(f.queries).toHaveBeenCalledTimes(1)
    expect(f.close).not.toHaveBeenCalled()
    await f.manager.dispose?.()
    await expect(f.manager.prepareInspection(admitted('private-second-token'))).rejects.toThrow('disposed')
    const fresh = fixture(undefined, { sdkOptions: { mcpServers: configured('private-second-token') }, appMcpAccess: 'management', expectedMcp: { serverName: 'graphql', url: servers.graphql.url } })
    const freshSnapshot = await fresh.manager.prepareInspection(admitted('private-second-token'))
    expect(freshSnapshot.generation).not.toBe(second.generation)
    expect(freshSnapshot.httpCredentialAcknowledgement).toBeUndefined()
    expect((await fresh.manager.inspectMcp()).credentialArrangement).toEqual({ kind: 'unknown' })
    await fresh.manager.dispose?.()
  })

  it.each(['server-error', 'rejected-ack', 'foreign-ack', 'wrong-token', 'wrong-owner'] as const)('clears an older HTTP credential receipt on %s refresh failure', async (failure) => {
    const servers = { graphql: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app' } }
    const f = fixture(undefined, { sdkOptions: { mcpServers: servers }, appMcpAccess: 'management', expectedMcp: { serverName: 'graphql', url: servers.graphql.url } })
    const credentialed = { ...start, environment: { agentId: 'operator', variables: { GRAPHQL_MCP_TOKEN: 'private-accepted-token' } } }
    const configured = { graphql: { ...servers.graphql, headers: { Authorization: 'Bearer private-accepted-token' } } }
    await f.manager.prepareInspection({ ...start, environment: { agentId: 'operator', variables: {} } })
    const accepted = await f.manager.refreshInspectionCredentials(credentialed, configured)
    expect(accepted.httpCredentialAcknowledgement).toBeDefined()
    if (failure === 'server-error') f.setServers.mockResolvedValueOnce({ added: [], removed: [], errors: { graphql: 'native refusal with private data' } })
    if (failure === 'rejected-ack') f.setServers.mockRejectedValueOnce(new Error('native refusal private-accepted-token'))
    if (failure === 'foreign-ack') f.setServers.mockResolvedValueOnce({ added: ['foreign'], removed: [], errors: {} })
    const nextStart = failure === 'wrong-owner' ? { ...credentialed, correlationId: 'foreign-owner' } : credentialed
    const nextServers = failure === 'wrong-token' ? { graphql: { ...servers.graphql, headers: { Authorization: 'Bearer private-foreign-token' } } } : configured
    const error = await f.manager.refreshInspectionCredentials(nextStart, nextServers).catch((value: unknown) => value)
    expect(error).toBeInstanceOf(Error)
    expect(JSON.stringify(error)).not.toMatch(/private-|native refusal/)
    const readback = await f.manager.prepareInspection(credentialed)
    expect(readback.httpCredentialAcknowledgement).toBeUndefined()
    expect((await f.manager.inspectMcp()).credentialArrangement).toEqual({ kind: 'unknown' })
    expect(f.queries).toHaveBeenCalledTimes(1)
    await f.manager.dispose?.()
  })

  it('denies management credential refresh for forbidden roles or changed endpoints/noncredential environment', async () => {
    const f = fixture()
    await f.manager.prepareInspection(start)
    await expect(f.manager.refreshInspectionCredentials(start, {})).rejects.toThrow('no management MCP')
    expect(f.setServers).not.toHaveBeenCalled(); await f.manager.dispose?.()
    const g = fixture(undefined, { appMcpAccess: 'management', sdkOptions: { mcpServers: { graphql: { type: 'http', url: 'http://local/mcp' } } } })
    await g.manager.prepareInspection(start)
    await expect(g.manager.refreshInspectionCredentials(start, { graphql: { type: 'http', url: 'http://foreign/mcp' } })).rejects.toThrow('server names')
    expect(g.setServers).not.toHaveBeenCalled(); await g.manager.dispose?.()
  })

  it('settles an owned pre-input control timeout by closing/joining the same SDK query', async () => {
    const f = fixture(undefined, { initializationTimeoutMs: 10 })
    let rejectControl!: (reason: unknown) => void
    const waiting = new Promise<readonly unknown[]>((_resolve, reject) => { rejectControl = reject })
    f.client.query = (input) => {
      f.queries(input)
      return { [Symbol.asyncIterator]: () => f.frames[Symbol.asyncIterator](), initializationResult: async () => ({}),
        mcpServerStatus: () => waiting, interrupt: async () => undefined,
        close: () => { rejectControl(new Error('owned SDK control closed')); f.frames.close(); f.close() } }
    }
    await expect(f.manager.prepareInspection(start)).rejects.toThrow('owned SDK control closed')
    expect(f.queries).toHaveBeenCalledTimes(1); expect(f.close).toHaveBeenCalled()
    await f.manager.dispose?.()
  })

  const controlRaces = (['prepare', 'inspect', 'refresh-update', 'refresh-health'] as const).flatMap((controlKind) =>
    (controlKind.startsWith('refresh') ? ['initial'] as const : ['initial', 'later'] as const).flatMap((inputKind) =>
      (['abort', 'timeout'] as const).map((ending) => ({ controlKind, inputKind, ending }))))

  it.each(controlRaces)('$controlKind fences $inputKind input through $ending cleanup', async ({ controlKind, inputKind, ending }) => {
    const refresh = controlKind.startsWith('refresh')
    const servers = { graphql: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app' } }
    const f = fixture(undefined, { initializationTimeoutMs: 50, appMcpAccess: 'management', sdkOptions: { mcpServers: servers } })
    const joined = deferred<void>(); const closed = deferred<void>(); const entered = deferred<void>()
    const waiting = deferred<Awaited<ReturnType<typeof f.statuses>>>()
    const update = deferred<Awaited<ReturnType<typeof f.setServers>>>()
    const query = f.client.query
    f.client.query = async (input) => ({ ...await query(input), joinClosed: () => joined.promise })
    await f.manager.prepareInspection(start)
    let session: import('@foreman-code/contracts').NativeSessionReference | undefined
    if (inputKind === 'later') {
      const result = drain(f.manager.startInitialTurn(start, { prompt: 'first', clientCorrelationId: 'operator:one', onSessionObserved: async (value) => { session = value } }))
      const message = await f.nextMessage()
      void f.frames.offer({ type: 'assistant', session_id: 'native-session', uuid: 'reply', user_message_uuid: message.uuid })
      void f.frames.offer({ type: 'result', session_id: 'native-session', uuid: 'result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'done' })
      await result
    }
    if (controlKind === 'refresh-update') f.setServers.mockImplementationOnce(() => { entered.resolve(); return update.promise })
    else f.statuses.mockImplementationOnce(() => { entered.resolve(); return waiting.promise })
    f.close.mockImplementation(() => {
      const error = new Error('owned delayed control closed')
      if (controlKind === 'refresh-update') update.reject(error); else waiting.reject(error)
      f.frames.close(); closed.resolve()
    })
    const abort = new AbortController()
    const control = refresh ? f.manager.refreshInspectionCredentials(start, servers, abort.signal)
      : controlKind === 'prepare' ? f.manager.prepareInspection(start, abort.signal) : f.manager.inspectMcp(abort.signal)
    let settled = false
    const outcome = control.then(() => { settled = true; return undefined }, (error: unknown) => { settled = true; return error })
    await entered.promise
    const baseline = f.offers.mock.calls.length
    let initialError: unknown
    if (inputKind === 'initial') {
      const observer = drain(f.manager.startInitialTurn(start, { prompt: 'blocked', clientCorrelationId: 'operator:one', onSessionObserved: async () => undefined }))
      void observer.catch((error: unknown) => { initialError = error })
      await new Promise<void>((resolve) => setImmediate(resolve))
    } else {
      try { f.manager.startTurn(session!, { prompt: 'blocked', clientCorrelationId: 'request-blocked' }) } catch (error) { initialError = error }
    }
    const offersWhileControlPending = f.offers.mock.calls.length
    if (ending === 'abort') abort.abort(new Error('inspection cancelled'))
    await closed.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    const settledBeforeJoin = settled
    joined.resolve()
    expect(await outcome).toBeInstanceOf(Error)
    expect(initialError).toMatchObject({ result: { error: { code: 'CLAUDE_INSPECTION_BUSY' } } })
    expect(offersWhileControlPending).toBe(baseline)
    expect(settledBeforeJoin).toBe(false)
    expect(f.offers).toHaveBeenCalledTimes(baseline)
    expect(f.queries).toHaveBeenCalledTimes(1)
    expect(f.close).toHaveBeenCalledTimes(1)
    await f.manager.dispose?.()
  })

  it('releases a successful control reservation before accepting a fenced reusable correlation', async () => {
    const f = fixture()
    await f.manager.prepareInspection(start)
    void f.frames.offer({ type: 'system', subtype: 'init', session_id: 'native-session', claude_code_version: '2.1.284', cwd: '/work' })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const entered = deferred<void>(); const status = deferred<Awaited<ReturnType<typeof f.statuses>>>()
    f.statuses.mockImplementationOnce(() => { entered.resolve(); return status.promise })
    const inspecting = f.manager.inspectMcp()
    await entered.promise
    expect(() => f.manager.startTurn(session, { prompt: 'later', clientCorrelationId: 'fenced-correlation' })).toThrow('control operation is pending')
    await expect(f.manager.inspectMcp()).rejects.toThrow('another control operation')
    status.resolve(await f.statuses.mock.results[0]!.value)
    await inspecting
    const result = drain(f.manager.startTurn(session, { prompt: 'later', clientCorrelationId: 'fenced-correlation' }))
    const message = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'later-reply', user_message_uuid: message.uuid })
    void f.frames.offer({ type: 'result', session_id: session.nativeSessionId, uuid: 'later-result', user_message_uuid: message.uuid, subtype: 'success', is_error: false, result: 'done' })
    await result
    expect(f.offers).toHaveBeenCalledTimes(1)
    expect(f.close).not.toHaveBeenCalled()
    await f.manager.dispose?.()
  })

  it.each(['update', 'health'] as const)('holds credential refresh reservation through delayed %s and its ACK-to-health handoff', async (phase) => {
    const baseServers = { graphql: { type: 'http', url: 'http://127.0.0.1:3000/mcp/app' } }
    const f = fixture(undefined, { sdkOptions: { mcpServers: baseServers }, appMcpAccess: 'management' })
    await f.manager.prepareInspection(start)
    const entered = deferred<void>(); const update = deferred<Awaited<ReturnType<typeof f.setServers>>>()
    const health = deferred<Awaited<ReturnType<typeof f.statuses>>>()
    if (phase === 'update') f.setServers.mockImplementationOnce(() => { entered.resolve(); return update.promise })
    else f.statuses.mockImplementationOnce(() => { entered.resolve(); return health.promise })
    const refreshing = f.manager.refreshInspectionCredentials(start, baseServers)
    await entered.promise
    const observer = drain(f.manager.startInitialTurn(start, { prompt: 'blocked', clientCorrelationId: 'operator:one', onSessionObserved: async () => undefined }))
    let inputError: unknown
    void observer.catch((error: unknown) => { inputError = error })
    await new Promise<void>((resolve) => setImmediate(resolve))
    const offersWhilePending = f.offers.mock.calls.length
    if (phase === 'update') update.resolve({ added: ['graphql'], removed: [], errors: {} })
    else health.resolve(await f.statuses.mock.results[0]!.value)
    const result = await refreshing
    expect(inputError).toMatchObject({ result: { error: { code: 'CLAUDE_INSPECTION_BUSY' } } })
    expect(offersWhilePending).toBe(0)
    expect(result.servers[0]?.status).toBe('connected')
    expect(f.setServers).toHaveBeenCalledTimes(1)
    expect(f.statuses).toHaveBeenCalledTimes(2)
    expect(f.queries).toHaveBeenCalledTimes(1)
    expect(f.close).not.toHaveBeenCalled()
    await f.manager.dispose?.()
  })

  it('wakes the owned iterator from exact actual callback notification and returns complete pending state', async () => {
    let pending: import('@foreman-code/contracts').PendingNativeInteraction[] = []
    const f = fixture(() => (raw) => {
      const frame = raw as { type: string; session_id?: string; message?: { id: string; content: { id: string }[] } }
      return frame.type === 'assistant' ? [{ type: 'claude.tool', payload: { nativeSessionId: frame.session_id, messageId: frame.message?.id, toolUseId: frame.message?.content[0]?.id } }] : []
    }, { pendingInteractions: () => pending })
    const session = await f.manager.attachSession({ harness: f.manager.harness, providerVersion: '2.1.284', nativeSessionId: 'native-session' }, start)
    const output = f.manager.startTurn(session, { prompt: 'permission', clientCorrelationId: 'request-A', callbackAuthority: { ownerPrincipalId: 'sender-A', attemptId: 'attempt-A' } } as ClaudeMessageTurnInput)[Symbol.asyncIterator]()
    const input = await f.nextMessage()
    void f.frames.offer({ type: 'assistant', session_id: session.nativeSessionId, uuid: 'tool-frame', user_message_uuid: input.uuid, message: { id: 'api-A', content: [{ type: 'tool_use', id: 'tool-A', name: 'Read', input: {} }] } })
    await output.next(); await output.next()
    const context = f.manager.nativeCallbackContext(session.nativeSessionId, 'tool-A')!
    expect(f.manager.callbackAuthority(context)).toEqual({ ownerPrincipalId: 'sender-A', attemptId: 'attempt-A' })
    expect(f.manager.callbackAuthority({ ...context, nativeMessageId: 'foreign-input' })).toBeUndefined()
    pending = [{ session, turn: { nativeMessageId: input.uuid, nativeRequestId: 'rpc-A' }, nativeRequestType: 'can_use_tool', request: {}, responseOptions: [{ id: 'allow', label: 'Allow', semantic: 'approve_once' }] }] as unknown as import('@foreman-code/contracts').PendingNativeInteraction[]
    const wake = output.next()
    f.manager.notifyPendingChanged({ ...context, nativeRequestId: 'rpc-A', nativeRequestType: 'can_use_tool' })
    expect((await wake).value?.type).toBe('interaction.pending')
    expect((await f.manager.history(session)).pendingInteractions).toEqual(pending)
    expect((await f.manager.reconcile(session, 'request-A')).pendingInteractions).toEqual(pending)
    expect((await f.manager.reconcile(session, 'foreign-correlation')).pendingInteractions).toEqual([])
    await output.return?.(); await f.manager.dispose?.()
  })
})
