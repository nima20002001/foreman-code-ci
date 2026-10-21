import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, MessageSchema, type HarnessExecution } from '@foreman-code/contracts'
import { AgentChatTurnSchema, type AgentChatContext, type AgentChatExecutionActivityPage, type AgentChatTurn } from '@foreman-code/contracts/agent-chat'
import { JobWorkflowNodeSchema } from '@foreman-code/contracts/job-workflow'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { RunBoardSnapshotSchema } from '@foreman-code/contracts/run-snapshots'
import { makeCurrentWorkflowFixture, type SavedWorkflowVersion } from '@foreman-code/contracts/wave25'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatKey, type AgentConversationRow, type PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { assertRunChatConversation, runChatStorageKey, selectRunChatExecution } from '../src/modules/conversations/selectedRunChat.js'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import type { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { executionProjectionRows } from './agent-chat-execution-activity.testSupport.js'

const cleanup: AgentChatService[] = []
afterEach(async () => { await Promise.all(cleanup.splice(0).map((chat) => chat.shutdown())) })

/** In-memory storage/Run ports only. Real schemas, selection code and AgentChatService are exercised. */
function fixture() {
  const saved = makeCurrentWorkflowFixture(`sch06-${randomUUID()}`, 'sequential')
  const version: SavedWorkflowVersion = saved.version
  const node = saved.version.definition.nodes[0]!
  const configuration = saved.configurations.find((item) => item.agentId === node.agentId)!
  const context: AgentChatContext = { workspaceId: saved.scope.workspaceId, workflowId: saved.scope.workflowId,
    runId: saved.run.id, workflowNodeId: node.id, agentId: node.agentId }
  const target = { workspaceId: context.workspaceId, workflowId: context.workflowId, runId: saved.run.id, workflowNodeId: node.id }
  const principal: ManagementPrincipal = { id: 'sch06-principal', name: 'SCH-06', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00.000Z', grants: [{ actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel'],
      scope: { workspaceIds: [context.workspaceId], workflowIds: [context.workflowId] } }] }
  const live = { id: principal.id, name: principal.name, audience: 'operator', grants: principal.grants,
    expires_at: new Date(principal.expiresAt), revoked_at: null as Date | null, delegated_from: null }
  const runs = new Map([[saved.run.id, { ...saved.run, executionState: 'completed', outcome: 'succeeded' }]])
  const configurations = new Map([[configuration.id, configuration]])
  const executions = new Map<string, HarnessExecution[]>()
  const snapshots = new Map<string, unknown>()
  const conversations = new Map<string, AgentConversationRow>()
  const source = HarnessExecutionSchema.parse({ id: 'sch06-execution-a', runId: saved.run.id, workflowNodeId: node.id,
    agentId: node.agentId, agentConfigurationVersionId: configuration.id, attempt: 1, input: {}, state: 'completed',
    nativeSessionId: 'sch06-run-source-a', workingDirectory: '/sch06-fixture', result: { outcome: 'succeeded' },
    createdAt: saved.createdAt, finishedAt: saved.createdAt })
  executions.set(saved.run.id, [source])
  function capture(runId: string) {
    snapshots.set(runId, RunBoardSnapshotSchema.parse({ kind: 'available', workspaceId: target.workspaceId,
      workflowId: target.workflowId, runId, workflowVersionId: version.id, capturedAt: saved.createdAt,
      nodes: version.definition.nodes.map((entry) => ({ id: entry.id, name: entry.name ?? 'Snapshot node',
        ...(entry.kind === 'job' ? { kind: entry.kind, jobDefinitionId: entry.jobDefinitionId,
          jobDefinitionRevision: entry.jobDefinitionRevision, jobDefinitionVersionId: entry.jobDefinitionVersionId }
          : { kind: entry.kind, agentId: entry.agentId, agentConfigurationVersionId: version.agentConfigurationVersionIds[entry.agentId] }),
        position: entry.position ?? { x: 0, y: 0 }, size: { width: entry.width ?? 208, height: entry.height ?? 112 } })),
      edges: version.definition.edges }))
  }
  capture(saved.run.id)
  function row(execution = source, id = 'sch06-conversation-a', legacy = false) {
    const rowContext = { ...context, runId: execution.runId }
    const value: AgentConversationRow = { id,
      agent_key: legacy ? agentChatKey(rowContext) : runChatStorageKey(rowContext, execution.id),
      workspace_id: context.workspaceId, workflow_id: context.workflowId, workflow_node_id: node.id, agent_id: node.agentId,
      agent_configuration_version_id: configuration.id, origin_run_id: execution.runId, origin_execution_id: execution.id,
      harness: configuration.harness.harness, native_session_id: `child-${id}`, provider_version: 'sch06-fixture',
      active_request_id: null, active_native_turn_id: null, cancel_requested: false, turn_state: 'idle', last_error: null,
      revision: 1, pending_interaction: null, last_result: null,
      record: { origin: { kind: 'run_execution', runId: execution.runId, executionId: execution.id,
        sourceNativeSessionId: execution.nativeSessionId ?? 'lost-source' }, workingDirectory: '/sch06-fixture', runtimeDirectory: '/sch06-fixture' },
      created_at: new Date(saved.createdAt), updated_at: new Date(saved.createdAt) }
    conversations.set(id, value)
    return value
  }
  const stored = row()
  const nativeEvents: { sequence: number; item_key: string; record: Record<string, unknown> }[] = []
  const transcriptRows = [{ item_key: 'source-message', role: 'assistant', content: 'Saved execution output',
    original_bytes: 22, complete: true, sequence: '1', revision: '1' }]
  const message = (id: string) => MessageSchema.parse({ id: `message-${id}`, conversationId: id, role: 'assistant',
    content: `Transcript for ${id}`, createdAt: saved.createdAt, updatedAt: saved.createdAt })
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (['begin', 'commit', 'rollback'].includes(sql)) return { rows: [], rowCount: 0 }
    if (sql.includes('management_principals')) return { rows: [live], rowCount: 1 }
    if (sql.includes('from harness_executions e join runs r')) {
      return { rows: (executions.get(String(values[0])) ?? []).filter((item) => item.workflowNodeId === values[1] && item.agentId === values[2])
        .map((item) => ({ id: item.id, attempt: item.attempt, tick_index: null, occurrence_index: null, state: item.state,
          native_session_id: item.nativeSessionId ?? null, created_at: new Date(item.createdAt), started_at: null, finished_at: null,
          revision: String(nativeEvents.at(-1)?.sequence ?? 0), record_revision: '0' })) }
    }
    if (sql.startsWith('with identities as')) return { rows: executionProjectionRows(nativeEvents, values) }
    if (sql.includes('from harness_native_events')) return { rows: transcriptRows, rowCount: transcriptRows.length }
    if (sql.includes('from conversation_session_defaults')) return { rows: [], rowCount: 0 }
    if (sql.includes('run_board_snapshots')) {
      const run = runs.get(String(values[2]))
      return { rows: run && run.workspaceId === values[0] && run.workflowId === values[1]
        ? [{ workflow_version_id: saved.version.id, snapshot_id: snapshots.has(run.id) ? run.id : null, snapshot: snapshots.get(run.id) }] : [], rowCount: run ? 1 : 0 }
    }
    if (sql.includes('from operator_conversations') && sql.includes('origin_execution_id=$6')) {
      return { rows: [...conversations.values()].filter((item) => item.workspace_id === values[0] && item.workflow_id === values[1]
        && item.origin_run_id === values[2] && item.workflow_node_id === values[3] && item.agent_id === values[4]
        && item.origin_execution_id === values[5]).slice(0, 2), rowCount: 1 }
    }
    if (sql.includes('operator_conversation_activit')) return { rows: [], rowCount: 0 }
    throw new Error(`Unexpected SQL in read-only fixture: ${sql}`)
  })
  const pool = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool
  const repository = {
    get: vi.fn(async (id: string) => conversations.get(id)),
    byKey: vi.fn(async (key: string) => [...conversations.values()].find((item) => item.agent_key === key)),
    state: vi.fn(async (id: string): ReturnType<PostgresAgentChatRepository['state']> => {
      const row = conversations.get(id)
      if (!row) return undefined
      const run = row.origin_run_id ? runs.get(row.origin_run_id) : undefined
      const execution = run ? executions.get(run.id)?.find((item) => item.id === row.origin_execution_id) : undefined
      return { row, turns: [], messages: [message(id)], hasEarlierMessages: false,
        selection: run && execution ? { workflowVersionId: run.workflowVersionId, attemptKey: String(execution.attempt) } : null,
        latestRequestId: null, activeStartedAt: null, unfinishedActivities: [],
        activityPage: { activities: [], nextCursor: null, itemRevisions: {} } }
    }),
    history: vi.fn(async (id: string) => ({ messages: [message(id)], nextCursor: null })),
    receipts: vi.fn(async () => ({ turns: [], nextCursor: null })),
    turn: vi.fn(async (): Promise<AgentChatTurn | undefined> => undefined), admit: vi.fn(),
  }
  const workflows = { getSavedVersion: vi.fn(async () => version),
    getCurrentSavedVersion: vi.fn(async (): Promise<SavedWorkflowVersion> => { throw new Error('Historical chat must not inspect the current workflow') }),
    getAgentConfiguration: vi.fn(async (id: string) => configurations.get(id)) }
  const runPort = { getForWorkspace: async (workspaceId: string, id: string) => {
    const run = runs.get(id); return run?.workspaceId === workspaceId ? run : undefined
  }, getExecution: vi.fn(async (id: string) => [...executions.values()].flat().find(item => item.id === id)),
    async *executionPages(runId: string) { for (const execution of executions.get(runId) ?? []) yield [execution] } }
  const managers = vi.fn(() => { throw new Error('A read or rejected command must not launch native work') })
  const chat = new AgentChatService(pool, repository as unknown as PostgresAgentChatRepository,
    new PostgresOperatorConversationRepository(pool), workflows, runPort as unknown as Pick<PostgresRunRepository, 'getForWorkspace' | 'executionPages' | 'getExecution'>,
    managers as () => NativeHarnessSessionManager, '/sch06-fixture')
  cleanup.push(chat)
  return { saved, version, context, target, principal, live, runs, source, configurations, executions, snapshots, conversations,
    stored, capture, row, query, repository, workflows, managers, chat, runPort, pool, transcriptRows, nativeEvents }
}

