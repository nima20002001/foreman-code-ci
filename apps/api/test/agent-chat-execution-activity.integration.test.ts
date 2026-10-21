import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import {
  AgentChatExecutionActivityPageSchema, ReadAgentChatResponseSchema, type AgentChatExecutionActivityQuery,
} from '@foreman-code/contracts/agent-chat'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import {
  CURRENT_WORKFLOW_ROUTES, CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema,
} from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { openRepeatCanonicalPublicationLocked } from '../src/modules/run-graph/repeatPublication.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import { repeatTerminalResolution } from '../src/modules/runs/repeatNode.js'
import { repeatDigest, repeatId } from '../src/modules/runs/repeatResolution.js'
import { createWorkflowRepositoryServices } from '../src/modules/runs/workflowRepositoryServices.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { graphFixture, graphHeaders, graphRpc, graphRpcValue, ownedGraph, changeRunState } from './eng04-graph-composition-fixture.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

const at = '2026-01-01T00:00:00.000Z'
const claudeConfiguration: ClaudeHarnessConfiguration = {
  harness: 'claude', model: 'fixture-model', effort: 'medium', authMode: 'subscription',
  configDirectory: '/fixture/profile', permissionMode: 'default', sandbox: 'danger-full-access',
  tools: [], permissionRules: [], instructions: '', mcpServers: {},
}
type NativeRecord = { type: string; payload: Record<string, unknown> }
type ActivityRequest = Partial<Omit<AgentChatExecutionActivityQuery,
  'workflowId' | 'workflowNodeId' | 'agentId' | 'runId'>>

