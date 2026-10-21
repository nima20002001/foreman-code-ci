import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { RespondToInteractionResponseSchema } from '@foreman-code/contracts'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { CanonicalRunGraphCurrentSchema, CANONICAL_RUN_GRAPH_MCP_TOOLS,
  CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveInputSchema,
  CurrentWorkflowSaveResultSchema, makeCurrentWorkflowFixture, parseWorkHandoffResult } from '@foreman-code/contracts/wave25'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { buildApp } from '../src/app.js'
import { OperatorInteractionService } from '../src/modules/interactions/operator.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { definitionUrl } from './helpers/eng07SaveAdmission.testSupport.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'

async function saveApp(f: Pick<Awaited<ReturnType<typeof codexApprovalRuntime>>, 'db' | 'access' | 'service' | 'f'>) {
  const commands = new PostgresCommandCoordinator(f.db.pool)
  const app = buildApp({
    readiness: {
      database: { ping: async () => { await f.db.pool.query('select 1') } },
      checkpoints: { ping: async () => undefined },
    },
    operator: { access: f.access, services: {
      commands, interactions: new OperatorInteractionService(f.service),
      workflows: new WorkflowManagementService(f.db.pool, commands),
      runGraph: new RunGraphReadService(f.db.pool, { qualifiedReads: true }),
    } as unknown as OperatorServices },
  })
  try {
    await app.ready()
    const caller = await f.access.issue({ name: 'Workflow owner', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{
        actions: ManagementActionSchema.options, scope: { workspaceIds: [f.f.scope.workspaceId] },
      }] })
    const rpc = (name: string, args: Record<string, unknown>, token = caller.token) =>
      graphRpc(app, token, 'tools/call', { name, arguments: args })
    const call = async (name: string, args: Record<string, unknown>) => {
      const reply = await rpc(name, args)
      expect(reply.result?.isError, JSON.stringify(reply)).not.toBe(true)
      return graphRpcValue(reply.result)
    }
    return { app, caller, rpc, call }
  } catch (error) {
    await app.close()
    throw error
  }
}

async function saveInput(f: Pick<Awaited<ReturnType<typeof codexApprovalRuntime>>, 'f'>,
  call: Awaited<ReturnType<typeof saveApp>>['call']) {
  const saved = CurrentWorkflowReadResultSchema.parse(await call(CURRENT_WORKFLOW_TOOLS.saved, {
    workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId,
  }))
  const graph = structuredClone(saved.version.definition)
  agentWorkflowNode(graph.nodes[0]).initialPrompt += ' / edited after the Run'
  return CurrentWorkflowSaveInputSchema.parse({
    workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId, commandId: randomUUID(),
    executionSemanticsVersion: 3, expectedRevision: saved.revision,
    expectedWorkflowVersionId: saved.version.id,
    expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds, graph,
  })
}

it.skipIf(!postgresEnabled)('allows workflow saves after an owner finishes a Run with remaining findings', async () => {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  fixture.version.definition.handoffs = { contractVersion: 1 }
  fixture.version.definition.executionPolicy = { maxParallelism: 1, maxNodeExecutions: 1 }
  const output = { routing: { kind: 'finish' }, data: { latestDeliverable: { revision: 1 },
    remainingFindings: ['The owner still needs to review the result'] } }
  const f = await codexApprovalRuntime('user', { fixture, workflowOutput: async () => JSON.stringify(output) })
  let transport: Awaited<ReturnType<typeof saveApp>> | undefined
  try {
    transport = await saveApp(f)
    const { app, caller, call, rpc } = transport
    await f.engine.start(f.f.run.id)
    const [interaction] = await f.pending()
    expect(interaction).toMatchObject({ kind: 'work_direction', status: 'pending' })
    if (!interaction) throw new Error('Expected a direction interaction')
    for (const engine of [f.engine, f.compose().engine]) {
      const drives = vi.spyOn(engine, 'start')
      const errors: unknown[] = []
      try {
        for (let cycle = 0; cycle < 4; cycle++) {
          await engine.reconcile(error => errors.push(error))
          await Promise.all(drives.mock.results.map(result => result.value))
        }
        expect(errors).toEqual([])
        expect(drives).not.toHaveBeenCalled()
      } finally {
        drives.mockRestore()
      }
    }
    await f.engine.start(f.f.run.id)
    expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
    expect(await call('interaction_get', { interactionId: interaction.id })).toMatchObject({ canRespond: true })
    const decision = RespondToInteractionResponseSchema.parse(await call('interaction_respond', {
      interactionId: interaction.id, expectedRevision: interaction.revision, optionId: 'finish',
    }))
    expect(decision.interaction.status).toBe('delivered')
    await f.engine.start(f.f.run.id)
    const completed = await f.runs.get(f.f.run.id)
    expect(completed).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    expect(parseWorkHandoffResult(completed?.result).data.remainingFindings).toEqual(output.data.remainingFindings)
    const graph = CanonicalRunGraphCurrentSchema.parse(await call(CANONICAL_RUN_GRAPH_MCP_TOOLS.current,
      { protocolVersion: 1, scope: f.f.scope }))
    expect(graph.state.run).toMatchObject({ executionState: 'completed', pendingInteractionCount: 0 })
    expect(graph.state.interactions).toEqual([])
    expect(graph.state.executions).toHaveLength(1)
    expect(f.counts()).toMatchObject({ prompts: 1, responses: 0 })
    expect(await call('interaction_get', { interactionId: interaction.id }))
      .toMatchObject({ interaction: decision.interaction, canRespond: false })
    expect(await f.receipts()).toEqual([])
    const reader = await f.access.issue({ name: 'Workflow reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{
        actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [f.f.scope.workspaceId] },
      }] })
    for (const method of ['http', 'mcp'] as const) {
      const input = await saveInput(f, call)
      expect((await rpc(CURRENT_WORKFLOW_TOOLS.save, input, reader.token)).result?.isError).toBe(true)
      let saved: ReturnType<typeof CurrentWorkflowSaveResultSchema.parse>
      if (method === 'http') {
        const reply = await app.inject({ method: 'PUT', url: definitionUrl(input),
          headers: graphHeaders(caller.token), payload: input })
        expect(reply.statusCode, reply.body).toBe(200)
        saved = CurrentWorkflowSaveResultSchema.parse(reply.json())
      } else {
        saved = CurrentWorkflowSaveResultSchema.parse(await call(CURRENT_WORKFLOW_TOOLS.save, input))
      }
      expect(saved.value.version.id).not.toBe(input.expectedWorkflowVersionId)
      const persisted = CurrentWorkflowReadResultSchema.parse(await call(CURRENT_WORKFLOW_TOOLS.saved, {
        workspaceId: input.workspaceId, workflowId: input.workflowId,
      }))
      expect(persisted.version).toEqual(saved.value.version)
      expect(agentWorkflowNode(persisted.version.definition.nodes[0]).initialPrompt)
        .toBe(agentWorkflowNode(input.graph.nodes[0]).initialPrompt)
      expect(await f.runs.get(f.f.run.id)).toEqual(completed)
    }
    expect(f.counts()).toMatchObject({ prompts: 1, responses: 0 })
  } finally {
    try { await transport?.app.close() } finally { await f.close() }
  }
}, 120_000)

