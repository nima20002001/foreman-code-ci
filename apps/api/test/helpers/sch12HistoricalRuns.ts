import { withChatReadClock } from './chatReadClock.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect } from 'vitest'
import type { HarnessExecution, NativeSessionReference } from '@foreman-code/contracts'
import {
  AgentChatHistoryPageSchema, AgentChatTurnPageSchema, SendAgentChatMessageResponseSchema,
} from '@foreman-code/contracts/agent-chat'
import { RunBoardSnapshotGetResultSchema } from '@foreman-code/contracts/run-snapshots'
import {
  ReadSelectedRunChatResponseSchema, type SelectedRunChatTarget,
} from '@foreman-code/contracts/selected-run-chat'
import { makeCurrentWorkflowFixture, RunStartV3ResultSchema } from '@foreman-code/contracts/wave25'
import { buildApp } from '../../src/app.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { AgentChatService } from '../../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../../src/modules/conversations/operatorChatRepository.js'
import type { NativeSessionStart, NativeTurnInput } from '../../src/modules/harnesses/port.js'
import { createWorkflowNativeCaptureChannel } from '../../src/modules/interactions/workflowNativeCapture.js'
import { RunManagementService } from '../../src/modules/runs/management.js'
import { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { createWorkflowRepositoryServices } from '../../src/modules/runs/workflowRepositoryServices.js'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { AgentChatF5Native, eventually } from './agentChatF5.js'
import { answerForRun } from './coordinationEnvelope.js'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { waitForSuccessfulRunCleanup } from './runSettlement.testSupport.js'

export type HistoricalFixture = Awaited<ReturnType<typeof currentOperatorIntegration>>
export type HistoricalApi = Awaited<ReturnType<typeof openHistoricalApi>>
export type RunTarget = Pick<SelectedRunChatTarget, 'workspaceId' | 'workflowId' | 'runId'>

/** Normal migrations, typed Save, common Run insertion and real engine; native ports
 * are the existing deterministic fixtures, not live harness qualification. */
export async function historicalFixture(form: 'sequential' | 'repeat' = 'sequential') {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), form)
  const x = fixture.version.definition.nodes[0]!, y = fixture.version.definition.nodes[1]!
  x.name = 'Agent X'; x.position = { x: -48.5, y: 120 }; x.width = 256; x.height = 144
  y.name = 'Agent Y'; y.position = { x: 415, y: 276.25 }; y.width = 312; y.height = 160

  const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [], outputFor: (nodeId, request) => form === 'repeat' && nodeId === y.id
    ? answerForRun(request, { routing: { outcome: 'issues' }, data: { latestDeliverable: 'SCH-12 retained Run output', remainingFindings: ['repeat'] } })
    : answerForRun(request, { data: { node: nodeId, resultMarker: 'SCH-12 original Run result' } }),
  })
  try {
    // Tests drive the real dispatcher explicitly with an injected clock; avoid
    // racing the fixture app's wall-clock timer against those controlled scans.
    await f.services.runs.stopScheduleDispatcher()
    return f
  } catch (error) { await f.close(); throw error }
}

/** A native-port double that detects selecting another Run's parent/child. */
export class HistoricalChatNative extends AgentChatF5Native {
  override readonly session: NativeSessionReference
  readonly forks: Array<{ source: NativeSessionReference; input: NativeSessionStart }> = []
  readonly attachments: NativeSessionReference[] = []
  private readonly epoch = randomUUID()
  constructor(conversationId: string) {
    super()
    this.session = { harness: 'codex', providerVersion: 'sch12-fixture', nativeSessionId: `sch12-child-${conversationId}` }
  }
  override async createSession(): Promise<NativeSessionReference> {
    throw new Error('Historical Run chat must fork its selected source, never create a fresh session')
  }
  async forkSession(source: NativeSessionReference, input: NativeSessionStart) {
    this.forks.push({ source: structuredClone(source), input: structuredClone(input) })
    expect(source.nativeSessionId).not.toBe(this.session.nativeSessionId)
    expect(input.environment).toBeUndefined()
    return this.session
  }
  override async attachSession(session: NativeSessionReference) {
    expect(session).toEqual(this.session)
    this.attachments.push(structuredClone(session))
    return session
  }
  override async *startTurn(session: NativeSessionReference, input: NativeTurnInput, signal?: AbortSignal) {
    expect(session).toEqual(this.session)
    yield* super.startTurn(session, { ...input, onSubmitted: async (turnId) => {
      // Fresh service generations must not reuse the double's counter-based ID.
      this.nativeTurnId = `${this.epoch}:${turnId}`
      await input.onSubmitted?.(this.nativeTurnId)
    } }, signal)
  }
  override async history() {
    return { ...await super.history(), nativeTurnId: this.nativeTurnId }
  }
  async dispose() { this.finish({ outcome: 'canceled' }) }
}