async function selected(f: ReturnType<typeof fixture>, runId = f.target.runId, executionId = f.source.id) {
  const value = await f.chat.readSelectedRun(f.principal, { selection: { ...f.target, runId, executionId }, history: {}, receipts: {} })
  if (value.kind !== 'selected') throw new Error(`Expected selected, got ${value.kind}`)
  return value
}

function addJob(f: ReturnType<typeof fixture>) {
  const job = JobWorkflowNodeSchema.parse({ kind: 'job', id: 'sch06-job-node', name: 'Build',
    jobDefinitionId: 'sch06-job', jobDefinitionRevision: 2, jobDefinitionVersionId: 'sch06-job-version' })
  f.version.definition.nodes.unshift(job)
  f.capture(f.target.runId)
  return job
}

describe('historical Agent chat identity and fail-closed selection', () => {
  it('reads a retained conversation without a host availability provider', async () => {
    const f = fixture()
    const value = await selected(f)
    expect(value.state.conversation).toMatchObject({ id: f.stored.id,
      agentConfigurationVersionId: f.source.agentConfigurationVersionId,
      nativeSession: { nativeSessionId: f.stored.native_session_id } })
    expect(value.state.sourceTranscript?.messages).toEqual([
      expect.objectContaining({ role: 'assistant', content: 'Saved execution output' }),
    ])
    expect(f.managers).not.toHaveBeenCalled()
  })
  it.each(['starting', 'running', 'completed'] as const)('reads the %s execution transcript without a chat or native probe', async state => {
    const f = fixture()
    f.conversations.clear()
    f.source.state = state
    f.runs.get(f.target.runId)!.executionState = 'running'
    const { workspaceId, ...query } = f.context
    const result = await f.chat.read(f.principal, workspaceId, query)
    expect(result.sourceTranscript).toMatchObject({ executionId: f.source.id, state,
      messages: [{ content: 'Saved execution output' }] })
    expect(result.conversation).toBeNull()
    expect(result.availability.canSend).toBe(state === 'completed')
    const controls = await f.chat.readContextControls(f.principal, f.context)
    expect(controls.conversationId).toBeNull()
    expect(controls.busyReason !== null).toBe(state !== 'completed')
    expect(f.managers).not.toHaveBeenCalled()
    expect(f.repository.admit).not.toHaveBeenCalled()
  })

  it('returns persisted execution text and pending controls through authenticated MCP and denies a wrong scope', async () => {
    const f = fixture()
    f.conversations.clear()
    f.source.state = 'running'
    const access = new PostgresAccessService(f.pool)
    const denied = { ...f.principal, id: 'wrong-scope',
      grants: [{ actions: ['agent_chat:read' as const], scope: { workspaceIds: ['other-workspace'] } }] }
    vi.spyOn(access, 'authenticate').mockImplementation(async token => token === 'reader' ? f.principal : denied)
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: f.chat, commands: { recordDenied: vi.fn() } } as unknown as OperatorServices },
    })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const clients: Client[] = []
    const connect = async (token: string) => {
      const client = new Client({ name: 'execution-chat-reader', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    try {
      const reader = await connect('reader')
      const other = await connect('denied')
      const { workspaceId, ...query } = f.context
      const call = { name: 'agent_chat_read', arguments: { workspaceId, query } }
      expect(decodeMcpToolResult(await reader.callTool(call))).toMatchObject({ sourceTranscript: {
        executionId: f.source.id, messages: [{ content: 'Saved execution output' }],
      } })
      expect(decodeMcpToolResult(await reader.callTool({ name: 'agent_chat_controls_get',
        arguments: { workspaceId, context: query, executionId: f.source.id } }))).toMatchObject({
        conversationId: null, busyReason: expect.any(String),
      })
      f.transcriptRows[0]!.content = 'Persisted update'
      expect(decodeMcpToolResult(await reader.callTool(call))).toMatchObject({ sourceTranscript: {
        messages: [{ content: 'Persisted update' }],
      } })
      expect((await other.callTool(call)).isError).toBe(true)
      expect(f.managers).not.toHaveBeenCalled()
    } finally {
      await Promise.all(clients.map(client => client.close()))
      await app.close()
    }
  })

  it('returns live execution tool activity through authenticated MCP by cursor and denies a wrong scope', async () => {
    const f = fixture()
    f.conversations.clear()
    f.source.state = 'running'
    const command = (status: string, output: string | null) => ({ id: 'cmd-1', type: 'commandExecution', status,
      command: "/bin/bash -lc 'git status'", commandActions: [{ type: 'unknown', command: 'git status' }], aggregatedOutput: output })
    const push = (type: string, item: Record<string, unknown>) => f.nativeEvents.push({ sequence: f.nativeEvents.length + 1,
      item_key: String(item.id), record: { type, occurredAt: f.saved.createdAt, payload: { threadId: f.source.nativeSessionId, turnId: 'turn', item } } })
    push('item.completed', { id: 'msg-1', type: 'agentMessage', text: 'Checking the tree' })
    push('item.started', command('inProgress', null))
    const access = new PostgresAccessService(f.pool)
    const denied = { ...f.principal, id: 'wrong-scope',
      grants: [{ actions: ['agent_chat:read' as const], scope: { workspaceIds: ['other-workspace'] } }] }
    vi.spyOn(access, 'authenticate').mockImplementation(async token => token === 'reader' ? f.principal : denied)
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: f.chat, commands: { recordDenied: vi.fn() } } as unknown as OperatorServices },
    })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const clients: Client[] = []
    const connect = async (token: string) => {
      const client = new Client({ name: 'execution-activity-reader', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    try {
      const reader = await connect('reader')
      const { workspaceId, ...query } = f.context
      const read = async (executionActivity: Record<string, unknown>) => (decodeMcpToolResult(await reader.callTool({ name: 'agent_chat_read',
        arguments: { workspaceId, query, executionActivity } })) as { executionActivity: AgentChatExecutionActivityPage }).executionActivity
      const first = await read({})
      expect(first.executions).toEqual([expect.objectContaining({ executionId: f.source.id, label: 'Execution', state: 'running' })])
      expect(first.items.map((item) => item.entry.kind === 'message' ? item.entry.message.content
        : `${item.entry.activity.title} · ${item.entry.activity.status}`)).toEqual(['Checking the tree', 'git status · running'])
      push('item.completed', command('completed', 'nothing to commit\n'))
      const changed = await read({ cursor: first.cursor })
      expect(changed).toMatchObject({ mode: 'changes', items: [{ id: 'cmd-1',
        entry: { kind: 'activity', activity: { status: 'completed', output: 'nothing to commit\n' } } }] })
      const other = await connect('denied')
      expect((await other.callTool({ name: 'agent_chat_read', arguments: { workspaceId, query, executionActivity: {} } })).isError).toBe(true)
      expect(f.managers).not.toHaveBeenCalled()
    } finally {
      await Promise.all(clients.map(client => client.close()))
      await app.close()
    }
  })

  it.each([undefined, 'agent'] as const)('keeps exact Agent provenance in a mixed snapshot with kind %s', async (kind) => {
    const f = fixture()
    if (kind) f.version.definition.nodes[0]!.kind = kind
    else delete f.version.definition.nodes[0]!.kind
    addJob(f)
    const before = structuredClone(f.source)
    const value = await selected(f)
    expect(value.key).toEqual({ ...f.target, executionId: f.source.id, agentId: f.context.agentId, conversationId: f.stored.id })
    expect(value.state.conversation?.agentConfigurationVersionId).toBe(f.source.agentConfigurationVersionId)
    expect(f.workflows.getSavedVersion).toHaveBeenCalledWith(f.version.id)
    f.stored.native_session_id = f.source.nativeSessionId!
    await expect(f.chat.sendSelectedRun(f.principal, { selection: value.selection,
      message: { requestId: 'source-send', expectedConversationId: f.stored.id, content: 'Do not mutate source' } }))
      .rejects.toMatchObject({ code: 'AGENT_CHAT_UNAVAILABLE' })
    await expect(f.chat.interruptSelectedRun(f.principal, { key: value.key, request: { requestId: 'source-interrupt' } }))
      .rejects.toMatchObject({ code: 'AGENT_CHAT_UNAVAILABLE' })
    expect(f.source).toEqual(before)
    expect(f.repository.admit).not.toHaveBeenCalled(); expect(f.managers).not.toHaveBeenCalled()
    expect(f.workflows.getCurrentSavedVersion).not.toHaveBeenCalled()
  })

  it('reports a selected Job explicitly unavailable without selecting a neighboring Agent or reserving a command', async () => {
    const f = fixture(), job = addJob(f)
    const target = { ...f.target, workflowNodeId: job.id }
    expect(await f.chat.readSelectedRun(f.principal, { selection: { ...target, executionId: f.source.id } }))
      .toEqual({ kind: 'unavailable', target, reason: 'job_node' })
    await expect(f.chat.sendSelectedRun(f.principal, { selection: { ...target, executionId: f.source.id },
      message: { requestId: 'job-send', expectedConversationId: null, content: 'Do not run an Agent' } }))
      .rejects.toMatchObject({ code: 'AGENT_CHAT_UNAVAILABLE' })
    await expect(f.chat.interruptSelectedRun(f.principal, { key: { ...target, executionId: f.source.id,
      agentId: f.context.agentId, conversationId: f.stored.id }, request: { requestId: 'job-interrupt' } }))
      .rejects.toMatchObject({ code: 'AGENT_CHAT_CONTEXT_STALE' })
    expect(f.workflows.getSavedVersion).not.toHaveBeenCalled()
    expect(f.repository.state).not.toHaveBeenCalled(); expect(f.repository.turn).not.toHaveBeenCalled()
    expect(f.repository.admit).not.toHaveBeenCalled(); expect(f.managers).not.toHaveBeenCalled()
  })

  it.each([false, true])('blocks Job targets in the saved-definition chat flow (Run: %s)', async (historical) => {
    const f = fixture(), job = addJob(f)
    f.version.definition.nodes = f.version.definition.nodes.map((node) => node.id === f.context.workflowNodeId
      ? { ...job, id: node.id } : node)
    f.workflows.getCurrentSavedVersion.mockResolvedValue(f.version)
    // A retained Agent row/receipt must not turn a now-Job target into a chat replay.
    f.repository.byKey.mockResolvedValue(f.stored)
    f.repository.turn.mockResolvedValue(AgentChatTurnSchema.parse({ requestId: 'job-definition-send', sequence: '1',
      intent: 'next_turn', delivery: 'completed', messageId: 'old-message', createdAt: f.saved.createdAt, updatedAt: f.saved.createdAt }))
    const { workspaceId, runId, ...agentContext } = f.context
    const context = { ...agentContext, ...(historical ? { runId } : {}) }
    const state = await f.chat.read(f.principal, workspaceId, context)
    expect(state.conversation).toBeNull()
    expect(state.availability).toMatchObject({ canSend: false, reason: 'agent_missing', message: 'Jobs do not support Agent chat.' })
    await expect(f.chat.send(f.principal, workspaceId, { context, requestId: 'job-definition-send',
      expectedConversationId: null, content: 'Do not create chat', intent: 'next_turn', attachments: [] }))
      .rejects.toMatchObject({ code: 'AGENT_CHAT_UNAVAILABLE' })
    expect(f.workflows.getAgentConfiguration).not.toHaveBeenCalled()
    expect(f.repository.turn).not.toHaveBeenCalled()
    expect(f.repository.admit).not.toHaveBeenCalled(); expect(f.managers).not.toHaveBeenCalled()
  })

  it('denies a wrong-scope authenticated principal before exposing mixed snapshot target kinds', async () => {
    const f = fixture(), job = addJob(f)
    f.live.grants = [{ actions: ['agent_chat:read'], scope: { workflowIds: ['other-workflow'] } }]
    for (const workflowNodeId of [f.context.workflowNodeId, job.id]) {
      await expect(f.chat.readSelectedRun(f.principal, { selection: { ...f.target, workflowNodeId } }))
        .rejects.toMatchObject({ status: 403 })
    }
    expect(f.query.mock.calls.some(([sql]) => sql.includes('run_board_snapshots'))).toBe(false)
    expect(f.repository.state).not.toHaveBeenCalled(); expect(f.managers).not.toHaveBeenCalled()
  })

  it('reads a removed Agent from immutable facts with the exact conversation, native session, transcript and key', async () => {
    const f = fixture()
    const value = await selected(f)
    expect(value.key).toEqual({ ...f.target, executionId: f.source.id, agentId: f.context.agentId, conversationId: f.stored.id })
    expect(value.state.conversation?.nativeSession?.nativeSessionId).toBe(f.stored.native_session_id)
    expect(value.history?.messages[0]?.content).toContain(f.stored.id)
    expect(f.workflows.getCurrentSavedVersion).not.toHaveBeenCalled()
    expect(f.managers).not.toHaveBeenCalled()
    expect(f.repository.admit).not.toHaveBeenCalled()
  })

  it('keeps two Runs with the same Agent separate; conversation readback never follows a newer execution', async () => {
    const f = fixture(), runId = 'sch06-run-b'
    f.runs.set(runId, { ...f.runs.get(f.target.runId)!, id: runId }); f.capture(runId)
    const other = { ...f.source, id: 'sch06-execution-b', runId, nativeSessionId: 'sch06-source-b' }
    f.executions.set(runId, [other]); const b = f.row(other, 'sch06-conversation-b')
    expect((await selected(f)).key?.conversationId).toBe(f.stored.id)
    expect((await selected(f, runId, other.id)).key?.conversationId).toBe(b.id)
    expect((await f.chat.readConversation(f.principal, f.target.workspaceId, f.stored.id)).conversation?.id).toBe(f.stored.id)
    await expect(f.chat.readSelectedRun(f.principal, { selection: { ...f.target, executionId: other.id } }))
      .rejects.toMatchObject({ code: 'RUN_CHAT_EXECUTION_NOT_FOUND' })
    expect(f.managers).not.toHaveBeenCalled()
  })

  it('rejects an execution from another node without scanning or selecting the available execution', async () => {
    const f = fixture()
    const other = { ...f.source, id: 'other-node-execution', workflowNodeId: 'another-node' }
    f.executions.set(f.target.runId, [f.source, other])
    const pages = vi.spyOn(f.runPort, 'executionPages')

    await expect(selected(f, f.target.runId, other.id))
      .rejects.toMatchObject({ code: 'RUN_CHAT_EXECUTION_NOT_FOUND', status: 404 })

    expect(pages).not.toHaveBeenCalled()
    expect(f.repository.state).not.toHaveBeenCalled()
    expect(f.repository.admit).not.toHaveBeenCalled()
    expect(f.managers).not.toHaveBeenCalled()
  })

  it.each(['agentId', 'agentConfigurationVersionId'] as const)(
    'rejects mismatched %s on an execution in the selected Run and node', async field => {
      const f = fixture()
      f.executions.set(f.target.runId, [{ ...f.source, [field]: 'mismatched' }])

      await expect(selected(f)).rejects.toMatchObject({ code: 'AGENT_CHAT_CONTEXT_STALE', status: 409 })

      expect(f.repository.state).not.toHaveBeenCalled()
      expect(f.repository.admit).not.toHaveBeenCalled()
      expect(f.managers).not.toHaveBeenCalled()
    },
  )

  it('requires an explicit execution for multiple attempts and never falls back from a missing source to a session-bearing attempt', async () => {
    const f = fixture()
    const later = { ...f.source, id: 'sch06-second-attempt', attempt: 2, nativeSessionId: 'newer-source' }
    f.executions.set(f.target.runId, [f.source, later]); f.row(later, 'second-conversation')
    const choice = await f.chat.readSelectedRun(f.principal, { selection: f.target })
    expect(choice).toMatchObject({ kind: 'execution_selection_required', hasMoreExecutions: false,
      executions: [{ executionId: f.source.id }, { executionId: later.id }] })
    expect((await selected(f)).key?.conversationId).toBe(f.stored.id)
    expect((await selected(f, f.target.runId, later.id)).key?.conversationId).toBe('second-conversation')
    f.conversations.delete(f.stored.id)
    const missing = { ...f.source }; delete missing.nativeSessionId
    f.executions.set(f.target.runId, [missing, later])
    const unavailable = await selected(f)
    expect(unavailable.key).toBeNull()
    expect(unavailable.state.availability).toMatchObject({ canSend: false, reason: 'native_session_missing' })
    expect(unavailable.state.capabilities.resume).toBe(false)
    expect(f.managers).not.toHaveBeenCalled()
  })

  it('rejects another conversation even when a requestId already has a receipt, before admission/receipt lookup', async () => {
    const f = fixture(), otherRun = 'wrong-receipt-run'
    const other = { ...f.source, id: 'wrong-receipt-execution', runId: otherRun }
    const b = f.row(other, 'wrong-receipt-conversation')
    f.repository.turn.mockResolvedValue(AgentChatTurnSchema.parse({ requestId: 'replayed-command', sequence: '1',
      intent: 'next_turn', delivery: 'completed', messageId: 'old-message', createdAt: f.saved.createdAt, updatedAt: f.saved.createdAt }))
    await expect(f.chat.sendSelectedRun(f.principal, { selection: { ...f.target, executionId: f.source.id },
      message: { requestId: 'replayed-command', expectedConversationId: b.id, content: 'same text', intent: 'next_turn' } }))
      .rejects.toMatchObject({ code: 'AGENT_CHAT_CONTEXT_STALE' })
    const { workspaceId, ...context } = f.context
    await expect(f.chat.send(f.principal, workspaceId, { context, requestId: 'replayed-command', expectedConversationId: b.id,
      content: 'same text', intent: 'steer', expectedNativeTurnId: 'wrong-turn' }))
      .rejects.toMatchObject({ code: 'AGENT_CHAT_CONTEXT_STALE' })
    expect(f.repository.turn).not.toHaveBeenCalled()
    expect(f.repository.admit).not.toHaveBeenCalled()
    expect(f.managers).not.toHaveBeenCalled()
  })

  it('rejects mixed origin columns, a mixed interrupt key, duplicated origins and forged snapshot ids', async () => {
    const f = fixture()
    expect(() => assertRunChatConversation({ ...f.stored, origin_execution_id: 'mixed' }, f.context, f.source.id)).toThrow()
    await expect(f.chat.interruptSelectedRun(f.principal, {
      key: { ...f.target, executionId: f.source.id, agentId: 'another-agent', conversationId: f.stored.id }, request: { requestId: 'stop-mixed' },
    })).rejects.toMatchObject({ code: 'AGENT_CHAT_CONTEXT_STALE' })
    f.row(f.source, 'duplicate')
    await expect(selected(f)).rejects.toMatchObject({ code: 'AGENT_CHAT_CONTEXT_STALE' })
    f.conversations.delete('duplicate')
    f.snapshots.set(f.target.runId, { ...f.snapshots.get(f.target.runId) as object, runId: 'wrong-run' })
    await expect(selected(f)).rejects.toMatchObject({ code: 'AGENT_CHAT_CONTEXT_STALE' })
    expect(f.repository.admit).not.toHaveBeenCalled(); expect(f.managers).not.toHaveBeenCalled()
  })

  it('denies live revocation and wrong-scope callers before transcript/native access, even with a cached principal', async () => {
    const f = fixture()
    f.live.revoked_at = new Date()
    await expect(selected(f)).rejects.toMatchObject({ code: 'AUTH_REVOKED', status: 403 })
    await expect(f.chat.sendSelectedRun(f.principal, { selection: { ...f.target, executionId: f.source.id },
      message: { requestId: 'revoked', expectedConversationId: f.stored.id, content: 'do not send' } }))
      .rejects.toMatchObject({ status: 403 })
    f.live.revoked_at = null
    const denied = { ...f.principal, grants: [{ actions: ['agent_chat:read' as const], scope: { workflowIds: ['other-workflow'] } }] }
    await expect(f.chat.readSelectedRun(denied, { selection: f.target })).rejects.toMatchObject({ status: 403 })
    expect(f.repository.state).not.toHaveBeenCalled(); expect(f.repository.admit).not.toHaveBeenCalled()
    expect(f.managers).not.toHaveBeenCalled()
  })

  it('rechecks revocation after lookup, before admitting a send or releasing transcript readback', async () => {
    const f = fixture()
    f.workflows.getSavedVersion.mockImplementation(async () => { f.live.revoked_at = new Date(); return f.saved.version })
    await expect(selected(f)).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    f.live.revoked_at = null
    await expect(f.chat.sendSelectedRun(f.principal, { selection: { ...f.target, executionId: f.source.id },
      message: { requestId: 'revoked-during-read', expectedConversationId: f.stored.id, content: 'Do not admit' } }))
      .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
    expect(f.repository.admit).not.toHaveBeenCalled(); expect(f.managers).not.toHaveBeenCalled()
  })

  it.each(['missing', 'missing-id', 'ephemeral', 'non-resumable', 'source-is-child'] as const)('%s native session has explicit unavailable capability and readable transcript', async (kind) => {
    const f = fixture()
    if (kind === 'missing') { f.stored.provider_version = null }
    if (kind === 'missing-id') { f.stored.native_session_id = null; f.stored.record.startupDelivered = true }
    if (kind === 'ephemeral') {
      const configuration = f.configurations.get(f.stored.agent_configuration_version_id)!
      f.configurations.set(configuration.id, { ...configuration, harness: { ...configuration.harness, harness: 'codex',
        advanced: { sessionPersistence: 'ephemeral' } } as typeof configuration.harness })
      f.stored.harness = 'codex'
    }
    if (kind === 'non-resumable') f.stored.record.sessionUnavailable = 'This retained session cannot be resumed.'
    if (kind === 'source-is-child') f.stored.native_session_id = f.source.nativeSessionId!
    const value = await selected(f)
    expect(value.state.availability.canSend).toBe(false)
    expect(value.state.sessionState).toBe('unavailable')
    expect(value.state.capabilities).toMatchObject({ resume: false, queueNextTurn: false, interruptAndSend: false, steer: 'unavailable' })
    expect(value.history?.messages[0]?.content).toContain(f.stored.id)
    await expect(f.chat.sendSelectedRun(f.principal, { selection: value.selection,
      message: { requestId: 'blocked-send', expectedConversationId: f.stored.id, content: 'not sent' } }))
      .rejects.toMatchObject({ code: 'AGENT_CHAT_UNAVAILABLE' })
    expect(f.repository.admit).not.toHaveBeenCalled(); expect(f.managers).not.toHaveBeenCalled()
  })

  it('reports legacy/unexecuted snapshots without manufacturing a key or inspecting the current workflow', async () => {
    const f = fixture()
    f.snapshots.delete(f.target.runId)
    expect(await f.chat.readSelectedRun(f.principal, { selection: f.target })).toEqual({ kind: 'unavailable', target: f.target, reason: 'legacy_run' })
    f.capture(f.target.runId); f.executions.set(f.target.runId, [])
    expect(await f.chat.readSelectedRun(f.principal, { selection: f.target })).toEqual({ kind: 'unavailable', target: f.target, reason: 'execution_missing' })
    expect(f.workflows.getCurrentSavedVersion).not.toHaveBeenCalled(); expect(f.managers).not.toHaveBeenCalled()
  })

  it('supports legacy origin-pinned storage keys without rekeying or choosing a different attempt', async () => {
    const f = fixture()
    f.stored.agent_key = agentChatKey(f.context)
    expect((await selected(f)).key?.conversationId).toBe(f.stored.id)
    expect(f.stored.agent_key).toBe(agentChatKey(f.context))
    expect(f.repository.admit).not.toHaveBeenCalled()
  })

  it('bounds execution choices, but resolves an explicitly requested execution beyond the first 100', async () => {
    const f = fixture()
    const many = Array.from({ length: 105 }, (_, index) => ({ ...f.source, id: `execution-${index}`, attempt: index + 1 }))
    async function* pages() { for (const execution of many) yield [execution] }
    const choices = await selectRunChatExecution(pages(), f.context, f.source.agentConfigurationVersionId)
    expect(choices && 'executions' in choices && choices.executions).toHaveLength(100)
    expect(choices).toMatchObject({ hasMoreExecutions: true })
    expect(await selectRunChatExecution(pages(), f.context, f.source.agentConfigurationVersionId, 'execution-104'))
      .toEqual({ executionId: 'execution-104' })
  })
  it.each([0, 250])('resolves one selected chat with %s unrelated attempts without reading execution pages', async count => {
    const f = fixture()
    const unrelated = Array.from({ length: count }, (_, index) => ({ ...f.source,
      id: `unrelated-${index}`, workflowNodeId: 'another-node', attempt: index + 1 }))
    f.executions.set(f.target.runId, [...unrelated, f.source])
    const pages = vi.spyOn(f.runPort, 'executionPages')
    const state = await selected(f)
    expect(state.selection.executionId).toBe(f.source.id)
    expect(f.runPort.getExecution).toHaveBeenCalledTimes(2)
    expect(pages).not.toHaveBeenCalled()
    expect(f.managers).not.toHaveBeenCalled()
  })
})
