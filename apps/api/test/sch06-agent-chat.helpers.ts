import { withChatReadClock } from './helpers/chatReadClock.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, vi } from 'vitest'
import { NativeHarnessEventSchema, type NativeHarnessEvent,
  type NativeSessionReference, type HarnessExecution } from '@foreman-code/contracts'
import { ReadSelectedRunChatResponseSchema, type SelectedRunChatTarget } from '@foreman-code/contracts/selected-run-chat'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { RunPlacementReadService } from '../src/modules/placement/readService.js'
import { PostgresScheduleDispatcher } from '../src/modules/schedules/postgresDispatcher.js'
import { WorkflowScheduleService } from '../src/modules/schedules/service.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import type { NativeSessionStart, NativeSteerInput } from '../src/modules/harnesses/port.js'
import { AgentChatF5Native } from './helpers/agentChatF5.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { waitForSuccessfulRunCleanup } from './helpers/runSettlement.testSupport.js'

// Same pending SCH-05 schema setup as its integration tests. Production registration
// is deliberately NOT altered by SCH-06. These are real migrations/SQL, not query mocks.
vi.mock('../src/infrastructure/migrations.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/infrastructure/migrations.js')>()
  const { runSnapshotMigration } = await import('../src/infrastructure/runSnapshotMigration.js')
  return { ...actual, applyApplicationMigrations: async (...args: Parameters<typeof actual.applyApplicationMigrations>) => {
    await actual.applyApplicationMigrations(...args)
    await withTransaction(args[0], async client => {
      const row = (await client.query<{ relation: string | null }>(
        "select to_regclass(current_schema() || '.run_board_snapshots')::text as relation")).rows[0]!
      if (!row.relation) await client.query(runSnapshotMigration.sql)
    })
  } }
})

/** Native-port substitute, not a live harness qualification. It records exact source/child identities. */
class RunChatNative extends AgentChatF5Native {
  override readonly session: NativeSessionReference
  readonly forks: Array<{ source: NativeSessionReference; input: NativeSessionStart }> = []
  readonly attachments: NativeSessionReference[] = []
  readonly steers: NativeSteerInput[] = []
  readonly cancellations: Array<{ session?: string; turn?: string }> = []
  wrongReceipt = false
  returnSource = false
  private reply: NativeHarnessEvent | undefined
  constructor(id: string) { super(); this.session = { harness: 'codex', providerVersion: 'sch06-fixture', nativeSessionId: `child-${id}` } }
  async forkSession(source: NativeSessionReference, input: NativeSessionStart) {
    this.forks.push({ source: structuredClone(source), input: structuredClone(input) })
    return this.returnSource ? source : this.session
  }
  override async attachSession(session: NativeSessionReference) { this.attachments.push(session); return session }
  async steerTurn(session: NativeSessionReference, input: NativeSteerInput) {
    expect(session.nativeSessionId).toBe(this.session.nativeSessionId)
    expect(input.expectedTurnId).toBe(this.nativeTurnId)
    this.steers.push(input); return { nativeTurnId: input.expectedTurnId }
  }
  override async cancel(session?: NativeSessionReference, _signal?: AbortSignal, turn?: string) {
    this.cancellations.push({ ...(session ? { session: session.nativeSessionId } : {}), ...(turn ? { turn } : {}) }); return super.cancel()
  }
  completeReply(text: string) {
    this.reply = NativeHarnessEventSchema.parse({
      sequence: 1, type: 'item.completed', occurredAt: new Date().toISOString(),
      payload: { turnId: this.nativeTurnId,
        item: { id: randomUUID(), type: 'agentMessage', text, phase: 'final_answer' } },
    })
    this.finish({ outcome: 'succeeded', output: { text } })
  }
  override async history() {
    const history = await super.history()
    return this.reply ? { ...history, events: [...history.events, this.reply] } : history
  }
  override async reconcile() {
    const history = await super.reconcile()
    return this.wrongReceipt ? { ...history, nativeTurnId: 'another-runs-turn' } : history
  }
  async dispose() { this.finish({ outcome: 'canceled' }) }
}

