import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { childHistoryEvent } from '../src/modules/subagents/nativeReadback.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import Fastify from 'fastify'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { RunSubagentSchema, RunSubagentsPageSchema, RunSubagentDetailSchema,
  RunSubagentMessagesPageSchema, RunSubagentCommandReceiptSchema } from '@foreman-code/contracts/subagents'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'
import { RunSubagentService } from '../src/modules/subagents/service.js'
import { backfillRunSubagents, recoverSubagentCommands } from '../src/modules/subagents/recovery.js'
import type { SubagentControlLease } from '../src/modules/subagents/types.js'
import { registerRunSubagentRoutes } from '../src/routes/runSubagents.js'
import { registerGraphqlMcp } from '../src/mcp/unified/transport.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { DomainError } from '../src/modules/errors.js'
import { SubagentDispatchRejectedError } from '../src/modules/subagents/controlErrors.js'
import { codexChildControlFixture } from './fixtures/codex-child-control-helpers.js'
import { seedCodexChild } from './fixtures/codex-child-control-helpers.js'
import { deliveryFixture } from './fixtures/codex-delivery.js'
import { input as codexInput, until, calls } from './fixtures/codex-test-helpers.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../src/modules/interactions/runtimePorts.js'
import { productionSubagentControls } from '../src/modules/subagents/productionControls.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { NativeResponseJournal } from '../src/modules/harnesses/recovery/responseJournal.js'
import { join } from 'node:path'
import { CodexStdioTransport } from '../src/modules/harnesses/codexStdioTransport.js'

