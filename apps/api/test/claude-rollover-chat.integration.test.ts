import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { AgentChatStateSchema, SendAgentChatMessageResponseSchema } from '@foreman-code/contracts/agent-chat'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'
import { waitForDelivery } from './helpers/agentChatDelivery.js'
import { graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { productionClaudeFixture } from './support/claudeProduction.js'
import { claudeSdkToolTransport } from './support/claudeSdkToolTransport.js'
import { rejectableDeferred } from './helpers/deferred.js'

it('settles an unoffered rollover failure and retries through authenticated Agent MCP without replaying earlier inputs', async () => {
  const db = await agent3Database()
  const claimReady = rejectableDeferred()
  const resumeEntered = rejectableDeferred()
  const resumeReady = rejectableDeferred()
  const completionHeld = rejectableDeferred()
  const completionReleased = rejectableDeferred()
  let completionTimer: ReturnType<typeof setTimeout> | undefined
  let chat: AgentChatService | undefined
  let app: ReturnType<typeof buildApp> | undefined
  let manager: ReturnType<typeof productionClaudeFixture>['manager'] | undefined
  try {
    const harness: ClaudeHarnessConfiguration = { harness: 'claude', model: 'recorded-model', authMode: 'subscription',
      configDirectory: '/recorded/profile', permissionMode: 'default', sandbox: 'danger-full-access', tools: [],
      permissionRules: [], instructions: '', mcpServers: {} }
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
    fixture.configurations = fixture.configurations.map(value => AgentConfigurationVersionSchema.parse({ ...value, harness }))
    const seeded = await seedAgent3(db.pool, db.directory, fixture, { run: false })
    const node = seeded.version.definition.nodes[0]!
    const access = new PostgresAccessService(db.pool)
    const owner = await access.issue({ name: 'rollover writer', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: {} }] })
    const reader = await access.issue({ name: 'rollover reader', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agent_chat:read'], scope: {} }] })
    const repository = new PostgresAgentChatRepository(db.pool)
    const finish = repository.finish.bind(repository)
    vi.spyOn(repository, 'finish').mockImplementation(async (...args) => {
      if (args[1] === 'completed-7') {
        completionHeld.resolve()
        await completionReleased.promise
      }
      return finish(...args)
    })
    const messages = new PostgresOperatorConversationRepository(db.pool)
    let transport: ReturnType<typeof claudeSdkToolTransport> | undefined
    chat = new AgentChatService(db.pool, repository, messages, new PostgresWorkflowRepository(db.pool), {
      getForWorkspace: async () => { throw new Error('Agent rollover must not read or create a Run.') },
      getExecution: async () => { throw new Error('This fixture must not read a Run execution.') }, executionPages() { throw new Error('Agent rollover must not select a Run execution.') },
    }, (id, configuration, cwd) => {
      transport ??= claudeSdkToolTransport(cwd, () => [])
      const start = { kind: 'workflow' as const, correlationId: `agent:${id}:first`, request: {
        executionId: `agent-chat:${id}`, runId: `agent-chat:${id}`, workspaceId: seeded.scope.workspaceId,
        workflowNodeId: node.id, configuration, input: {}, workingDirectory: cwd, runtimeDirectory: join(db.directory, 'agent-chat', id),
      } }
      manager = productionClaudeFixture('agent', undefined, undefined, undefined, {
        database: db.pool, binding: { kind: 'agent', conversationId: id, workspaceId: seeded.scope.workspaceId, repository },
        start, sdk: transport.sdk,
      }).manager
      return manager
    }, db.directory)
    app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: chat, commands: new PostgresCommandCoordinator(db.pool) } as never } })
    const query = { workflowId: seeded.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    let id: string | null = null
    // Eight turns finish serially, including native ACK and SQL persistence.
    // Use the delivery barrier's integration deadline rather than a one-second batch budget.
    // Overlap admission with execution while staying below the unfinished-turn limit.
    for (let offset = 0; offset < 256; offset += 8) {
      const requestIds: string[] = []
      for (let index = offset; index < offset + 8; index++) {
        const requestId = `completed-${index}`
        const admitted = await chat.send(owner.principal, seeded.scope.workspaceId, {
          requestId, content: requestId, intent: 'next_turn', expectedConversationId: id, context: query,
        })
        id = admitted.state.conversation!.id
        requestIds.push(requestId)
      }
      if (offset === 0) {
        await completionHeld.promise
        // The batch remains valid when a completion commit takes more than one second.
        completionTimer = setTimeout(() => completionReleased.resolve(), 1_100)
      }
      await Promise.all(requestIds.map(async requestId => {
        await waitForDelivery(chat!, repository, id!, requestId, 'completed')
        expect((await repository.turn(id!, requestId))?.delivery).toBe('completed')
      }))
    }
    const nativeId = (await repository.get(id!))!.native_session_id
    expect(transport!.offers).toHaveLength(256)
    expect(new Set(transport!.offers).size).toBe(256)
    const idle = await graphRpc(app, owner.token, 'tools/call', { name: 'agent_chat_read',
      arguments: { workspaceId: seeded.scope.workspaceId, query } })
    expect(idle.result?.isError).not.toBe(true)
    const idleState = AgentChatStateSchema.parse(graphRpcValue(idle.result))
    expect(idleState.activeTurn).toBeNull()
    expect(idleState.turns.every(turn => turn.delivery === 'completed')).toBe(true)
    expect(idleState.turns.find(turn => turn.requestId === 'completed-255')?.delivery).toBe('completed')
    transport!.failNextResume()
    const input = { requestId: 'unoffered', content: 'retryable input', intent: 'next_turn', expectedConversationId: id, context: query }
    const denied = await graphRpc(app, reader.token, 'tools/call', { name: 'agent_chat_send',
      arguments: { workspaceId: seeded.scope.workspaceId, request: input } })
    expect(denied.error || denied.result?.isError).toBeTruthy()

    // Capture an idle response snapshot, then close the query before pending is read.
    const claim = repository.claim.bind(repository)
    vi.spyOn(repository, 'claim').mockImplementationOnce(async (...args) => {
      await claimReady.promise
      return claim(...args)
    })
    const sessionInfo = transport!.sdk.getSessionInfo.bind(transport!.sdk)
    vi.spyOn(transport!.sdk, 'getSessionInfo').mockImplementationOnce(async (...args) => {
      resumeEntered.resolve()
      await resumeReady.promise
      return sessionInfo(...args)
    })
    const state = repository.state.bind(repository)
    vi.spyOn(repository, 'state').mockImplementationOnce(async (...args) => {
      const snapshot = await state(...args)
      expect(snapshot?.row.active_request_id).toBeNull()
      claimReady.resolve()
      await resumeEntered.promise
      return snapshot
    })
    const pending = manager!.pending.bind(manager!)
    vi.spyOn(manager!, 'pending').mockImplementationOnce(async (...args) => {
      try {
        return await pending(...args)
      } finally {
        resumeReady.resolve()
      }
    })
    const failed = await graphRpc(app, owner.token, 'tools/call', { name: 'agent_chat_send',
      arguments: { workspaceId: seeded.scope.workspaceId, request: input } })
    expect(failed.result?.isError, JSON.stringify(failed)).not.toBe(true)
    const admitted = SendAgentChatMessageResponseSchema.parse(graphRpcValue(failed.result))
    expect(admitted).toMatchObject({
      replayed: false,
      turn: { requestId: input.requestId, delivery: 'queued' },
      state: { conversation: { id, nativeSession: { nativeSessionId: nativeId } } },
    })
    await waitForDelivery(chat, repository, id!, input.requestId, 'failed')
    expect((await repository.turn(id!, input.requestId))?.delivery).toBe('failed')
    expect((await repository.get(id!))?.active_request_id).toBeNull()
    expect((await repository.turn(id!, input.requestId))?.nativeSubmission).toBeUndefined()
    expect(transport!.offers).toHaveLength(256)
    const settled = await graphRpc(app, owner.token, 'tools/call', { name: 'agent_chat_read',
      arguments: { workspaceId: seeded.scope.workspaceId, query } })
    expect(settled.result?.isError).not.toBe(true)
    const settledState = AgentChatStateSchema.parse(graphRpcValue(settled.result))
    expect(settledState.activeTurn).toBeNull()
    expect(settledState.pendingInteraction).toBeUndefined()
    expect(settledState.turns.find(turn => turn.requestId === input.requestId)).toMatchObject({ delivery: 'failed' })
    expect(settledState.conversation?.nativeSession?.nativeSessionId).toBe(nativeId)
    const retry = await graphRpc(app, owner.token, 'tools/call', { name: 'agent_chat_send',
      arguments: { workspaceId: seeded.scope.workspaceId, request: { ...input, requestId: 'retry-unoffered' } } })
    expect(retry.result?.isError).not.toBe(true)
    await waitForDelivery(chat, repository, id!, 'retry-unoffered', 'completed')
    expect((await repository.turn(id!, 'retry-unoffered'))?.delivery).toBe('completed')
    const read = await graphRpc(app, owner.token, 'tools/call', { name: 'agent_chat_read',
      arguments: { workspaceId: seeded.scope.workspaceId, query } })
    expect(read.result?.isError).not.toBe(true)
    expect(graphRpcValue(read.result)).toMatchObject({ conversation: { id, nativeSession: { nativeSessionId: nativeId } } })
    expect(transport!.queries.at(-1)?.resume).toBe(nativeId)
    expect(transport!.offers).toHaveLength(257)
    expect(new Set(transport!.offers).size).toBe(257)
    const replay = await graphRpc(app, owner.token, 'tools/call', { name: 'agent_chat_send',
      arguments: { workspaceId: seeded.scope.workspaceId, request: input } })
    expect(replay.result?.isError).not.toBe(true)
    expect(SendAgentChatMessageResponseSchema.parse(graphRpcValue(replay.result))).toMatchObject({
      replayed: true, turn: { requestId: input.requestId, delivery: 'failed' },
    })
    expect(transport!.offers).toHaveLength(257)
  } finally {
    clearTimeout(completionTimer)
    completionReleased.resolve()
    claimReady.resolve()
    resumeReady.resolve()
    resumeEntered.resolve()
    try { await chat?.shutdown() }
    finally {
      try { await app?.close() }
      finally {
        vi.restoreAllMocks()
        await db.close()
      }
    }
  }
}, 120_000)