export async function setup() {
  const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'sequential'), approvalNodeIds: [] })
  const repository = new PostgresAgentChatRepository(f.db.pool)
  const native = new Map<string, RunChatNative>()
  const chat = new AgentChatService(f.db.pool, repository, new PostgresOperatorConversationRepository(f.db.pool), f.workflows, f.runs,
    (id) => { const manager = new RunChatNative(id); native.set(id, manager); return manager }, f.db.directory)
  // The shared current-Run fixture already owns its production app. Compose chat on
  // another real authenticated app using the same services/database/native Run reader.
  const app = buildApp({ readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access: f.access, services: { ...f.services, agentChat: chat,
      runPlacements: new RunPlacementReadService(f.db.pool, async () => []) } } })
  const clients: Client[] = []
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'sch06-integration', version: '1' }); clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return client
    }
    const mcp = await connect(f.writer.token)
    return { f, app, chat, repository, native, connect, mcp,
      async close() {
        await chat.shutdown(); await Promise.allSettled(clients.map((client) => client.close())); await app.close(); await f.close()
      } }
  } catch (error) { await chat.shutdown(); await app.close(); await f.close(); throw error }
}

type Fixture = Awaited<ReturnType<typeof setup>>
export function body(result: { isError?: boolean | undefined; structuredContent?: unknown }) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  expect(decodeMcpToolResult(result)).toBeDefined()
  return decodeMcpToolResult(result)
}
export function path(target: SelectedRunChatTarget) {
  return `/api/workspaces/${encodeURIComponent(target.workspaceId)}/agent-chat/workflows/${encodeURIComponent(target.workflowId)}`
    + `/runs/${encodeURIComponent(target.runId)}/nodes/${encodeURIComponent(target.workflowNodeId)}`
}
export async function terminal(f: Fixture['f'], runId: string) {
  await waitForSuccessfulRunCleanup({ pool: f.db.pool, runId, timeoutMs: 20000,
    readRecord: () => f.services.runs.inspection.record(f.writer.principal, { workspaceId: f.f.scope.workspaceId, runId }) })
}
export async function executions(f: Fixture['f'], runId: string): Promise<HarnessExecution[]> {
  const result: HarnessExecution[] = []
  for await (const page of f.runs.executionPages(runId)) result.push(...page)
  return result
}
export async function read(f: Fixture, target: SelectedRunChatTarget, executionId?: string, token = f.f.writer.token, mcp = f.mcp) {
  return withChatReadClock(async () => {
    const http = await f.app.inject({ method: 'GET', url: path(target) + (executionId ? `?${new URLSearchParams({ executionId })}` : ''),
      headers: { authorization: `Bearer ${token}` } })
    expect(http.statusCode, http.body).toBe(200)
    expect(http.headers['cache-control']).toBe('private, no-store')
    const { workspaceId, ...selection } = target
    const result = body(await mcp.callTool({ name: 'agent_chat_read', arguments: { workspaceId,
      selection: { ...selection, ...(executionId ? { executionId } : {}) } } }))
    expect(result).toEqual(http.json())
    return ReadSelectedRunChatResponseSchema.parse(result)
  })
}
export async function oldRunRows(f: Fixture['f'], runIds: string[]) {
  return {
    runs: (await f.db.pool.query('select * from runs where id=any($1::text[]) order by id', [runIds])).rows,
    executions: (await f.db.pool.query('select * from harness_executions where run_id=any($1::text[]) order by id', [runIds])).rows,
    sessions: (await f.db.pool.query(`select s.* from execution_native_sessions s join harness_executions e on e.id=s.execution_id
      where e.run_id=any($1::text[]) order by s.execution_id`, [runIds])).rows,
    snapshots: (await f.db.pool.query('select * from run_board_snapshots where run_id=any($1::text[]) order by run_id', [runIds])).rows,
  }
}

export async function dispatchScheduledRun(f: Fixture['f']) {
  const { workspaceId, workflowId } = f.f.scope
  await f.locations.set(f.writer.principal, 'http', {
    workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
    runnerId: f.locations.runnerId, rootPath: f.db.directory,
  })
  const due = new Date()
  due.setUTCSeconds(0, 0)
  due.setUTCMinutes(due.getUTCMinutes() + 1)
  const time = { now: new Date(due.getTime() - 1) }
  const clock = () => time.now
  const schedules = new WorkflowScheduleService(f.db.pool, f.commands, clock)
  const saved = await schedules.save(f.writer.principal, 'http', {
    workspaceId, workflowId, commandId: randomUUID(), expectedRevision: 0,
    schedule: { mode: 'once', timezone: 'UTC', localDate: due.toISOString().slice(0, 10),
      time: due.toISOString().slice(11, 16), enabled: true, policy: 'latest_saved' },
  })
  let runId = ''
  const dispatcher = new PostgresScheduleDispatcher(f.db.pool, async (principal, input, schedule) => {
    const accepted = await admitRepeatRun(f.db.pool, f.locations, principal, 'schedule', input,
      repeatStartPublication, { schedule })
    runId = accepted.value.id
  }, clock)
  time.now = new Date(due.getTime() + 1_000)
  await dispatcher.dispatch(saved.value)
  expect(runId).not.toBe('')
  return runId
}