it.skipIf(!postgresEnabled)('blocks workflow saves when a delivered native approval loses its resume evidence', async () => {
  const f = await currentOperatorIntegration()
  let transport: Awaited<ReturnType<typeof saveApp>> | undefined
  try {
    transport = await saveApp(f)
    const { app, caller, call, rpc } = transport
    await f.engine.start(f.f.run.id)
    const [interaction] = await f.pending()
    expect(interaction).toMatchObject({ status: 'pending', harness: 'codex' })
    if (!interaction) throw new Error('Expected a native approval')
    expect(interaction.nativeRequestId).toBeTruthy()
    expect(interaction.nativeSessionId).toBeTruthy()
    const option = interaction.responseOptions.find(candidate => candidate.semantic === 'approve_once')!
    const decision = RespondToInteractionResponseSchema.parse(await call('interaction_respond', {
      interactionId: interaction.id, expectedRevision: interaction.revision, optionId: option.optionId,
    }))
    expect(decision.interaction.status).toBe('delivered')
    await f.engine.start(f.f.run.id)
    expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    // This replay discovers approvals from history; link its recorded request to the persisted native turn.
    const correlation = await f.db.pool.query(`insert into run_native_correlations
      select (jsonb_populate_record(null::run_native_correlations, to_jsonb(c) || jsonb_build_object(
        'correlation_key', 'approval:' || i.id, 'native_request_id', i.record->>'nativeRequestId',
        'interaction_id', i.id))).*
      from run_native_correlations c join durable_interactions i
        on i.run_id=c.run_id and i.execution_id=c.execution_id
      where i.id=$1 and c.work_kind='workflow' and c.interaction_id is null
      order by c.correlation_key limit 1 returning interaction_id`, [interaction.id])
    expect(correlation.rows).toEqual([{ interaction_id: interaction.id }])
    await call(CURRENT_WORKFLOW_TOOLS.save, await saveInput(f, call))
    const input = await saveInput(f, call)
    const removed = await f.db.pool.query('delete from interaction_graph_resumes where interaction_id=$1 returning *',
      [interaction.id])
    expect(removed.rowCount).toBe(1)
    const http = await app.inject({ method: 'PUT', url: definitionUrl(input),
      headers: graphHeaders(caller.token), payload: input })
    expect(http.statusCode, http.body).toBe(409)
    expect(http.json()).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
    const mcp = await rpc(CURRENT_WORKFLOW_TOOLS.save, { ...input, commandId: randomUUID() })
    expect(mcp.result?.isError).toBe(true)
    expect(graphRpcValue(mcp.result)).toMatchObject({ error: { code: 'WORKFLOW_RUNS_UNSETTLED' } })
    const unchanged = CurrentWorkflowReadResultSchema.parse(await call(CURRENT_WORKFLOW_TOOLS.saved, {
      workspaceId: input.workspaceId, workflowId: input.workflowId,
    }))
    expect(unchanged.version.id).toBe(input.expectedWorkflowVersionId)
    await f.db.pool.query(`insert into interaction_graph_resumes
      select * from jsonb_populate_record(null::interaction_graph_resumes,$1::jsonb)`,
    [JSON.stringify(removed.rows[0])])
    const saved = CurrentWorkflowSaveResultSchema.parse(await call(CURRENT_WORKFLOW_TOOLS.save, input))
    expect(saved.value.version.id).not.toBe(input.expectedWorkflowVersionId)
  } finally {
    try { await transport?.app.close() } finally { await f.close() }
  }
}, 120_000)