describe('Persisted execution activity through HTTP and authenticated MCP', { timeout: 60_000 }, () => {
  let database: Awaited<ReturnType<typeof currentDatabase>>
  beforeAll(async () => { database = await currentDatabase() }, 60_000)
  afterAll(async () => { await database?.close() })

  it.each(['codex', 'claude'] as const)('persists an activity fixture for %s through HTTP and MCP', async harness => {
    const fixture = await setup(harness === 'claude' ? claudeConfiguration : undefined)
    const { graph } = fixture
    try {
      const { workspaceId, workflowId, workflowVersionId } = graph.scope
      const url = CURRENT_WORKFLOW_ROUTES.saved.replace(':workspaceId', workspaceId).replace(':workflowId', workflowId)
      const response = await graph.app.inject({
        method: 'GET', url, headers: graphHeaders(graph.writer.token),
      })
      expect(response.statusCode, response.body).toBe(200)
      const saved = CurrentWorkflowReadResultSchema.parse(response.json())
      expect(saved.version).toEqual(graph.version)
      expect(saved.version.approval).toEqual({ handler: 'user' })
      expect(saved.version.definition.approval).toEqual(saved.version.approval)
      if (harness === 'codex') {
        expect(saved.version.definition.nodes[0]).toMatchObject({ interval: { everySeconds: 10 } })
      } else {
        expect(saved.version.definition.nodes[0]).not.toHaveProperty('interval')
      }
      const remote = await graphRpc(graph.app, graph.writer.token, 'tools/call', {
        name: CURRENT_WORKFLOW_TOOLS.saved, arguments: { workspaceId, workflowId, workflowVersionId },
      })
      expect(remote.result?.isError).not.toBe(true)
      expect(CurrentWorkflowReadResultSchema.parse(graphRpcValue(remote.result))).toEqual(saved)
      expect(await fixture.mcpPage()).toEqual(await fixture.http())
      await fixture.denied()
      expect(fixture.managers).not.toHaveBeenCalled()
    } finally {
      await fixture.close()
    }
  })

  async function setup(harness?: ClaudeHarnessConfiguration) {
    const graph = await graphFixture(database, {
      form: 'single',
      ...(harness ? { harness } : { intervalEverySeconds: 10 }),
    })
    const node = agentWorkflowNode(graph.version.definition.nodes[0])
    const workflows = new PostgresWorkflowRepository(database.pool)
    const locations = new WorkspaceLocationService(database.pool, graph.commands)
    const runs = new PostgresRunRepository(database.pool, workflows, locations, {
      runtimeRoot: database.directory,
      ...createWorkflowRepositoryServices(createWorkflowNativeCaptureChannel().verify),
    })
    const candidate = HarnessExecutionSchema.parse({
      id: randomUUID(), runId: graph.run.id, workflowNodeId: node.id, agentId: node.agentId,
      agentConfigurationVersionId: graph.version.agentConfigurationVersionIds[node.agentId],
      attempt: 1, state: 'queued', input: {}, createdAt: graph.run.createdAt,
    })
    const admitted = await ownedGraph(database, graph, owner =>
      runs.admitRepeatExecution({ nodeId: node.id, occurrence: null }, () => candidate, owner))
    if (admitted.kind !== 'admitted') throw new Error('Expected the fixture execution to be admitted')
    // Synthetic observations exercise persisted reads without launching native sessions.
    async function persistExecution(owner: RunOwnership, previous: HarnessExecution, next: HarnessExecution) {
      await owner.oneShotConnection().transaction(async sql => {
        const publication = await openRepeatCanonicalPublicationLocked(sql, graph.scope, owner)
        const source = { execution: next }
        const sourceDigest = repeatDigest(source)
        await publication.publishNativeLocked({
          kind: 'observation', scope: graph.scope, ref: { nodeId: node.id, occurrence: null },
          previous, next, source, sourceDigest, sourceRevision: '1', effect: null,
          sourceId: repeatId('repeat-native', graph.run.id, 'outside', next.id, 'observation', sourceDigest),
        }, async () => {
          await sql.query('update harness_executions set record=$2::jsonb,created_at=$3 where id=$1',
            [next.id, JSON.stringify(next), next.createdAt])
        })
      })
    }
    await ownedGraph(database, graph, owner => persistExecution(owner, admitted.execution,
      HarnessExecutionSchema.parse({ ...admitted.execution, state: 'running', nativeSessionId: 'thread' })))
    const transfers: unknown[][] = []
    let queryFailure: string | undefined
    const observedPool = new Proxy(database.pool, {
      get(target, property) {
        if (property === 'query') return async (...args: unknown[]) => {
          try {
            const result = await Reflect.apply(target.query, target, args) as pg.QueryResult
            transfers.push(result.rows)
            return result
          } catch (error) {
            queryFailure = error instanceof Error ? error.message : String(error)
            throw error
          }
        }
        const value: unknown = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    const managers = vi.fn((): never => { throw new Error('Activity reads must not launch native sessions') })
    const chat = new AgentChatService(observedPool, new PostgresAgentChatRepository(database.pool),
      new PostgresOperatorConversationRepository(database.pool), workflows, runs, managers, database.directory)
    const reader = await graph.credential([{ actions: ['agent_chat:read'], scope: graph.grantScope }])
    const denied = await graph.credential([{ actions: ['agent_chat:read'], scope: { workspaceIds: ['other-workspace'] } }])
    const app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access: graph.access, services: { agentChat: chat, commands: graph.commands } as unknown as OperatorServices },
    })
    const clients: Client[] = []
    const origin = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const client = new Client({ name: 'execution-activity-reader', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const mcp = await connect(reader.token)
    const deniedMcp = await connect(denied.token)
    const query = { workflowId: graph.scope.workflowId, workflowNodeId: node.id,
      agentId: node.agentId, runId: graph.run.id }
    const url = `/api/workspaces/${graph.scope.workspaceId}/agent-chat/execution-activity`
    const httpResponse = (request: ActivityRequest = {}, token = reader.token) => app.inject({
      method: 'GET', url: `${url}?${new URLSearchParams({ ...query,
        ...Object.fromEntries(Object.entries(request).map(([key, value]) => [key, String(value)])),
      })}`, headers: { authorization: `Bearer ${token}` },
    })
    const http = async (request: ActivityRequest = {}) => {
      const response = await httpResponse(request)
      expect(response.statusCode, queryFailure ?? response.body).toBe(200)
      expect(Buffer.byteLength(response.body)).toBeLessThanOrEqual(256 * 1024)
      return AgentChatExecutionActivityPageSchema.parse(response.json())
    }
    const mcpArguments = (request: ActivityRequest = {}) => ({
      workspaceId: graph.scope.workspaceId, query, executionActivity: request,
    })
    const mcpPage = async (request: ActivityRequest = {}) => {
      const result = await mcp.callTool({ name: 'agent_chat_read', arguments: mcpArguments(request) })
      expect(result.isError, JSON.stringify(result)).not.toBe(true)
      const page = ReadAgentChatResponseSchema.parse(decodeMcpToolResult(result)).executionActivity
      expect(page).toBeDefined()
      return page!
    }
    let sequence = 0
    const append = async (records: NativeRecord[], options: { retainedHistory?: boolean } = {}) => {
      const events = records.map(record => ({ ...record, executionId: candidate.id, sequence: ++sequence,
        occurredAt: at, payload: { threadId: 'thread', turnId: 'turn', ...record.payload } }))
      if (options.retainedHistory) {
        await database.pool.query(`insert into harness_native_events(execution_id,sequence,record)
          select $1,(value->>'sequence')::integer,value from jsonb_array_elements($2::jsonb) value`,
        [candidate.id, JSON.stringify(events)])
        return
      }
      await database.pool.query('select append_harness_native_event(value) from jsonb_array_elements($1::jsonb) value',
        [JSON.stringify(events)])
    }
    const state = async (value: 'failed' | 'canceled') => {
      const previous = (await runs.getExecution(candidate.id))!
      const terminal = HarnessExecutionSchema.parse({ ...previous, state: 'completed',
        result: { outcome: value, ...(value === 'failed' ? {
          error: { code: 'COMMAND_FAILED', message: 'The command failed', retryable: false },
        } : {}) }, finishedAt: new Date().toISOString(),
      })
      await ownedGraph(database, graph, owner => persistExecution(owner, previous, terminal))
    }
    return { graph, executionId: candidate.id, transfers, managers, append, state, http, mcpPage,
      seedNewerExecutions: async () => {
        await changeRunState(database, graph, 'running')
        const stored = (await database.pool.query<{ created_at: Date }>(
          'select created_at from harness_executions where id=$1', [candidate.id])).rows[0]!
        // Terminal observations are synthetic; each state and resolution still receives a graph publication.
        const original = (await runs.getExecution(candidate.id))!
        const completed = HarnessExecutionSchema.parse({ ...original, state: 'completed',
          finishedAt: at, result: { outcome: 'canceled' } })
        const resolution = repeatTerminalResolution(graph.version, graph.scope,
          { nodeId: node.id, occurrence: null }, completed)
        await ownedGraph(database, graph, async owner => {
          await persistExecution(owner, original, completed)
          await owner.oneShotConnection().transaction(async sql => {
            const publication = await openRepeatCanonicalPublicationLocked(sql, graph.scope, owner)
            const fence = await owner.readOneShotFence(sql)
            const effect = { kind: 'terminal.accept' as const, entityId: completed.id,
              digest: repeatDigest({ execution: completed, resolution, decision: null, successor: null, exported: null }) }
            await publication.publishEffectLocked(effect,
              [{ type: 'repeat.node.resolved', resolution, outside: true }], async () => {
                await sql.query(`insert into run_repeat_resolutions
                  (run_id,occurrence_key,workflow_node_id,execution_id,record) values($1,'',$2,$3,$4::jsonb)`,
                [graph.run.id, node.id, completed.id, JSON.stringify(resolution)])
                await sql.query(`insert into run_repeat_effects
                  (run_id,effect_kind,entity_id,payload_digest,owner_id,owner_fence) values($1,$2,$3,$4,$5,$6)`,
                [graph.run.id, effect.kind, effect.entityId, effect.digest, fence.ownerId, fence.fence])
              })
          })
          const repository = await runs.repeat(owner)
          let settledId: string | null = null
          for (let index = 1; index <= 21; index++) {
            const createdAt = new Date(stored.created_at.getTime() + index * 1000).toISOString()
            const admitted = await repository.admitTick(node.id,
              () => HarnessExecutionSchema.parse({ ...candidate, id: randomUUID(), createdAt }), settledId)
            if (admitted.kind !== 'admitted') throw new Error('Expected a retained interval check to be admitted')
            const execution = HarnessExecutionSchema.parse({ ...admitted.execution, state: 'completed',
              finishedAt: at, result: { outcome: 'canceled' } })
            await persistExecution(owner, admitted.execution, execution)
            settledId = execution.id
          }
        })
      },
      foreignScope: async (field: 'workspaceId' | 'workflowId' | 'workflowNodeId' | 'agentId' | 'runId') => {
        const workspaceId = field === 'workspaceId' ? 'foreign-workspace' : graph.scope.workspaceId
        const foreignQuery = { ...query, ...(field === 'workspaceId' ? {} : { [field]: 'foreign-identity' }) }
        const response = await app.inject({ method: 'GET',
          url: `/api/workspaces/${workspaceId}/agent-chat/execution-activity?${new URLSearchParams({
            ...foreignQuery, executionId: candidate.id, itemId: 'old-answer',
          })}`, headers: { authorization: `Bearer ${reader.token}` } })
        if (response.statusCode === 200) {
          expect(AgentChatExecutionActivityPageSchema.parse(response.json()).items).toEqual([])
        } else expect(response.statusCode).toBeGreaterThanOrEqual(400)
        const result = await mcp.callTool({ name: 'agent_chat_read', arguments: {
          workspaceId, query: foreignQuery, executionActivity: { executionId: candidate.id, itemId: 'old-answer' },
        } })
        if (!result.isError) {
          expect(ReadAgentChatResponseSchema.parse(decodeMcpToolResult(result)).executionActivity?.items).toEqual([])
        }
      },
      denied: async () => {
        expect((await httpResponse({}, denied.token)).statusCode).toBe(403)
        await expectMcpAccessDenied(deniedMcp.callTool({ name: 'agent_chat_read', arguments: mcpArguments() }))
      },
      close: async () => {
        await Promise.allSettled(clients.map(client => client.close()))
        await app.close()
        await graph.app.close()
        await chat.shutdown()
      },
    }
  }

  it('keeps retained execution history consistent with canonical graph readback', async () => {
    const fixture = await setup()
    const { graph } = fixture
    const reader = new RunGraphReadService(database.pool, { qualifiedReads: true })
    try {
      const initial = await reader.snapshot(graph.writer.principal, graph.readRequest)
      expect(initial.state.executions).toMatchObject([{
        identity: { executionId: fixture.executionId }, state: 'running',
      }])
      await fixture.seedNewerExecutions()
      const retained = await reader.snapshot(graph.writer.principal, graph.readRequest)
      expect(retained.state.executions).toHaveLength(22)
      expect(retained.state.executions.every(execution =>
        execution.state === 'completed' && execution.resultOutcome === 'canceled')).toBe(true)
      expect(retained.state.resolutions).toMatchObject([{
        outside: true, value: { execution: { executionId: fixture.executionId }, resolution: 'canceled' },
      }])
      const overview = await fixture.http()
      expect(overview.executions).toHaveLength(20)
      expect(overview.hasEarlierExecutions).toBe(true)
      expect(await fixture.mcpPage()).toEqual(overview)
      expect(await reader.snapshot(graph.writer.principal, graph.readRequest)).toEqual(retained)
      await fixture.denied()
      expect(fixture.managers).not.toHaveBeenCalled()
    } finally {
      await fixture.close()
    }
  })

  it('reads the MCP overview after retained history exceeds twenty executions', async () => {
    const fixture = await setup()
    try {
      await fixture.seedNewerExecutions()
      const overview = await fixture.http()
      expect(overview.executions).toHaveLength(20)
      expect(overview.hasEarlierExecutions).toBe(true)
      expect(await fixture.mcpPage()).toEqual(overview)
      await fixture.denied()
      expect(fixture.managers).not.toHaveBeenCalled()
    } finally { await fixture.close() }
  })

  it('reads an older execution and its message beyond the bounded overview through HTTP and MCP', async () => {
    const fixture = await setup()
    try {
      await fixture.append([{ type: 'item.completed', payload: {
        item: { id: 'old-answer', type: 'agentMessage', text: 'Persisted oldest answer' },
      } }])
      await fixture.seedNewerExecutions()
      const overview = await fixture.http()
      expect(overview.executions).toHaveLength(20)
      expect(overview.executions.map(item => item.tickIndex)).toEqual(
        Array.from({ length: 20 }, (_, index) => index + 2),
      )
      expect(overview.executions.some(item => item.executionId === fixture.executionId)).toBe(false)
      expect(overview.hasEarlierExecutions).toBe(true)
      for (const request of [{ executionId: fixture.executionId }, { executionId: fixture.executionId, itemId: 'old-answer' }]) {
        const page = await fixture.http(request)
        expect(page.items).toMatchObject([{ executionId: fixture.executionId, id: 'old-answer',
          entry: { kind: 'message', message: { content: 'Persisted oldest answer' } } }])
        expect(await fixture.mcpPage(request)).toEqual(page)
      }
      for (const field of ['workspaceId', 'workflowId', 'workflowNodeId', 'agentId', 'runId'] as const) {
        await fixture.foreignScope(field)
      }
      await fixture.denied()
    } finally { await fixture.close() }
  })

  it.each(['failed', 'canceled'] as const)('delivers every unfinished tool after %s without new native events', async state => {
    const fixture = await setup()
    try {
      await fixture.append(Array.from({ length: 5 }, (_, index) => ({ type: 'item.started', payload: {
        item: { id: `command-${index}`, type: 'commandExecution', command: `check ${index}`, status: 'inProgress' },
      } })))
      const first = await fixture.http()
      expect(first.items).toHaveLength(5)
      await fixture.state(state)
      const changed = []
      let cursor = first.cursor!
      for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
        const page = await fixture.http({ cursor, limit: 2 })
        expect(await fixture.mcpPage({ cursor, limit: 2 })).toEqual(page)
        changed.push(...page.items)
        cursor = page.cursor!
        if (!page.hasMoreChanges) break
      }
      expect(changed.map(item => item.id)).toEqual(first.items.map(item => item.id))
      for (const item of changed) {
        expect(item.entry).toMatchObject({ kind: 'activity', activity: { status: 'unknown' } })
        expect(BigInt(item.revision)).toBeGreaterThan(BigInt(first.items.find(prior => prior.id === item.id)!.revision))
      }
      expect((await fixture.http({ cursor })).items).toEqual([])
      expect((await fixture.http()).items).toEqual(changed)
      await fixture.denied()
      expect(fixture.managers).not.toHaveBeenCalled()
    } finally { await fixture.close() }
  })

  it.each(['http', 'mcpPage'] as const)('delivers the first sequence-zero event once through %s', async (endpoint) => {
    const fixture = await setup()
    try {
      const empty = await fixture[endpoint]()
      expect(empty.items).toEqual([])
      await database.pool.query('select append_harness_native_event($1::jsonb)', [JSON.stringify({
        executionId: fixture.executionId, connectionId: 'connection-first', sequence: 0, occurredAt: at,
        type: 'item.completed', payload: { threadId: 'thread', turnId: 'turn',
          item: { id: 'first-message', type: 'agentMessage', text: 'First native message' } },
      })])
      const changes = await fixture[endpoint]({ cursor: empty.cursor })
      expect(changes.mode).toBe('changes')
      expect(changes.items).toMatchObject([{ id: 'first-message', sequence: '0',
        entry: { message: { content: 'First native message' } } }])
      expect((await fixture[endpoint]({ cursor: changes.cursor })).items).toEqual([])
      const legacy = JSON.stringify({ [fixture.executionId]: { n: '0', e: '0', t: false } })
      expect((await fixture[endpoint]({ cursor: legacy })).items).toHaveLength(1)
      await fixture.denied()
    } finally { await fixture.close() }
  })

  it('keeps Claude commands, streamed arguments, file changes and redacted tool results on persisted readback', async () => {
    const fixture = await setup(claudeConfiguration)
    const secret = `opm_${'a'.repeat(43)}`
    try {
      await fixture.append([
        { type: 'claude.tool', payload: { itemId: 'bash', name: 'Bash', input: { command: 'git status' }, status: 'running' } },
        { type: 'claude.tool', payload: { itemId: 'bash', name: 'Bash', output: 'clean', status: 'completed' } },
        { type: 'claude.tool', payload: { itemId: 'read', name: 'Read', input: { file_path: '/work/report.txt' }, status: 'running' } },
        { type: 'claude.tool', payload: { itemId: 'read', output: [{ type: 'text', text: 'File contents' }], status: 'completed' } },
        { type: 'claude.tool', payload: { itemId: 'edit', name: 'Edit', input: {
          file_path: '/work/report.txt', old_string: 'before', new_string: 'after',
        }, status: 'completed', output: 'Updated' } },
        { type: 'claude.tool', payload: { itemId: 'mcp', name: 'mcp__tools__lookup', inputJsonDelta: '{"query":', status: 'running' } },
        { type: 'claude.tool', payload: { itemId: 'mcp', name: 'mcp__tools__lookup', inputJsonDelta: '"status"}', status: 'running' } },
        { type: 'claude.tool', payload: { itemId: 'mcp', output: `Result ${secret}`, status: 'completed' } },
        { type: 'claude.tool', payload: { itemId: 'boundary', name: 'Bash', input: { command: 'check output' },
          output: `${'x'.repeat(3_990)}${secret} ${'y'.repeat(19_952)}${secret}`, status: 'completed' } },
      ])
      const page = await fixture.http()
      expect(await fixture.mcpPage()).toEqual(page)
      expect(page.items.map(item => item.id)).toEqual(['bash', 'read', 'edit', 'mcp', 'boundary'])
      expect(page.items[0]?.entry).toMatchObject({ activity: { title: 'git status', input: expect.stringContaining('git status'), output: 'clean' } })
      expect(page.items[1]?.entry).toMatchObject({ activity: { title: 'Read /work/report.txt', output: 'File contents' } })
      expect(page.items[2]?.entry).toMatchObject({ activity: { title: 'Edit /work/report.txt', input: expect.stringContaining('after'), output: 'Updated' } })
      expect(page.items[3]?.entry).toMatchObject({ activity: { title: 'mcp__tools__lookup', input: '{"query":"status"}', output: 'Result [REDACTED]' } })
      expect(JSON.stringify(page.items[4])).not.toContain('opm_')
      const request = { executionId: fixture.executionId, itemId: 'edit' }
      expect(await fixture.mcpPage(request)).toEqual(await fixture.http(request))
      const boundary = await fixture.http({ executionId: fixture.executionId, itemId: 'boundary' })
      expect(JSON.stringify(boundary)).not.toContain('opm_')
      expect(JSON.stringify(page)).not.toContain(secret)
      await fixture.denied()
      expect(fixture.managers).not.toHaveBeenCalled()
    } finally { await fixture.close() }
  })

  it('continues incremental pages when native appends advance the execution allocator revision', async () => {
    const fixture = await setup()
    try {
      await fixture.append([
        { type: 'item.completed', payload: { item: { id: 'initial', type: 'agentMessage', text: 'Initial note' } } },
        ...Array.from({ length: 5 }, (_, index) => ({ type: 'item.started', payload: {
          item: { id: `command-${index}`, type: 'commandExecution', command: `check ${index}`, status: 'inProgress' },
        } })),
      ])
      const first = await fixture.http()
      await fixture.append(Array.from({ length: 5 }, (_, index) => ({ type: 'item.completed', payload: {
        item: { id: `command-${index}`, type: 'commandExecution', command: `check ${index}`, status: 'completed',
          aggregatedOutput: 'done' },
      } })))
      const initialChanges = await fixture.http({ cursor: first.cursor!, limit: 2 })
      expect(initialChanges.items.map(item => item.id)).toEqual(['command-0', 'command-1'])
      expect(initialChanges.hasMoreChanges).toBe(true)
      await fixture.append([{ type: 'item.completed', payload: {
        item: { id: 'new-note', type: 'agentMessage', text: 'Appended during pagination' },
      } }])
      const changed = [...initialChanges.items]
      let cursor = initialChanges.cursor!
      for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
        const request = { cursor, limit: 2 }
        const page = await fixture.http(request)
        expect(await fixture.mcpPage(request)).toEqual(page)
        changed.push(...page.items)
        cursor = page.cursor!
        if (!page.hasMoreChanges) break
      }
      expect(changed.map(item => item.id)).toEqual([
        'command-0', 'command-1', 'command-2', 'command-3', 'command-4', 'new-note',
      ])
      expect((await fixture.http({ cursor })).items).toEqual([])
    } finally { await fixture.close() }
  })

  it('bounds cold database transfer and public pages while retaining targeted details and older updated history', async () => {
    const fixture = await setup()
    const large = '\u0001漢'.repeat(20_000)
    try {
      await fixture.append(Array.from({ length: 320 }, (_, index) => ({ type: 'item.completed', payload: {
        item: { id: `message-${index + 1}`, type: 'agentMessage', text: `${index + 1}: ${large}` },
      } })), { retainedHistory: true })
      fixture.transfers.length = 0
      const newest = await fixture.http({ limit: 1 })
      expect(newest.items.map(item => item.id)).toEqual(['message-320'])
      expect(newest.executions[0]?.hasEarlierItems).toBe(true)
      expect(fixture.transfers.every(rows => rows.length <= 21)).toBe(true)
      const transferredBytes = fixture.transfers.reduce((total, rows) => total + Buffer.byteLength(JSON.stringify(rows)), 0)
      expect(transferredBytes).toBeLessThan(1024 * 1024)
      const expanded = await fixture.http({ executionId: fixture.executionId, itemId: 'message-1' })
      expect(expanded.items).toHaveLength(1)
      expect(expanded.items[0]?.sequence).toBe('1')
      expect(expanded.items[0]?.entry).toMatchObject({ message: { truncation: { truncated: true } } })
      expect(await fixture.mcpPage({ executionId: fixture.executionId, itemId: 'message-1' })).toEqual(expanded)
      await fixture.append([{ type: 'item.completed', payload: {
        item: { id: 'message-1', type: 'agentMessage', text: 'Updated first entry' },
      } }])
      const change = await fixture.http({ cursor: newest.cursor! })
      expect(change.items).toMatchObject([{ id: 'message-1', sequence: '1', entry: { message: { content: 'Updated first entry' } } }])
      const request = { executionId: fixture.executionId, before: '320', limit: 1 }
      const earlier = await fixture.http(request)
      expect(earlier.items.map(item => item.id)).toEqual(['message-319'])
      expect(await fixture.mcpPage(request)).toEqual(earlier)
      await fixture.append([
        { type: 'item.started', payload: { item: { id: 'stream', type: 'agentMessage', text: 'BEGIN ' } } },
        ...Array.from({ length: 4 }, () => ({ type: 'native.notification', payload: {
          itemId: 'stream', nativeMethod: 'item/agentMessage/delta', delta: 'z'.repeat(20_000),
        } })),
      ])
      const streamedRequest = { executionId: fixture.executionId, itemId: 'stream' }
      const streamed = await fixture.http(streamedRequest)
      expect(await fixture.mcpPage(streamedRequest)).toEqual(streamed)
      expect(streamed.items[0]?.entry).toMatchObject({ message: {
        content: expect.stringMatching(/^BEGIN /), nativeMessageComplete: false,
        truncation: { truncated: true, originalBytes: 80_006 },
      } })
      await fixture.denied()
      expect(fixture.managers).not.toHaveBeenCalled()
    } finally { await fixture.close() }
  })

  it('preserves public plan bodies and original sequence when an old plan changes outside the newest window', async () => {
    const fixture = await setup()
    try {
      await fixture.append([
        { type: 'native.notification', payload: { nativeMethod: 'turn/plan/updated',
          plan: [{ step: 'First step', status: 'inProgress' }] } },
        { type: 'item.completed', payload: { item: { id: 'answer', type: 'agentMessage', text: 'Working' } } },
      ])
      const first = await fixture.http({ limit: 1 })
      expect(first.items[0]?.id).toBe('answer')
      await fixture.append([{ type: 'native.notification', payload: { nativeMethod: 'turn/plan/updated',
        explanation: 'Progress update', plan: [
          { step: 'First step', status: 'completed' }, { step: 'Second step', status: 'inProgress' },
        ] } }])
      const request = { cursor: first.cursor! }
      const change = await fixture.http(request)
      expect(await fixture.mcpPage(request)).toEqual(change)
      expect(change.items).toMatchObject([{ id: 'plan:turn', sequence: '1', entry: {
        activity: { title: 'Update plan', output: 'Progress update\n[x] First step\n[~] Second step' },
      } }])
      const expanded = { executionId: fixture.executionId, itemId: 'plan:turn' }
      expect((await fixture.http(expanded)).items).toEqual(change.items)
    } finally { await fixture.close() }
  })
})