// Explicit loopback admin connection and a random OWNED schema. Never read TEST_DATABASE_URL or migrate public.
describe('durable per-Run children over SQL and authenticated MCP', () => {
  let admin: pg.Pool, pool: pg.Pool, schema: string
  beforeAll(async () => {
    const connectionString = process.env.SUBAGENT_CORE_ADMIN_DATABASE_URL ?? process.env.TEST_DATABASE_URL
    if (!connectionString || !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(connectionString).hostname)) throw new Error('An explicit loopback TEST_DATABASE_URL (or SUBAGENT_CORE_ADMIN_DATABASE_URL) is required.')
    admin = new pg.Pool({ connectionString, max: 1 })
    schema = `subagent_core_${randomUUID().replaceAll('-', '')}`
    await createFixtureSchema(admin, schema)
    pool = new pg.Pool({ connectionString, max: 8, options: `-c search_path=${schema} -c statement_timeout=10000 -c lock_timeout=5000` })
    await applyApplicationMigrations(pool)
  }, 60000)
  afterAll(async () => { await pool?.end(); if (schema) await dropFixtureSchema(admin, schema); await admin?.end() })
  async function fixture(provider: 'codex' | 'claude' = 'codex') {
    const suffix = randomUUID(), workspaceId = `w-${suffix}`, workflowId = `wf-${suffix}`, version = `v-${suffix}`, runId = `r-${suffix}`, executionId = `e-${suffix}`, agentId = `a-${suffix}`, configurationId = `cfg-${suffix}`
    await pool.query("insert into workspaces(id,record) values($1,'{}')", [workspaceId])
    await pool.query("insert into agents(id,workspace_id,record) values($1,$2,'{}')", [agentId, workspaceId])
    await pool.query("insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,'{}')", [configurationId, workspaceId, agentId])
    await pool.query("insert into workflows(id,workspace_id,record) values($1,$2,'{}')", [workflowId, workspaceId])
    const versionRecord = { id: version, workspaceId, workflowId, executionSemanticsVersion: 3, agentConfigurationVersionIds: { [agentId]: configurationId }, definition: { executionSemanticsVersion: 3, nodes: [{ id: 'node', agentId }] } }
    await pool.query("insert into workflow_versions(id,workspace_id,workflow_id,version,entry_node_id,record) values($1,$2,$3,1,'node',$4::jsonb)", [version, workspaceId, workflowId, JSON.stringify(versionRecord)])
    const runRecord = { id: runId, workspaceId, workflowId, workflowVersionId: version, executionSemanticsVersion: 3, executionState: 'running', agentConfigurationVersionIds: { [agentId]: configurationId } }
    await pool.query("insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record) values($1,$2,$3,$4,'running',$5::jsonb)", [runId, workspaceId, workflowId, version, JSON.stringify(runRecord)])
    const executionRecord = { id: executionId, runId, workflowNodeId: 'node', agentId, attempt: 1, agentConfigurationVersionId: configurationId, nativeSessionId: 'root', state: 'running', input: {} }
    await pool.query("insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,'node',$3,1,$4::jsonb)", [executionId, runId, agentId, JSON.stringify(executionRecord)])
    await pool.query('insert into execution_native_sessions(execution_id,reference) values($1,$2::jsonb)', [executionId, JSON.stringify({ harness: provider, providerVersion: provider === 'codex' ? '0.154.0' : '2.1.284', nativeSessionId: 'root' })])
    const access = new PostgresAccessService(pool)
    const issue = (actions: ManagementAction[]) => access.issue({ name: 'Child integration fixture', audience: 'operator', grants: [{ actions, scope: { workspaceIds: [workspaceId], runIds: [runId] } }], expiresAt: new Date(Date.now() + 600000) })
    const writer = await issue(['runs:read', 'runs:subagents:input', 'runs:stop', 'interactions:respond'])
    const reader = await issue(['runs:read'])
    const denied = await issue(['workspaces:read'])
    const service = new RunSubagentService(pool)
    let sequence = 0
    const event = async (type: string, payload: Record<string, unknown>, at = '2026-10-02T20:00:00.000Z') => {
      const value = { executionId, connectionId: 'connection', sequence: sequence++, type, payload, occurredAt: at }
      await appendNativeEvent(pool, value)
      return value
    }
    const discover = (id = 'child', parent = 'root') => event('item.completed', { threadId: parent, item: { type: 'subAgentActivity', id: `spawn-${id}`, agentThreadId: id, agentPath: `/root/${id}`, kind: 'started' } })
    const input = { workspaceId, runId }
    return { access, writer, reader, denied, service, input, event, discover, executionId, versionRecord, runRecord }
  }

  it.each(['questions', 'form'] as const)('continues and answers the actual Codex child %s callback through MCP', async kind => {
    const f = await fixture('codex')
    const native = await deliveryFixture()
    const journal = new NativeResponseJournal(join(native.directory, 'response-journal'))
    // Success-path MCP tests use the production RPC deadline; fault tests retain the short deadline.
    const transport = (...args: ConstructorParameters<typeof CodexStdioTransport>) => new CodexStdioTransport(...args)
    const manager = native.makeManager(undefined, { transport }, { appMcpAccess: 'scoped', responseJournal: journal })
    const source = codexInput(native.directory, f.versionRecord.definition.nodes[0]!.agentId)
    source.request.executionId = f.executionId
    source.request.runId = f.input.runId
    source.request.workspaceId = f.input.workspaceId
    source.request.workflowNodeId = 'node'
    source.request.configuration.workspaceId = f.input.workspaceId
    source.request.configuration.id = Object.values(f.versionRecord.agentConfigurationVersionIds)[0]!
    const root = await manager.createSession(source)
    await pool.query('update execution_native_sessions set reference=$2::jsonb where execution_id=$1',
      [f.executionId, JSON.stringify(root)])
    await pool.query(`update harness_executions set record=jsonb_set(record,'{nativeSessionId}',to_jsonb($2::text))
      where id=$1`, [f.executionId, root.nativeSessionId])
    await f.discover('native-child', root.nativeSessionId)
    await f.event('native.unlinked_notification', { method: 'turn/completed', params: {
      threadId: 'native-child', turn: { id: 'child-turn', status: 'completed', items: [] },
    } })
    const saved = (await f.service.list(f.reader.principal, f.input)).items[0]!.subagent
    await seedCodexChild(native.directory, root, source, { ...saved, status: 'completed' })
    await native.json('resume-delay-ms.json', 750)
    const managers = new ExecutionScopedNativeSessionManagerResolver(() => manager)
    const context = { executionId: f.executionId, runId: f.input.runId,
      agentId: source.request.configuration.agentId, harness: 'codex' as const, workingDirectory: native.directory,
      configuration: source.request.configuration, attempt: 1 }
    const resolved = managers.resolve(context, { runId: f.input.runId, assertOwned() {} } as RunOwnership)
    resolved.beginStart!()
    resolved.markResident!()
    const controls = productionSubagentControls(managers)
    const service = new RunSubagentService(pool, controls)
    const services = { commands: new PostgresCommandCoordinator(pool), runs: { subagents: service },
      workspaces: {}, workflows: {}, agents: {}, locations: {}, harnesses: {} } as unknown as OperatorServices
    const app = Fastify()
    registerOperatorHttpSecurity(app, f.access)
    registerRunSubagentRoutes(app, services)
    registerGraphqlMcp(app, { access: f.access, operator: services })
    const clients: Client[] = []
    try {
      const origin = await app.listen({ host: '127.0.0.1', port: 0 })
      const connect = async (token: string) => {
        const client = new Client({ name: 'continued-child-input', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', origin), {
          authProvider: { token: async () => token },
        }))
        return client
      }
      const writer = await connect(f.writer.token)
      const reader = await connect(f.reader.token)
      const childInput = { ...f.input, subagentId: saved.id }
      const turnId = 'turn-2'
      const callback = kind === 'questions'
        ? { method: 'item/tool/requestUserInput', params: { itemId: 'question', isBlocking: true,
          questions: [{ id: 'answer', header: 'Answer', question: 'Enter details', isOther: true,
            isSecret: false, options: null }] } }
        : { method: 'mcpServer/elicitation/request', params: { mode: 'form', serverName: 'app', message: 'Enter details',
          requestedSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] } } }
      await native.json('workflow-input.json', callback)
      const continued = await writer.callTool({ name: 'run_subagent_input_v1', arguments: {
        ...childInput, expectedRevision: saved.revision, commandId: randomUUID(), text: 'wait',
      } })
      expect(continued.isError).not.toBe(true)
      const detail = await until(async () => {
        const result = await writer.callTool({ name: 'run_subagent_get_v1', arguments: childInput })
        const value = RunSubagentDetailSchema.parse(decodeMcpToolResult(result))
        return value.pendingInteraction ? value : undefined
      })
      expect(detail.pendingInteraction!.session.nativeSessionId).toBe('native-child')
      expect(detail.availableActions.respond).toBe(true)
      const command = { ...childInput, expectedRevision: detail.subagent.revision, commandId: randomUUID(),
        nativeRequestId: detail.pendingInteraction!.turn.nativeRequestId!,
        optionId: detail.pendingInteraction!.responseOptions[0]!.optionId,
        response: kind === 'questions' ? { answer: { answers: ['Entered'] } } : { count: 2 } }
      expect((await reader.callTool({ name: 'run_subagent_respond_v1', arguments: command })).isError).toBe(true)
      const invalid = await writer.callTool({ name: 'run_subagent_respond_v1', arguments: { ...command, response: {} } })
      expect(invalid.isError).toBe(true)
      const result = await writer.callTool({ name: 'run_subagent_respond_v1', arguments: command })
      expect(result.isError).not.toBe(true)
      const receipt = RunSubagentCommandReceiptSchema.parse(decodeMcpToolResult(result))
      expect(receipt).toMatchObject({ state: 'acknowledged', nativeTurnId: turnId,
        response: { option: { response: command.response } } })
      await until(async () => journal.read(detail.pendingInteraction!.session, receipt.response!))
      await manager.shutdown()
      const replacement = native.makeManager(undefined, { transport }, { appMcpAccess: 'scoped', responseJournal: journal })
      await replacement.attachSession(root, source)
      const replacementManagers = new ExecutionScopedNativeSessionManagerResolver(() => replacement)
      const reattached = replacementManagers.resolve(context,
        { runId: f.input.runId, assertOwned() {} } as RunOwnership)
      reattached.beginStart!()
      reattached.markResident!()
      await pool.query(`update run_subagent_command_receipts set record=jsonb_set(record,'{state}','"uncertain"')
        where id=$1`, [receipt.id])
      services.runs = {
        subagents: new RunSubagentService(pool, productionSubagentControls(replacementManagers)),
      } as OperatorServices['runs']
      const replay = await writer.callTool({ name: 'run_subagent_respond_v1', arguments: command })
      const recovered = RunSubagentCommandReceiptSchema.parse(decodeMcpToolResult(replay))
      expect(recovered).toMatchObject({ id: receipt.id, state: 'acknowledged', response: receipt.response })
      const url = `/api/management/workspaces/${f.input.workspaceId}/runs/${f.input.runId}/subagents/${saved.id}/responses`
      const http = await app.inject({ method: 'POST', url, payload: command,
        headers: { host: '127.0.0.1', authorization: `Bearer ${f.writer.token}` } })
      expect(http.statusCode).toBe(200)
      expect(http.json()).toEqual(recovered)
      expect((await calls(native.directory)).filter(entry => {
        const wire = entry.wire as { id?: number; result?: unknown } | undefined
        return wire?.id === 902 && wire.result
      })).toHaveLength(1)
      expect((await pool.query('select record from run_subagent_command_receipts where id=$1', [receipt.id]))
        .rows[0].record).toEqual(recovered)
    } finally {
      await Promise.allSettled(clients.map(client => client.close()))
      await app.close()
      await native.close()
    }
  }, 60_000)
  it('joins late and nested children, paginates, and replays after a new service instance without duplication', async () => {
    const f = await fixture()
    await f.event('native.unlinked_notification', { threadId: 'child', method: 'item/completed', params: { threadId: 'child', turnId: 't', item: { type: 'agentMessage', id: 'm', text: 'CHILD ONLY' } } })
    await f.discover(); await f.discover('other'); await f.discover('nested', 'child')
    const page = await f.service.list(f.reader.principal, { ...f.input, limit: 2 })
    expect(page.items).toHaveLength(2); expect(page.nextCursor).not.toBeNull()
    expect((await f.service.list(f.reader.principal, { ...f.input, limit: 2, cursor: page.nextCursor! })).items).toHaveLength(1)
    const all = await new RunSubagentService(pool).list(f.reader.principal, f.input)
    expect(all.items).toHaveLength(3)
    const child = all.items.find(item => item.subagent.native.childSessionId === 'child')!.subagent
    expect(all.items.find(item => item.subagent.native.childSessionId === 'nested')!.subagent.parentSubagentId).toBe(child.id)
    const messages = await f.service.messages(f.reader.principal, { ...f.input, subagentId: child.id })
    expect(messages.items).toMatchObject([{ text: 'CHILD ONLY', role: 'assistant' }])
    expect((await pool.query('select record from workflow_versions where id=$1', [child.workflowVersionId])).rows[0].record).toEqual(f.versionRecord)
    expect((await pool.query('select record from runs where id=$1', [child.runId])).rows[0].record).toEqual(f.runRecord)
    expect((await f.service.list(f.reader.principal, f.input)).items.map(item => item.subagent.revision)).toEqual(all.items.map(item => item.subagent.revision))
  })
  it('keeps tool output, transcript truncation and final lifecycle through replay and scopes every cursor', async () => {
    const f = await fixture(); await f.discover()
    await f.event('native.unlinked_notification', { method: 'item/completed', params: { threadId: 'child', item: { type: 'commandExecution', id: 'tool', command: 'read sentinel', status: 'completed', aggregatedOutput: 'TOOL_OK', durationMs: 25 } } })
    for (const [id, text] of [['m1', 'x'.repeat(25000)], ['m2', 'SECOND']]) await f.event('native.unlinked_notification', { method: 'item/completed', params: { threadId: 'child', item: { type: 'agentMessage', id, text } } })
    await f.event('native.unlinked_notification', { method: 'turn/completed', params: { threadId: 'child', turn: { id: 't1', status: 'completed', items: [] } } }, '2026-10-02T20:01:00.000Z')
    const child = (await f.service.list(f.reader.principal, f.input)).items[0]!.subagent
    expect(child.status).toBe('completed'); expect(child.finishedAt).not.toBeNull()
    const first = await f.service.messages(f.reader.principal, { ...f.input, subagentId: child.id, limit: 1 })
    expect(first.items[0]!.truncation).toEqual({ truncated: true, originalBytes: 25000 })
    expect(first.coverage).toMatchObject({ transcript: 'partial', gaps: true })
    expect((await f.service.messages(f.reader.principal, { ...f.input, subagentId: child.id, cursor: first.nextCursor!, limit: 1 })).items[0]!.text).toBe('SECOND')
    expect((await f.service.tools(f.reader.principal, { ...f.input, subagentId: child.id })).items).toMatchObject([{ output: 'TOOL_OK', durationMs: 25 }])
    await expect(f.service.tools(f.reader.principal, { ...f.input, subagentId: child.id, cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'SUBAGENT_CURSOR_INVALID' })
    await f.event('native.unlinked_notification', { method: 'turn/started', params: { threadId: 'child', turn: { id: 't0', status: 'inProgress', items: [] } } }, '2026-10-02T19:59:00.000Z')
    expect((await f.service.get(f.reader.principal, { ...f.input, subagentId: child.id })).subagent.status).toBe('completed')
    await f.event('native.unlinked_notification', { method: 'turn/started', params: { threadId: 'child', turn: { id: 't2', status: 'inProgress', items: [] } } }, '2026-10-02T20:02:00.000Z')
    expect((await f.service.get(f.reader.principal, { ...f.input, subagentId: child.id })).subagent).toMatchObject({ status: 'running', finishedAt: null, native: { currentTurnId: 't2' } })
    expect((await pool.query('select count(*)::int as count from run_subagent_lifecycle where subagent_id=$1', [child.id])).rows[0].count).toBe(4)
  })
  it('keeps disconnected children reconciling until fresh lifecycle evidence and retains terminal children', async () => {
    const f = await fixture(); await f.discover(); await f.discover('finished')
    await f.event('native.unlinked_notification', { method: 'turn/completed', params: { threadId: 'finished', turn: { id: 't', status: 'completed', items: [] } } })
    await f.event('transport.disconnected', {})
    const children = (await f.service.list(f.reader.principal, f.input)).items
    expect(children.find(item => item.subagent.native.childSessionId === 'child')!.subagent).toMatchObject({ status: 'unknown', evidence: 'reconciling' })
    expect(children.find(item => item.subagent.native.childSessionId === 'finished')!.subagent.status).toBe('completed')
    await f.event('native.unlinked_notification', { method: 'turn/started', params: { threadId: 'child', turn: { id: 'fresh', status: 'inProgress', items: [] } } }, '2026-10-02T20:02:00.000Z')
    expect((await f.service.list(f.reader.principal, f.input)).items.find(item => item.subagent.native.childSessionId === 'child')!.subagent).toMatchObject({ status: 'running', evidence: 'confirmed' })
  })

  it('quarantines Claude hook-only identity, verifies nesting and enriches native aliases before linking child messages/tools', async () => {
    const f = await fixture('claude')
    await f.event('claude.subagent', { nativeSessionId: 'root', agentId: 'outer', status: 'running' })
    expect((await f.service.list(f.reader.principal, f.input)).items).toEqual([])
    await f.event('claude.subagent', { nativeSessionId: 'root', agentId: 'inner', parentAgentId: 'outer', ancestry: 'verified', status: 'unknown', spawnToolUseId: 'spawn-inner', taskId: 'task-inner' })
    await f.event('claude.subagent', { nativeSessionId: 'root', agentId: 'outer', ancestry: 'verified', status: 'unknown' })
    await f.event('claude.text', { nativeSessionId: 'root', parentToolUseId: 'spawn-outer', itemId: 'text-user', messageId: 'user-message', role: 'user', operation: 'replace', text: 'CHILD USER', final: true })
    await f.event('claude.subagent', { nativeSessionId: 'root', agentId: 'outer', ancestry: 'verified', status: 'unknown', spawnToolUseId: 'spawn-outer', taskId: 'task-outer' })
    await f.event('claude.subagent', { nativeSessionId: 'root', agentId: 'inner', status: 'running' })
    await f.event('claude.subagent', { nativeSessionId: 'root', agentId: 'inner', parentAgentId: 'outer', ancestry: 'verified', status: 'unknown', spawnToolUseId: 'spawn-inner', taskId: 'task-inner' })
    await f.event('claude.tool', { nativeSessionId: 'root', agentId: 'inner', toolUseId: 'read', name: 'Read', input: { file_path: 'sentinel', OPENAI_API_KEY: 'secret' }, status: 'running' })
    await f.event('claude.tool', { nativeSessionId: 'root', agentId: 'inner', toolUseId: 'read', name: 'Read', output: 'OK', status: 'completed' })
    await f.event('claude.task', { nativeSessionId: 'root', taskId: 'task-inner', status: 'completed' })
    const all = (await f.service.list(f.reader.principal, f.input)).items
    const outer = all.find(item => item.subagent.native.agentId === 'outer')!.subagent
    const inner = all.find(item => item.subagent.native.agentId === 'inner')!.subagent
    expect(inner).toMatchObject({ parentSubagentId: outer.id, status: 'completed', native: { taskId: 'task-inner' } })
    expect((await f.service.messages(f.reader.principal, { ...f.input, subagentId: outer.id })).items).toMatchObject([{ role: 'user', text: 'CHILD USER' }])
    expect((await f.service.tools(f.reader.principal, { ...f.input, subagentId: inner.id })).items).toMatchObject([{ input: { OPENAI_API_KEY: '[redacted]' }, output: 'OK' }])
    expect(inner.capabilities.toolCalls.qualification).toBe('unverified')
  })
  it('keeps the same provider-native child identity distinct across technical execution attempts', async () => {
    const f = await fixture(); await f.discover()
    const first = (await f.service.list(f.reader.principal, f.input)).items[0]!.subagent
    const executionId = randomUUID()
    const old = (await pool.query('select * from harness_executions where id=$1', [f.executionId])).rows[0]
    await pool.query('insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record) values($1,$2,$3,$4,2,$5::jsonb)',
      [executionId, old.run_id, old.workflow_node_id, old.agent_id, JSON.stringify({ ...old.record, id: executionId, attempt: 2 })])
    await pool.query('insert into execution_native_sessions(execution_id,reference) select $1,reference from execution_native_sessions where execution_id=$2', [executionId, f.executionId])
    await appendNativeEvent(pool, { executionId, sequence: 0, connectionId: 'connection', type: 'item.completed', occurredAt: '2026-10-02T20:00:00.000Z', payload: { threadId: 'root', item: { type: 'subAgentActivity', id: 'spawn', kind: 'started', agentThreadId: 'child' } } })
    const all = (await f.service.list(f.reader.principal, f.input)).items
    expect(all).toHaveLength(2); expect(all[0]!.subagent.id).not.toBe(all[1]!.subagent.id)
    expect(all.find(item => item.subagent.id !== first.id)!.subagent.parentAttemptKey).toBe(`${executionId}:2`)
  })
  async function qualifiedFixture() {
    const f = await fixture('codex')
    await f.discover()
    const child = (await f.service.list(f.writer.principal, f.input)).items[0]!.subagent
    // Synthetic native qualification fixture tests the command protocol; it is never app/provider qualification evidence.
    child.status = 'waiting'; child.capabilities.sendInput = { support: 'supported', qualification: 'passed' }
    child.capabilities.interrupt = { support: 'supported', qualification: 'passed' }
    await pool.query('update run_subagents set record=$2::jsonb where id=$1', [child.id, JSON.stringify(child)])
    const send = vi.fn(async () => {}), interrupt = vi.fn(async () => {})
    const lease: SubagentControlLease = { generation: 'lease-1', nativeTurnId: null, matches: value => value.id === child.id && value.profile.harnessInstanceId === child.profile.harnessInstanceId,
      assertCurrent: () => {}, sendInput: send, interrupt, capabilities: {
        sendInput: child.capabilities.sendInput, interrupt: child.capabilities.interrupt,
        executionResume: child.capabilities.executionResume, inputTiming: child.capabilities.inputTiming,
      } }
    const service = new RunSubagentService(pool, () => lease)
    const command = { ...f.input, subagentId: child.id, commandId: randomUUID(), expectedRevision: child.revision, text: 'follow up' }
    return { ...f, service, child, send, interrupt, lease, command }
  }
  it.each([false, true])('refreshes newer child capability readback only with a verified current contract: %s', async verified => {
    const f = await qualifiedFixture()
    f.child.profile.providerVersion = '2.0.0'
    f.child.capabilities.sendInput = { support: 'supported', qualification: 'unverified' }
    await pool.query('update run_subagents set record=$2::jsonb where id=$1', [f.child.id, JSON.stringify(f.child)])
    f.lease.capabilities = {
      sendInput: { support: 'supported', qualification: verified ? 'passed' : 'unverified' },
      interrupt: f.child.capabilities.interrupt, executionResume: f.child.capabilities.executionResume,
      inputTiming: f.child.capabilities.inputTiming,
    }
    const input = { ...f.input, subagentId: f.child.id }
    const first = await f.service.get(f.writer.principal, input)
    expect(first.subagent.profile.providerVersion).toBe('2.0.0')
    expect(first.subagent.capabilities.sendInput.qualification).toBe(verified ? 'passed' : 'unverified')
    expect(first.availableActions.sendInput).toBe(verified)
    expect((await f.service.get(f.reader.principal, input)).availableActions.sendInput).toBe(false)
    expect((await f.service.get(f.writer.principal, input)).subagent.revision).toBe(first.subagent.revision)
    expect((await pool.query('select record from workflow_versions where id=$1', [f.child.workflowVersionId])).rows[0].record)
      .toEqual(f.versionRecord)
    expect((await pool.query('select record from runs where id=$1', [f.child.runId])).rows[0].record).toEqual(f.runRecord)
  })
  it('stores one idempotent receipt, checks current grants on retry, and binds changed input to conflict', async () => {
    const f = await qualifiedFixture()
    const [a, b] = await Promise.all([f.service.input(f.writer.principal, 'mcp', f.command), f.service.input(f.writer.principal, 'mcp', f.command)])
    expect(a.id).toBe(b.id); expect(f.send).toHaveBeenCalledTimes(1)
    const retry = await f.service.input(f.writer.principal, 'http', f.command)
    expect(retry.state).toBe('acknowledged'); expect(retry.id).toBe(a.id)
    await expect(f.service.input(f.writer.principal, 'mcp', { ...f.command, text: 'different' })).rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    await pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.writer.principal.id, JSON.stringify(f.reader.principal.grants)])
    await expect(f.service.input(f.writer.principal, 'mcp', f.command)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('does not hold Run SQL locks while the native dispatch callback records evidence', async () => {
    const f = await qualifiedFixture()
    f.send.mockImplementationOnce(async () => {
      const sql = await pool.connect()
      try { await sql.query('begin'); await sql.query('select id from runs where id=$1 for update', [f.input.runId]); await sql.query('commit') }
      finally { sql.release() }
    })
    expect((await f.service.input(f.writer.principal, 'mcp', f.command)).state).toBe('acknowledged')
  }, 15000)
  it('retains uncertain delivery and recovers pre-crash dispatch receipts without resubmission', async () => {
    const f = await qualifiedFixture(); f.send.mockRejectedValueOnce(new Error('lost native response'))
    const receipt = await f.service.input(f.writer.principal, 'mcp', f.command)
    expect(receipt.state).toBe('uncertain')
    expect(await f.service.input(f.writer.principal, 'mcp', f.command)).toEqual(receipt)
    await pool.query("update run_subagent_command_receipts set record=jsonb_set(record,'{state}','\"dispatching\"') where id=$1", [receipt.id])
    expect(await recoverSubagentCommands(pool)).toBe(1)
    const readback = await new RunSubagentService(pool).input(f.writer.principal, 'mcp', f.command)
    expect(readback).toMatchObject({ id: receipt.id, state: 'uncertain', reasonCode: 'MAIN_RESTART_DELIVERY_UNCERTAIN' })
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('ACKs interrupt without changing lifecycle and respects the Run stop fence', async () => {
    const f = await qualifiedFixture(); f.child.status = 'running'
    await pool.query('update run_subagents set record=$2::jsonb where id=$1', [f.child.id, JSON.stringify(f.child)])
    const input = { ...f.input, subagentId: f.child.id, commandId: f.command.commandId, expectedRevision: f.command.expectedRevision }
    expect((await f.service.interrupt(f.writer.principal, 'mcp', input)).state).toBe('acknowledged')
    expect(f.interrupt).toHaveBeenCalledTimes(1)
    expect((await f.service.get(f.reader.principal, { ...f.input, subagentId: f.child.id })).subagent.status).toBe('running')
    await pool.query('update runs set stop_requested_at=clock_timestamp() where id=$1', [f.input.runId])
    await expect(f.service.interrupt(f.writer.principal, 'http', { ...input, commandId: randomUUID() })).rejects.toMatchObject({ code: 'RUN_STOPPED' })
  })
  it('rechecks uncertain delivery using exact readback without resending or holding the Run transaction', async () => {
    const f = await qualifiedFixture()
    f.send.mockRejectedValueOnce(new Error('lost ACK'))
    const first = await f.service.input(f.writer.principal, 'http', f.command)
    expect(first.state).toBe('uncertain')
    const reconcile = vi.fn(async () => {
      // This second scoped connection needs the same advisory lock. It must
      // not deadlock behind a transaction held over native IO.
      await f.service.get(f.reader.principal, { ...f.input, subagentId: f.child.id })
      return 'acknowledged' as const
    })
    f.lease.reconcile = reconcile
    const retry = await f.service.input(f.writer.principal, 'mcp', f.command)
    expect(retry).toMatchObject({ id: first.id, state: 'acknowledged' })
    expect(retry.reasonCode).toBeUndefined()
    expect(reconcile).toHaveBeenCalledExactlyOnceWith(first)
    expect(f.send).toHaveBeenCalledTimes(1)
    expect((await f.service.input(f.writer.principal, 'http', f.command)).state).toBe('acknowledged')
    expect(reconcile).toHaveBeenCalledTimes(1)
  })
  it('does not accept readback from a replacement control generation', async () => {
    const f = await qualifiedFixture()
    f.send.mockRejectedValueOnce(new Error('lost ACK'))
    const first = await f.service.input(f.writer.principal, 'http', f.command)
    f.lease.reconcile = async () => { f.lease.generation = 'replacement'; return 'acknowledged' }
    expect((await f.service.input(f.writer.principal, 'mcp', f.command)).state).toBe('uncertain')
    expect(f.send).toHaveBeenCalledTimes(1)
    expect(first.state).toBe('uncertain')
  })
  it('persists definite native refusal as rejected and never retries it', async () => {
    const f = await qualifiedFixture()
    f.send.mockRejectedValueOnce(new SubagentDispatchRejectedError())
    const first = await f.service.input(f.writer.principal, 'http', f.command)
    expect(first).toMatchObject({ state: 'rejected', reasonCode: 'SUBAGENT_NATIVE_REJECTED' })
    expect(await f.service.input(f.writer.principal, 'mcp', f.command)).toEqual(first)
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('rechecks authorization even when native receipt readback fails', async () => {
    const f = await qualifiedFixture()
    f.send.mockRejectedValueOnce(new Error('lost ACK'))
    await f.service.input(f.writer.principal, 'http', f.command)
    f.lease.reconcile = async () => {
      await pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.writer.principal.id,
        JSON.stringify([{ actions: ['runs:read'], scope: { runIds: [f.input.runId] } }])])
      throw new Error('native readback disconnected')
    }
    await expect(f.service.input(f.writer.principal, 'mcp', f.command)).rejects.toMatchObject({ status: 403 })
    expect(f.send).toHaveBeenCalledTimes(1)
  })
  it('rejects cross-Run/workspace ownership and conflicting source identities', async () => {
    const f = await fixture(); const original = await f.discover()
    const child = (await f.service.list(f.reader.principal, f.input)).items[0]!.subagent
    await expect(f.service.get(f.reader.principal, { ...f.input, runId: 'foreign', subagentId: child.id })).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    await expect(f.service.get(f.reader.principal, { ...f.input, workspaceId: 'foreign', subagentId: child.id })).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' })
    const other = await fixture()
    await expect(other.service.get(other.reader.principal, { ...other.input, subagentId: child.id })).rejects.toMatchObject({ code: 'SUBAGENT_NOT_FOUND' })
    await expect(appendNativeEvent(pool, { ...original, payload: { changed: true } })).rejects.toMatchObject({ code: 'NATIVE_EVENT_IDENTITY_CONFLICT' })
    await f.event('item.completed', { threadId: 'root', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['child'] } })
    await expect(f.service.list(f.reader.principal, f.input)).rejects.toMatchObject({ code: 'SUBAGENT_SOURCE_CONFLICT' })
  })
  it('commits native backfill cursor with its received events and reads through a fresh pool after reconnect', async () => {
    const f = await fixture()
    const read = vi.fn(async (executionId: string, session: { nativeSessionId: string }, cursor: string | undefined) => {
      expect(executionId).toBe(f.executionId); expect(session.nativeSessionId).toBe('root')
      return cursor === undefined ? { events: [childHistoryEvent('item.completed', { threadId: 'root', item: { type: 'subAgentActivity', id: 'history-spawn', kind: 'started', agentThreadId: 'history-child', agentPath: '/root/history' } })], nextCursor: 'child-page' }
        : { events: [childHistoryEvent('native.unlinked_notification', { method: 'item/completed', params: { threadId: 'history-child', item: { type: 'agentMessage', id: 'history-message', text: 'RECOVERED HISTORY' } } })], nextCursor: null }
    })
    const recovering = new RunSubagentService(pool, undefined, read)
    await backfillRunSubagents(recovering, f.reader.principal, f.input)
    expect((await pool.query('select child_cursor,complete from run_subagent_backfill_state where execution_id=$1', [f.executionId])).rows[0]).toEqual({ child_cursor: 'child-page', complete: false })
    await backfillRunSubagents(recovering, f.reader.principal, f.input)
    const freshPool = new pg.Pool({ ...pool.options, max: 2 })
    try {
      const reader = new RunSubagentService(freshPool)
      const children = await reader.list(f.reader.principal, f.input)
      const child = children.items[0]!.subagent
      expect((await reader.messages(f.reader.principal, { ...f.input, subagentId: child.id })).items).toMatchObject([{ text: 'RECOVERED HISTORY' }])
      await backfillRunSubagents(recovering, f.reader.principal, f.input)
      expect(read).toHaveBeenCalledTimes(2)
      expect((await pool.query('select count(*)::int as count from harness_native_events where execution_id=$1', [f.executionId])).rows[0].count).toBe(2)
    } finally { await freshPool.end() }
  })
  it('retries an unavailable native child readback each minute while the Run is live and hourly once it finished', async () => {
    const f = await fixture()
    const read = vi.fn(async () => { throw new Error('native session gone') })
    const recovering = new RunSubagentService(pool, undefined, read)
    const age = (interval: string) => pool.query(`update run_subagent_backfill_state set updated_at=clock_timestamp()-$2::interval where execution_id=$1`, [f.executionId, interval])
    await backfillRunSubagents(recovering, f.reader.principal, f.input)
    await backfillRunSubagents(recovering, f.reader.principal, f.input)
    expect(read).toHaveBeenCalledTimes(1)
    await age('2 minutes')
    await backfillRunSubagents(recovering, f.reader.principal, f.input)
    expect(read).toHaveBeenCalledTimes(2)
    await pool.query(`update runs set execution_state='completed', record=record || jsonb_build_object('executionState','completed',
      'outcome','failed','result',jsonb_build_object('outcome','failed'),'finishedAt',to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      where id=$1`, [f.input.runId])
    await age('2 minutes')
    await backfillRunSubagents(recovering, f.reader.principal, f.input)
    expect(read).toHaveBeenCalledTimes(2)
    await age('2 hours')
    await backfillRunSubagents(recovering, f.reader.principal, f.input)
    expect(read).toHaveBeenCalledTimes(3)
  })
  it.each(['codex-multi-agent-v2', 'codex-collab'] as const)('controls the owned %s child through HTTP and MCP with persisted receipts', async nativeMode => {
    const f = await fixture('codex')
    if (nativeMode === 'codex-multi-agent-v2') await f.discover()
    else await f.event('item.completed', { threadId: 'root', item: {
      type: 'collabAgentToolCall', id: 'spawn-child', tool: 'spawnAgent', receiverThreadIds: ['child'],
    } })
    await f.event('native.unlinked_notification', { method: 'turn/started', params: {
      threadId: 'child', turn: { id: 'child-turn', status: 'inProgress', items: [] },
    } })
    await f.event('native.unlinked_notification', { method: 'item/completed', params: {
      threadId: 'child', turnId: 'child-turn', item: { type: 'agentMessage', id: 'answer', text: 'Readable child history' },
    } })
    const child = (await f.service.list(f.reader.principal, f.input)).items[0]!.subagent
    // Saved flags alone do not qualify native operations.
    const saved = { ...child, capabilities: { ...child.capabilities, inputTiming: 'active-and-idle',
      sendInput: { support: 'supported', qualification: 'passed' },
      interrupt: { support: 'supported', qualification: 'passed' },
      executionResume: { support: 'supported', qualification: 'passed' },
    } }
    await pool.query('update run_subagents set record=$2::jsonb where id=$1', [child.id, JSON.stringify(saved)])
    await expect(f.service.input(f.writer.principal, 'mcp', { ...f.input, subagentId: child.id,
      commandId: randomUUID(), expectedRevision: child.revision, text: 'No resident owner' }))
      .rejects.toMatchObject({ code: 'SUBAGENT_CONTROL_UNAVAILABLE' })
    const native = codexChildControlFixture(child)
    const controls = (value: typeof child) => native.controller.lease(value, native.host, native.host.assertCurrent)
    const service = new RunSubagentService(pool, controls)
    const services = { commands: new PostgresCommandCoordinator(pool), runs: { subagents: service },
      workspaces: {}, workflows: {}, agents: {}, locations: {}, harnesses: {} } as unknown as OperatorServices
    const app = Fastify()
    app.setErrorHandler((error, _request, reply) => {
      const domain = error instanceof DomainError ? error : new DomainError('INTERNAL_ERROR', 'Request failed.', 500)
      reply.code(domain.status).send({ error: { code: domain.code, message: domain.message } })
    })
    registerOperatorHttpSecurity(app, f.access)
    registerRunSubagentRoutes(app, services)
    registerGraphqlMcp(app, { access: f.access, operator: services })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const clients: Client[] = []
    const connect = async (token: string) => {
      const client = new Client({ name: 'codex-child-history', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        authProvider: { token: async () => token },
      }))
      return client
    }
    const childInput = { ...f.input, subagentId: child.id }
    const base = `/api/management/workspaces/${f.input.workspaceId}/runs/${f.input.runId}/subagents/${child.id}`
    const headers = { host: '127.0.0.1', authorization: `Bearer ${f.writer.token}` }
    try {
      const allowed = await connect(f.writer.token)
      const reader = await connect(f.reader.token)
      const wrongScope = await f.access.issue({ name: 'Other Run child controller', audience: 'operator',
        grants: [{ actions: ['runs:read', 'runs:subagents:input', 'runs:stop'], scope: { runIds: ['different-run'] } }],
        expiresAt: new Date(Date.now() + 600000) })
      const foreign = await connect(wrongScope.token)
      for (const operation of ['input', 'interrupt'] as const) {
        const name = operation === 'input' ? 'run_subagent_input_v1' : 'run_subagent_interrupt_v1'
        const command = { ...childInput, commandId: randomUUID(), expectedRevision: child.revision,
          ...(operation === 'input' ? { text: 'follow up' } : {}) }
        for (let attempt = 0; attempt < 2; attempt++) {
          const http = await app.inject({ method: 'POST', url: `${base}/${operation}`, payload: command, headers })
          expect(http.statusCode).toBe(200)
          const receipt = RunSubagentCommandReceiptSchema.parse(http.json())
          expect(receipt).toMatchObject({ subagentId: child.id, state: 'acknowledged', nativeTurnId: 'child-turn' })
          const mcp = await allowed.callTool({ name, arguments: command })
          expect(mcp.isError).not.toBe(true)
          expect(RunSubagentCommandReceiptSchema.parse(decodeMcpToolResult(mcp))).toEqual(receipt)
        }
        const deniedHttp = await app.inject({ method: 'POST', url: `${base}/${operation}`, payload: command,
          headers: { ...headers, authorization: `Bearer ${f.reader.token}` } })
        expect(deniedHttp.statusCode).toBe(403)
        expect(deniedHttp.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
        expect((await reader.callTool({ name, arguments: command })).isError).toBe(true)
        expect((await foreign.callTool({ name, arguments: command })).isError).toBe(true)
      }
      const detail = RunSubagentDetailSchema.parse((await app.inject({ method: 'GET', url: base, headers })).json())
      const listed = RunSubagentsPageSchema.parse(decodeMcpToolResult((await reader.callTool({
        name: 'run_subagents_list_v1', arguments: f.input,
      })))).items[0]!
      for (const record of [detail, listed]) {
        expect(record.availableActions).toEqual({ sendInput: record === detail, interrupt: record === detail,
          blockedReason: record === detail ? null : 'SUBAGENT_ACTION_NOT_PERMITTED' })
        expect(record.subagent).toMatchObject({ id: child.id, revision: child.revision, native: child.native })
        for (const action of ['sendInput', 'interrupt', 'executionResume'] as const) {
          expect(record.subagent.capabilities[action]).toEqual({ support: 'supported', qualification: 'passed' })
        }
        expect(record.subagent.capabilities.inputTiming).toBe('active-and-idle')
      }
      expect(RunSubagentMessagesPageSchema.parse((await app.inject({
        method: 'GET', url: `${base}/messages`, headers,
      })).json()).items).toMatchObject([{ text: 'Readable child history' }])
      expect(RunSubagentMessagesPageSchema.parse(decodeMcpToolResult((await reader.callTool({
        name: 'run_subagent_messages_list_v1', arguments: childInput,
      })))).items).toMatchObject([{ text: 'Readable child history' }])
      expect((await pool.query('select record from run_subagents where id=$1', [child.id])).rows[0].record).toEqual(saved)
      expect((await pool.query('select count(*)::int as count from run_subagent_command_receipts where subagent_id=$1',
        [child.id])).rows[0].count).toBe(2)
      expect(native.calls.filter(call => ['turn/steer', 'turn/interrupt'].includes(call.method))).toHaveLength(2)
      expect(native.calls.every(call => call.params.threadId === child.native.childSessionId)).toBe(true)
      const receiptRow = (await pool.query('select record from run_subagent_command_receipts where subagent_id=$1 and operation=$2',
        [child.id, 'run_subagent_input_v1'])).rows[0].record
      await pool.query("update run_subagent_command_receipts set record=jsonb_set(record,'{state}','\"dispatching\"') where id=$1",
        [receiptRow.id])
      await recoverSubagentCommands(pool)
      const recovered = new RunSubagentService(pool, controls)
      const inputCommand = { ...childInput, commandId: receiptRow.commandId, expectedRevision: receiptRow.expectedRevision, text: 'follow up' }
      expect(await recovered.input(f.writer.principal, 'mcp', inputCommand)).toMatchObject({ id: receiptRow.id, state: 'acknowledged' })
      expect(native.calls.filter(call => call.method === 'turn/steer')).toHaveLength(1)
    } finally {
      for (const client of clients) await client.close()
      await app.close()
    }
  }, 30000)
  it('serves authenticated MCP/HTTP reads and commands with denied caller audit and persisted readback', async () => {
    const f = await qualifiedFixture()
    const commands = new PostgresCommandCoordinator(pool)
    const services = { commands, runs: { subagents: f.service }, workspaces: {}, workflows: {}, agents: {}, locations: {}, harnesses: {} } as unknown as OperatorServices
    const app = Fastify()
    app.setErrorHandler((error, _request, reply) => {
      const domain = error instanceof DomainError ? error : new DomainError('INTERNAL_ERROR', 'Request failed.', 500)
      reply.code(domain.status).send({ error: { code: domain.code, message: domain.message } })
    })
    registerOperatorHttpSecurity(app, f.access)
    registerRunSubagentRoutes(app, services)
    registerGraphqlMcp(app, { access: f.access, operator: services })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const clients: Client[] = []
    const connect = async (token: string) => { const client = new Client({ name: 'subagent-core', version: '1' }); clients.push(client); await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } })); return client }
    try {
      const allowed = await connect(f.writer.token), reader = await connect(f.reader.token), denied = await connect(f.denied.token)
      expect((await reader.listTools()).tools.map(tool => tool.name)).toContain('run_subagents_list_v1')
      expect((await reader.listTools()).tools.map(tool => tool.name)).not.toContain('run_subagent_input_v1')
      const deniedWrite = await reader.callTool({ name: 'run_subagent_input_v1', arguments: f.command })
      expect(deniedWrite.isError).toBe(true)
      expect((await denied.callTool({ name: 'run_subagents_list_v1', arguments: f.input })).isError).toBe(true)
      const listed = RunSubagentsPageSchema.parse(decodeMcpToolResult((await reader.callTool({ name: 'run_subagents_list_v1', arguments: f.input }))))
      expect(listed.items[0]!.subagent.id).toBe(f.child.id)
      const receipt = RunSubagentCommandReceiptSchema.parse(decodeMcpToolResult((await allowed.callTool({ name: 'run_subagent_input_v1', arguments: f.command }))))
      expect(receipt.state).toBe('acknowledged')
      const persisted = RunSubagentCommandReceiptSchema.parse((await pool.query('select record from run_subagent_command_receipts where id=$1', [receipt.id])).rows[0].record)
      expect(persisted).toEqual(receipt)
      const http = await app.inject({ method: 'GET', url: `/api/management/workspaces/${f.input.workspaceId}/runs/${f.input.runId}/subagents`, headers: { host: '127.0.0.1', authorization: `Bearer ${f.reader.token}` } })
      expect(http.statusCode).toBe(200); expect(RunSubagentsPageSchema.parse(http.json()).items[0]!.subagent.id).toBe(f.child.id)
      const httpRetry = await app.inject({ method: 'POST', url: `/api/management/workspaces/${f.input.workspaceId}/runs/${f.input.runId}/subagents/${f.child.id}/input`, payload: f.command, headers: { host: '127.0.0.1', authorization: `Bearer ${f.writer.token}` } })
      expect(httpRetry.statusCode).toBe(200); expect(httpRetry.json()).toEqual(receipt); expect(f.send).toHaveBeenCalledTimes(1)
      const deniedAudit = await pool.query('select count(*)::int as count from management_audit where principal_id=$1 and outcome=\'denied\'', [f.reader.principal.id])
      expect(deniedAudit.rows[0].count).toBeGreaterThanOrEqual(1)
      expect(RunSubagentSchema.parse((await f.service.get(f.reader.principal, { ...f.input, subagentId: f.child.id })).subagent).id).toBe(f.child.id)
      expect(RunSubagentMessagesPageSchema.parse(decodeMcpToolResult((await reader.callTool({ name: 'run_subagent_messages_list_v1', arguments: { ...f.input, subagentId: f.child.id } })))).items).toEqual([])
    } finally { for (const client of clients) await client.close(); await app.close() }
  }, 30000)
})
