import { memorySessionControlPool } from './support/sessionControls.js'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, MessageSchema, type Message, type NativeSessionReference } from '@foreman-code/contracts'
import { AgentChatTurnSchema, type AgentChatContext, type AgentChatTurn } from '@foreman-code/contracts/agent-chat'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { RunBoardSnapshotSchema } from '@foreman-code/contracts/run-snapshots'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatCorrelation, agentChatKey, type AgentConversationRow, type PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { runChatStorageKey } from '../src/modules/conversations/selectedRunChat.js'
import type { NativeSteerInput } from '../src/modules/harnesses/port.js'
import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { AgentChatF5Native } from './helpers/agentChatF5.js'
import { deferred } from './helpers/deferred.js'

class SteeringNative extends AgentChatF5Native {
  readonly steerTurn = vi.fn(async (_session: NativeSessionReference, input: NativeSteerInput) => ({ nativeTurnId: input.expectedTurnId }))
}

/** In-memory Run/storage ports, real schemas and service. Two concurrent sends both
 * miss the initial receipt lookup, exercising BOTH return paths inside steer(). */
it('keeps new, in-steer replay and ordinary replay responses on the explicitly selected execution beside a legacy chat', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rh02-steer-'))
  const saved = makeCurrentWorkflowFixture(`rh02-${randomUUID()}`, 'sequential')
  const node = saved.version.definition.nodes[0]!
  const configuration = saved.configurations.find((entry) => entry.agentId === node.agentId)!
  const context: AgentChatContext = { workspaceId: saved.scope.workspaceId, workflowId: saved.scope.workflowId,
    runId: saved.run.id, workflowNodeId: node.id, agentId: node.agentId }
  const target = { workspaceId: context.workspaceId, workflowId: context.workflowId, runId: saved.run.id, workflowNodeId: node.id }
  const principal: ManagementPrincipal = { id: 'rh02-principal', name: 'RH-02', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00.000Z', grants: [{ actions: ['agent_chat:read', 'agent_chat:write'], scope: { workspaceIds: [context.workspaceId] } }] }
  const executions = [1, 2].map((attempt) => HarnessExecutionSchema.parse({ id: `execution-${attempt}`, runId: saved.run.id,
    workflowNodeId: node.id, agentId: node.agentId, agentConfigurationVersionId: configuration.id, attempt, input: {},
    state: 'completed', nativeSessionId: `source-${attempt}`, workingDirectory: directory, result: { outcome: 'succeeded' },
    createdAt: saved.createdAt, finishedAt: saved.createdAt }))
  const rows: AgentConversationRow[] = executions.map((execution, index) => ({ id: `conversation-${index + 1}`,
    agent_key: index === 0 ? agentChatKey(context) : runChatStorageKey(context, execution.id),
    workspace_id: context.workspaceId, workflow_id: context.workflowId, workflow_node_id: node.id, agent_id: node.agentId,
    agent_configuration_version_id: configuration.id, origin_run_id: saved.run.id, origin_execution_id: execution.id,
    harness: configuration.harness.harness, provider_version: 'rh02-fixture', native_session_id: `child-${index + 1}`,
    active_request_id: index === 1 ? 'active-e2' : null, active_native_turn_id: index === 1 ? 'turn-e2' : null,
    cancel_requested: false, turn_state: index === 1 ? 'active' : 'idle', last_error: null, revision: 1,
    pending_interaction: null, last_result: null,
    record: { origin: { kind: 'run_execution', runId: saved.run.id, executionId: execution.id, sourceNativeSessionId: execution.nativeSessionId! },
      workingDirectory: directory, runtimeDirectory: directory, startupDelivered: true },
    created_at: new Date(saved.createdAt), updated_at: new Date(saved.createdAt) }))
  const legacy = rows[0]!, selected = rows[1]!
  const messages = new Map<string, Message[]>(rows.map((row, index) => [row.id, [MessageSchema.parse({ id: `message-${row.id}`,
    conversationId: row.id, role: 'user', requestId: index === 0 ? 'legacy-e1' : 'active-e2', content: `Transcript for ${row.id}`,
    createdAt: saved.createdAt, updatedAt: saved.createdAt })]]))
  const receipts = new Map<string, AgentChatTurn[]>(rows.map((row, index) => [row.id, [AgentChatTurnSchema.parse({
    requestId: index === 0 ? 'legacy-e1' : 'active-e2', sequence: '1', messageId: messages.get(row.id)![0]!.id,
    intent: 'next_turn', delivery: index === 0 ? 'completed' : 'accepted', nativeTurnId: index === 0 ? 'turn-e1' : 'turn-e2',
    createdAt: saved.createdAt, updatedAt: saved.createdAt })]]))
  const snapshot = RunBoardSnapshotSchema.parse({ kind: 'available', workspaceId: context.workspaceId, workflowId: context.workflowId, runId: saved.run.id,
    workflowVersionId: saved.version.id, capturedAt: saved.createdAt,
    nodes: saved.version.definition.nodes.map((entry) => ({ id: entry.id, name: entry.name ?? 'Snapshot node', agentId: entry.agentId,
      agentConfigurationVersionId: saved.version.agentConfigurationVersionIds[entry.agentId], position: entry.position ?? { x: 0, y: 0 },
      size: { width: entry.width ?? 208, height: entry.height ?? 112 } })), edges: saved.version.definition.edges })
  const controls = memorySessionControlPool()
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('conversation_session_') || sql.includes('as compaction')) {
      return controls.query(sql, values)
    }
    if (['begin', 'commit', 'rollback'].includes(sql)) return { rows: [] }
    if (sql.includes('management_principals')) return { rows: [{ ...principal, grants: principal.grants,
      expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] }
    if (sql.includes('run_board_snapshots')) return { rows: [{ workflow_version_id: saved.version.id, snapshot_id: saved.run.id, snapshot }] }
    if (sql.includes('origin_execution_id=$6')) return { rows: rows.filter((row) => row.workspace_id === values[0]
      && row.workflow_id === values[1] && row.origin_run_id === values[2] && row.workflow_node_id === values[3]
      && row.agent_id === values[4] && row.origin_execution_id === values[5]) }
    if (sql.includes('from harness_native_events')) {
      const execution = executions.find(item => item.id === values[0] && item.runId === values[1]
        && item.workflowNodeId === values[2] && item.agentId === values[3])
      return { rows: execution ? [{ item_key: 'source-reply', role: 'assistant',
        content: `Source transcript for ${execution.id}`, original_bytes: 0, complete: true,
        sequence: '1', revision: '1' }] : [] }
    }
    if (sql.includes('operator_conversation_activit')) return { rows: [] }
    throw new Error(`Unexpected SQL in RH-02 fixture: ${sql}`)
  })
  const client = { query, release: vi.fn() } as unknown as pg.PoolClient
  const pool = { query, connect: async () => client } as unknown as pg.Pool
  const misses = deferred()
  let missingLookups = 0
  const steerRequestId = 'steer-e2'
  const repository = {
    get: vi.fn(async (id: string) => rows.find((row) => row.id === id)),
    byKey: vi.fn(async (key: string) => rows.find((row) => row.agent_key === key)),
    state: vi.fn(async (id: string) => ({ row: rows.find((row) => row.id === id), turns: receipts.get(id),
      messages: messages.get(id), hasEarlierMessages: false,
      selection: { workflowVersionId: saved.version.id, attemptKey: String(executions.find(execution => execution.id === rows.find(row => row.id === id)?.origin_execution_id)!.attempt) },
      latestRequestId: receipts.get(id)?.at(-1)?.requestId ?? null, activeStartedAt: id === selected.id ? new Date(saved.createdAt) : null,
      unfinishedActivities: [], publicationReceipts: [], activityPage: { activities: [], itemRevisions: {}, nextCursor: null } })),
    open: vi.fn(async () => [selected]), restoreUnsettled: vi.fn(async () => selected),
    turnPrincipalId: vi.fn(async (id: string, requestId: string) =>
      receipts.get(id)?.some(turn => turn.requestId === requestId) ? principal.id : undefined),
    abandon: vi.fn(async (id: string, requestId: string, message: string) => {
      const row = rows.find(entry => entry.id === id && entry.active_request_id === requestId)
      if (row) {
        row.turn_state = 'uncertain'
        row.last_error = message
      }
    }),
    unconfirmedSteers: vi.fn(async () => []), accepted: vi.fn(async () => true), pending: vi.fn(async () => {}),
    turn: vi.fn(async (id: string, requestId: string) => {
      const prior = receipts.get(id)?.find((turn) => turn.requestId === requestId)
      if (id === selected.id && requestId === steerRequestId && !prior) {
        if (++missingLookups === 2) misses.resolve()
        await misses.promise
      }
      return prior
    }),
    admit: vi.fn(async (input: Parameters<PostgresAgentChatRepository['admit']>[0]) => {
      await input.assertCurrent?.(client)
      const row = rows.find((entry) => entry.agent_key === input.key)!
      const prior = receipts.get(row.id)!.find((turn) => turn.requestId === input.request.requestId)
      if (prior) return { conversationId: row.id, turn: prior, replayed: true, created: false }
      const message = MessageSchema.parse({ id: 'steer-message-e2', conversationId: row.id, role: 'user',
        requestId: input.request.requestId, content: input.request.content, createdAt: saved.createdAt, updatedAt: saved.createdAt })
      const turn = AgentChatTurnSchema.parse({ requestId: input.request.requestId, sequence: '2', intent: 'steer', delivery: 'submitting',
        messageId: message.id, targetNativeTurnId: input.targetNativeTurnId, createdAt: saved.createdAt, updatedAt: saved.createdAt })
      messages.get(row.id)!.push(message); receipts.get(row.id)!.push(turn)
      return { conversationId: row.id, turn, replayed: false, created: false }
    }),
    steerAccepted: vi.fn(async (id: string, requestId: string, nativeTurnId: string) => {
      const turn = receipts.get(id)!.find((entry) => entry.requestId === requestId)!
      turn.delivery = 'accepted'; turn.nativeTurnId = nativeTurnId
    }),
  }
  const native = new SteeringNative()
  const attach = vi.spyOn(native, 'attachSession')
  vi.spyOn(native, 'reconcile').mockResolvedValue({ correlationId: agentChatCorrelation(selected.id, 'active-e2'),
    nativeTurnId: 'turn-e2', events: [], pendingInteractions: [] })
  const managers = vi.fn(() => native)
  const runPort = { getForWorkspace: async () => ({ ...saved.run, executionState: 'completed', outcome: 'succeeded' }),
    getExecution: async (id: string) => executions.find(item => item.id === id),
    async *executionPages() { yield executions } }
  const chat = new AgentChatService(pool, repository as unknown as PostgresAgentChatRepository, new PostgresOperatorConversationRepository(pool),
    { getSavedVersion: async () => saved.version, getAgentConfiguration: async () => configuration,
      getCurrentSavedVersion: async () => { throw new Error('Do not read the current workflow for historical steering') } },
    runPort as unknown as Pick<PostgresRunRepository, 'getForWorkspace' | 'executionPages' | 'getExecution'>, managers, directory)
  try {
    // Use public recovery to attach E2's existing active session; no private runtime injection.
    await chat.recover()
    expect(repository.turnPrincipalId).toHaveBeenCalledWith(selected.id, 'active-e2')
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ nativeSessionId: selected.native_session_id }), expect.anything(), expect.anything())
    const beforeLegacy = structuredClone({ row: legacy, messages: messages.get(legacy.id), receipts: receipts.get(legacy.id) })
    const request = { selection: { ...target, executionId: executions[1]!.id }, message: { requestId: steerRequestId,
      content: 'Steer E2 only.', intent: 'steer', expectedConversationId: selected.id, expectedNativeTurnId: 'turn-e2' } }
    const responses = [...await Promise.all([chat.sendSelectedRun(principal, request), chat.sendSelectedRun(principal, request)])]
    expect(responses.map((response) => response.replayed).sort()).toEqual([false, true])
    // Both initial lookups missed, so the replay must be the submitting-admission return INSIDE steer.
    expect(missingLookups).toBe(2)
    expect(repository.admit.mock.calls.map(([input]) => input.delivery)).toEqual(['submitting', 'submitting'])
    responses.push(await chat.sendSelectedRun(principal, request))
    expect(responses[2]!.replayed).toBe(true)
    for (const response of responses) {
      expect(response.state.sourceTranscript).toMatchObject({ executionId: executions[1]!.id,
        messages: [{ role: 'assistant', content: `Source transcript for ${executions[1]!.id}` }] })
      expect(response.state.context).toEqual(context)
      expect(response.state.conversation?.id).toBe(selected.id)
      expect(response.state.conversation?.origin).toEqual(selected.record.origin)
      expect(response.state.conversation?.nativeSession).toEqual({ nativeSessionId: selected.native_session_id, providerVersion: selected.provider_version })
      expect(response.state.activeTurn).toMatchObject({ requestId: 'active-e2', nativeTurnId: 'turn-e2' })
      expect(response.state.sessionState).toBe('active')
      expect(response.state.messages.map((message) => message.conversationId)).toEqual([selected.id, selected.id])
      expect(response.state.messages.map((message) => message.content)).toEqual([`Transcript for ${selected.id}`, 'Steer E2 only.'])
      expect(response.state.turns.map((turn) => turn.requestId)).toEqual(['active-e2', steerRequestId])
      expect(response.state.turns).toContainEqual(response.turn)
      expect(response.state.messages.find((message) => message.id === response.turn.messageId)?.requestId).toBe(steerRequestId)
    }
    expect(native.steerTurn).toHaveBeenCalledTimes(1)
    expect(native.steerTurn.mock.calls[0]).toEqual([
      expect.objectContaining({ nativeSessionId: selected.native_session_id }),
      { prompt: 'Steer E2 only.', clientCorrelationId: agentChatCorrelation(selected.id, steerRequestId), expectedTurnId: 'turn-e2' },
      expect.anything(),
    ])
    expect(managers).toHaveBeenCalledTimes(1)
    expect({ row: legacy, messages: messages.get(legacy.id), receipts: receipts.get(legacy.id) }).toEqual(beforeLegacy)
  } finally { misses.resolve(); await chat.shutdown(); await rm(directory, { recursive: true, force: true }) }
})