/** Re-open the retained schema with NEW authenticated app, SQL pool, Run/workflow
 * readers, chat repository/service, history service and native manager map.
 * This is a service/connection restart, not an OS kill or real-provider restart.
 * Unrelated management services and the already-settled fixture engine are reused. */
export async function openHistoricalApi(f: HistoricalFixture) {
  const pool = new pg.Pool({ connectionString: f.db.databaseUrl, max: 4,
    options: `-c search_path=${f.db.schema} -c statement_timeout=10000 -c lock_timeout=5000` })
  const commands = new PostgresCommandCoordinator(pool)
  const access = new PostgresAccessService(pool)
  const workflows = new PostgresWorkflowRepository(pool)
  const locations = new WorkspaceLocationService(pool, commands, undefined, 'local')
  const capture = createWorkflowNativeCaptureChannel()
  const runs = new PostgresRunRepository(pool, workflows, locations,
    { runtimeRoot: f.db.directory, ...createWorkflowRepositoryServices(capture.verify) })
  const repository = new PostgresAgentChatRepository(pool)
  const native = new Map<string, HistoricalChatNative>()
  const chat = new AgentChatService(pool, repository, new PostgresOperatorConversationRepository(pool), workflows, runs,
    (id) => { const manager = new HistoricalChatNative(id); native.set(id, manager); return manager }, f.db.directory)
  const services = { ...f.services, commands, locations,
    workflows: new WorkflowManagementService(pool, commands),
    runs: new RunManagementService(pool, commands, runs, f.engine, locations), agentChat: chat }
  const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access, services } })
  const clients: Client[] = []
  let closed = false
  async function close() {
    if (closed) return
    closed = true
    try { await chat.shutdown() } finally {
      await Promise.allSettled(clients.map((client) => client.close()))
      try { await app.close() } finally { await pool.end() }
    }
  }
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    async function connect(token: string) {
      const client = new Client({ name: 'sch12-historical-verification', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const client = await connect(f.writer.token)
    return { f, app, pool, access, services, runs, workflows, repository, chat, native, client, connect, close }
  } catch (error) { await close(); throw error }
}

export function toolValue(result: { isError?: boolean | undefined; structuredContent?: unknown }): unknown {
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  expect(decodeMcpToolResult(result)).toBeDefined()
  return decodeMcpToolResult(result)
}

export function snapshotPath(target: RunTarget) {
  return `/api/management/workspaces/${encodeURIComponent(target.workspaceId)}/workflows/${encodeURIComponent(target.workflowId)}`
    + `/runs/${encodeURIComponent(target.runId)}/snapshot`
}
export function selectedPath(target: SelectedRunChatTarget) {
  return `/api/workspaces/${encodeURIComponent(target.workspaceId)}/agent-chat/workflows/${encodeURIComponent(target.workflowId)}`
    + `/runs/${encodeURIComponent(target.runId)}/nodes/${encodeURIComponent(target.workflowNodeId)}`
}
export function targetFor(f: HistoricalFixture, runId = f.f.run.id): RunTarget {
  return { workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId, runId }
}
export async function terminal(f: HistoricalFixture, runId = f.f.run.id) {
  await waitForSuccessfulRunCleanup({ pool: f.db.pool, runId, timeoutMs: 30_000,
    readRecord: () => f.services.runs.inspection.record(f.writer.principal, { workspaceId: f.f.scope.workspaceId, runId }) })
}
export async function runA(f: HistoricalFixture) { await f.engine.start(f.f.run.id); await terminal(f) }
export async function allExecutions(f: HistoricalFixture, runId = f.f.run.id): Promise<HarnessExecution[]> {
  const executions: HarnessExecution[] = []
  for await (const page of f.runs.executionPages(runId)) executions.push(...page)
  return executions
}
export async function qualifyLocation(f: HistoricalFixture) {
  return (await f.locations.set(f.writer.principal, 'http', { workspaceId: f.f.scope.workspaceId,
    commandId: randomUUID(), expectedLocationRevision: 1, runnerId: f.locations.runnerId, rootPath: f.db.directory })).value
}
export async function saveWithoutY(f: HistoricalFixture) {
  const location = await qualifyLocation(f)
  const { workspaceId, workflowId } = f.f.scope
  const graph = structuredClone(f.f.version.definition), y = graph.nodes[1]!
  graph.nodes = graph.nodes.filter((node) => node.id !== y.id)
  graph.edges = graph.edges.filter((edge) => edge.source !== y.id && edge.target !== y.id)
  graph.executionPolicy = { maxParallelism: 1, maxNodeExecutions: graph.nodes.length }
  if (graph.requiredAgentCount !== undefined) graph.requiredAgentCount = graph.nodes.length
  const revision = Number((await f.db.pool.query<{ revision: string }>(
    'select revision::text from workflows where id=$1', [workflowId])).rows[0]!.revision)
  const saved = (await f.services.workflows.current.save(f.writer.principal, 'http', {
    workspaceId, workflowId, commandId: randomUUID(), executionSemanticsVersion: 3,
    expectedRevision: revision, expectedWorkflowVersionId: f.f.version.id,
    expectedAgentConfigurationVersionIds: Object.fromEntries(graph.nodes.map((node) =>
      [node.agentId, f.f.version.agentConfigurationVersionIds[node.agentId]!])), graph,
  })).value
  const layoutGraph = structuredClone(saved.version.definition)
  layoutGraph.nodes[0]!.position = { x: 909, y: -33 }; layoutGraph.nodes[0]!.width = 480
  const layoutSaved = (await f.services.workflows.current.save(f.writer.principal, 'http', {
    workspaceId, workflowId, commandId: randomUUID(), executionSemanticsVersion: 3,
    expectedRevision: saved.revision, expectedWorkflowVersionId: saved.version.id,
    expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
    graph: layoutGraph,
  })).value
  return { saved: layoutSaved, location }
}
export async function startSaved(f: HistoricalFixture, version = f.f.version) {
  const row = (await f.db.pool.query<{ revision: string; location_revision: string }>(
    `select w.revision::text,s.location_revision::text from workflows w join workspaces s on s.id=w.workspace_id
     where w.id=$1`, [version.workflowId])).rows[0]!
  const result = RunStartV3ResultSchema.parse(toolValue(await f.client.callTool({ name: 'run_start', arguments: {
    workspaceId: version.workspaceId, workflowId: version.workflowId, workflowVersionId: version.id,
    executionSemanticsVersion: 3, commandId: randomUUID(), expectedWorkflowRevision: Number(row.revision),
    expectedLocationRevision: Number(row.location_revision), expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds, input: {},
  } })))
  await terminal(f, result.run.id)
  return result.run
}

export async function readSnapshot(api: HistoricalApi, target: RunTarget, token = api.f.writer.token, client = api.client) {
  const http = await api.app.inject({ method: 'GET', url: snapshotPath(target), headers: { authorization: `Bearer ${token}` } })
  expect(http.statusCode, http.body).toBe(200)
  expect(http.headers['cache-control']).toBe('private, no-store')
  expect(http.headers.vary).toContain('Authorization')
  const mcp = toolValue(await client.callTool({ name: 'run_board_snapshot_get', arguments: { ...target } }))
  expect(mcp).toEqual(http.json())
  return RunBoardSnapshotGetResultSchema.parse(mcp).snapshot
}
export async function readSelected(api: HistoricalApi, target: SelectedRunChatTarget, executionId?: string,
  token = api.f.writer.token, client = api.client) {
  return withChatReadClock(async () => {
    const query = executionId ? `?${new URLSearchParams({ executionId })}` : ''
    const http = await api.app.inject({ method: 'GET', url: selectedPath(target) + query, headers: { authorization: `Bearer ${token}` } })
    expect(http.statusCode, http.body).toBe(200)
    expect(http.headers['cache-control']).toBe('private, no-store')
    const { workspaceId, ...selection } = target
    const mcp = toolValue(await client.callTool({ name: 'agent_chat_read', arguments: {
      workspaceId, selection: { ...selection, ...(executionId ? { executionId } : {}) },
    } }))
    expect(mcp).toEqual(http.json())
    return ReadSelectedRunChatResponseSchema.parse(mcp)
  })
}
export async function conversationPages(api: HistoricalApi, target: SelectedRunChatTarget, executionId: string) {
  const { workspaceId, ...selection } = target
  const selected = ReadSelectedRunChatResponseSchema.parse(toolValue(await api.client.callTool({ name: 'agent_chat_read', arguments: {
    workspaceId, selection: { ...selection, executionId }, history: { limit: 100 }, receipts: { limit: 100 },
  } })))
  if (selected.kind !== 'selected' || !selected.key) throw new Error('Expected a retained, fully keyed conversation')
  const root = `/api/workspaces/${encodeURIComponent(workspaceId)}/agent-chat/conversations/${encodeURIComponent(selected.key.conversationId)}`
  const headers = { authorization: `Bearer ${api.f.writer.token}` }
  const history = await api.app.inject({ method: 'GET', url: `${root}/history?limit=100`, headers })
  const receipts = await api.app.inject({ method: 'GET', url: `${root}/turns?limit=100`, headers })
  expect(history.statusCode, history.body).toBe(200); expect(receipts.statusCode, receipts.body).toBe(200)
  expect(selected.history).toEqual(AgentChatHistoryPageSchema.parse(history.json()))
  expect(selected.receipts).toEqual(AgentChatTurnPageSchema.parse(receipts.json()))
  return selected
}
export async function sendAndFinish(api: HistoricalApi, target: SelectedRunChatTarget, executionId: string,
  expectedConversationId: string | null, requestId: string, content: string, via: 'http' | 'mcp' = 'http') {
  const message = { expectedConversationId, requestId, content }
  const { workspaceId, ...selection } = target
  const sent = via === 'mcp'
    ? toolValue(await api.client.callTool({ name: 'agent_chat_send', arguments: { workspaceId, selection: { ...selection, executionId }, message } }))
    : await (async () => {
      const response = await api.app.inject({ method: 'POST', url: `${selectedPath(target)}/messages`,
        headers: { authorization: `Bearer ${api.f.writer.token}` }, payload: { executionId, ...message } })
      expect(response.statusCode, response.body).toBe(202)
      return response.json()
    })()
  const id = SendAgentChatMessageResponseSchema.parse(sent).state.conversation!.id
  await eventually(async () => {
    const native = api.native.get(id), row = await api.repository.get(id)
    return !!native?.prompts.some((prompt) => prompt.includes(content))
      && row?.active_request_id === requestId && row.active_native_turn_id === native.nativeTurnId
  })
  const native = api.native.get(id)!
  native.finish({ outcome: 'succeeded', output: { text: `Chat-only answer: ${content}` } })
  await eventually(async () => (await api.repository.turn(id, requestId))?.delivery === 'completed'
    && (await api.repository.get(id))?.active_request_id === null)
  return { id, native }
}

/** Snapshot full SQL rows, not only run.status: result bodies, original source
 * sessions, canonical head, activities and native events must also stay unchanged.
 * Tests call this only after cleanup/turn settlement, never while Runs are active. */
export async function historicalRows(pool: pg.Pool, runIds: string[]) {
  return {
    runs: (await pool.query('select * from runs where id=any($1::text[]) order by id', [runIds])).rows,
    executions: (await pool.query('select * from harness_executions where run_id=any($1::text[]) order by id', [runIds])).rows,
    sessions: (await pool.query(`select s.* from execution_native_sessions s join harness_executions e on e.id=s.execution_id
      where e.run_id=any($1::text[]) order by s.execution_id`, [runIds])).rows,
    snapshots: (await pool.query('select * from run_board_snapshots where run_id=any($1::text[]) order by run_id', [runIds])).rows,
    heads: (await pool.query('select * from run_graph_heads where run_id=any($1::text[]) order by run_id', [runIds])).rows,
    activity: (await pool.query('select * from run_activity where run_id=any($1::text[]) order by run_id,sequence', [runIds])).rows,
    events: (await pool.query(`select n.* from harness_native_events n join harness_executions e on e.id=n.execution_id
      where e.run_id=any($1::text[]) order by n.execution_id,n.sequence`, [runIds])).rows,
  }
}
