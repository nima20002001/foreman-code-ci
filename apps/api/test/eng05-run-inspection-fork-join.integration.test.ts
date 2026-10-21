import { describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { OperatorToolSchemaResultSchema } from '@foreman-code/contracts/operator-mcp'
import {
  RUN_INSPECTION_TOOLS, RunExecutionDetailSchema, RunExecutionsPageSchema, RunExecutionBindingsPageSchema, RunRecordDetailSchema, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import {
  requestScope, reader, allExecutions, parity, path, value, terminal, resaveChangingRepeat, denied,
} from './helpers/runInspection.js'

async function checkInParallel<T>(items: readonly T[], check: (item: T) => Promise<void>) {
  // Drain every read before fixture cleanup can close the MCP clients or pool.
  const results = await Promise.allSettled(items.map(check))
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, 'Run inspection checks failed.')
}

describe.skipIf(!postgresEnabled)('PostgreSQL authenticated Run inspection: fork-join', () => {
  it('reads ordinary fork/join history, exact inputs/results, denied scopes and replayed pages; keeps its old pin after adding repeat', async () => {
    const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'parallel'), approvalNodeIds: [] })
    try {
      await f.engine.start(f.f.run.id); await terminal(f)
      const r = await reader(f), args = requestScope(f)
      const discovery = (await r.client.listTools()).tools
      await checkInParallel(Object.values(RUN_INSPECTION_TOOLS), async name => {
        const tool = discovery.find((item) => item.name === name)
        expect(tool?.name).toBe(name)
        expect(tool?.inputSchema.type).toBe('object')
        expect(tool).not.toHaveProperty('outputSchema')
        const schema = OperatorToolSchemaResultSchema.parse(value(await r.client.callTool({
          name: 'operator_tool_schema_get', arguments: { name, includeOutputSchema: true },
        })))
        expect(schema.name).toBe(name)
        expect(schema.inputSchema).toEqual(tool?.inputSchema)
        expect(schema.outputSchema?.type).toBe('object')
        expect(tool?.annotations?.readOnlyHint).toBe(true)
        expect(tool?.description).toBeTruthy()
      })
      expect(discovery.map((item) => item.name)).not.toContain('run_start')
      const capabilities = value(await r.client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })) as {
        tools: string[]; requirements: Array<{ name: string; actions: string[] }> }
      expect(capabilities.tools).toEqual(expect.arrayContaining(Object.values(RUN_INSPECTION_TOOLS)))
      expect(capabilities.requirements.find((item) => item.name === RUN_INSPECTION_TOOLS.version)?.actions).toEqual(['runs:read', 'workflows:read'])
      const invalid = await f.app.inject({ method: 'GET', url: path(args, RUN_INSPECTION_TOOLS.executions), headers: { authorization: 'Bearer invalid' } })
      expect(invalid.statusCode).toBe(401)

      const counts = { ...f.provider.counts }
      const items = await allExecutions(f, r)
      expect(items).toHaveLength(4)
      for (const item of items) {
        expect(item).not.toHaveProperty('occurrence')
        expect(item).not.toHaveProperty('input'); expect(item).not.toHaveProperty('result')
        expect(item).not.toHaveProperty('nativeSession'); expect(item).not.toHaveProperty('workingDirectory')
      }
      const ids = (await f.db.pool.query<{ id: string }>(
        'select id from harness_executions where run_id=$1 order by created_at desc,id desc', [args.runId])).rows.map((row) => row.id)
      expect(items.map((item) => item.executionId)).toEqual(ids)
      expect((await f.db.pool.query('select occurrence_id from run_repeat_occurrences where run_id=$1', [args.runId])).rows).toEqual([])
      const join = items.find((item) => item.workflowNodeId === f.f.version.definition.nodes.at(-1)!.id)!
      const detailArgs = { ...args, executionId: join.executionId }
      const detail = RunExecutionDetailSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.execution, detailArgs))
      const stored = (await f.db.pool.query<{ input_json: string; input_digest: string; result_json: string; result_digest: string }>(
        `select s.input_json,s.input_digest,r.result_json,r.result_digest from run_repeat_executions x
         join run_repeat_slots s on s.slot_id=x.slot_id join run_repeat_results r on r.execution_id=x.execution_id
         where x.execution_id=$1 and x.run_id=$2`, [join.executionId, args.runId])).rows[0]!
      expect(detail.acceptedInput).toEqual({ digest: stored.input_digest, value: JSON.parse(stored.input_json) })
      expect(detail.acceptedResult).toEqual({ status: 'accepted', digest: stored.result_digest, value: JSON.parse(stored.result_json) })
      expect(detail.acceptedInput.value.predecessors).toHaveLength(2)
      expect(detail.acceptedInput.value.occurrence).toBeNull()
      const first = RunExecutionBindingsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.bindings, { ...detailArgs, limit: 1 }))
      expect(first.items).toHaveLength(1); expect(first.items[0]?.ordinal).toBe(0)
      expect(first.pageInfo.nextCursor).not.toBeNull()
      const secondArgs = { ...detailArgs, limit: 1, cursor: first.pageInfo.nextCursor! }
      const second = RunExecutionBindingsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.bindings, secondArgs))
      expect(second.items).toHaveLength(1); expect(second.items[0]?.ordinal).toBe(1)
      expect(second.pageInfo.nextCursor).toBeNull()
      expect(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.bindings, secondArgs)).toEqual(second)
      expect([...first.items, ...second.items].map((item) => item.source)).toEqual(detail.acceptedInput.value.predecessors)
      expect(f.provider.counts).toEqual(counts)
      await denied(f, r.client, r.token, RUN_INSPECTION_TOOLS.bindings,
        { ...secondArgs, executionId: items.find((item) => item.executionId !== join.executionId)!.executionId }, 400, 'RUN_INSPECTION_CURSOR_INVALID')

      const firstExecutions = RunExecutionsPageSchema.parse(await parity(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, { ...args, limit: 1 }))
      await denied(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, { ...args, limit: 1,
        workflowNodeId: join.workflowNodeId, cursor: firstExecutions.pageInfo.nextCursor! }, 400, 'RUN_INSPECTION_CURSOR_INVALID')
      await denied(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, { ...args, workflowNodeId: 'missing-node' }, 404, 'WORKFLOW_NODE_NOT_FOUND')
      await denied(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, { ...args, occurrenceId: 'missing-occurrence' }, 404, 'RUN_OCCURRENCE_NOT_FOUND')
      await denied(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.execution, { ...detailArgs, workspaceId: 'wrong-workspace' }, 404, 'RUN_NOT_FOUND')
      await denied(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.execution, { ...detailArgs, runId: 'wrong-run' }, 404, 'RUN_NOT_FOUND')
      await denied(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.execution, { ...detailArgs, executionId: 'wrong-execution' }, 404, 'RUN_EXECUTION_NOT_FOUND')

      const d = await reader(f, [{ actions: ['capabilities:read'], scope: {} }])
      const deniedDiscovery = (await d.client.listTools()).tools.map(tool => tool.name)
      await checkInParallel(Object.values(RUN_INSPECTION_TOOLS), async name => {
        expect(deniedDiscovery).not.toContain(name)
        await denied(f, d.client, d.token, name,
          name === RUN_INSPECTION_TOOLS.execution || name === RUN_INSPECTION_TOOLS.bindings ? detailArgs : args, 403, 'ACCESS_DENIED')
      })
      const audit = (await f.db.pool.query<{ source: string }>('select source from management_audit where principal_id=$1', [d.principal.id])).rows
      expect(audit.map((row) => row.source)).toEqual(expect.arrayContaining(['http', 'mcp']))
      const wrongGrant = await reader(f, [{ actions: ['runs:read'], scope: { workspaceIds: ['other-workspace'] } }])
      await denied(f, wrongGrant.client, wrongGrant.token, RUN_INSPECTION_TOOLS.execution, detailArgs, 403, 'ACCESS_DENIED')
      const runsOnly = await reader(f, [{ actions: ['runs:read'], scope: { runIds: [args.runId] } }])
      await parity(f, runsOnly.client, runsOnly.token, RUN_INSPECTION_TOOLS.execution, detailArgs)
      const runRecord = RunRecordDetailSchema.parse(await parity(f, runsOnly.client, runsOnly.token, RUN_INSPECTION_TOOLS.record, args))
      expect(runRecord.run.workflowVersionId).toBe(f.f.version.id)
      expect(runRecord.run.agentConfigurationVersionIds).toEqual(f.f.version.agentConfigurationVersionIds)
      expect(runRecord.run).not.toHaveProperty('authorizationPrincipalId')
      expect(runRecord.run).not.toHaveProperty('executionLocation')
      expect(Object.keys(runRecord).sort()).toEqual(['cleanupPending', 'run', 'stopRequested'])
      await denied(f, runsOnly.client, runsOnly.token, RUN_INSPECTION_TOOLS.version, args, 403, 'ACCESS_DENIED')

      // Same actual workflow/node, different authentic Run/execution: no cross-Run detail leak.
      // The shared provider fixture seeds a synthetic runner/identity; a real MCP
      // Start revalidates the location, so save it through the real location tool.
      const location = value(await f.client.callTool({ name: 'workspace_location_set', arguments: {
        workspaceId: args.workspaceId, commandId: randomUUID(), expectedLocationRevision: 1,
        runnerId: f.locations.runnerId, rootPath: f.db.directory } })) as { locationRevision?: number; value?: { locationRevision: number } }
      const locationRevision = location.value?.locationRevision ?? location.locationRevision
      expect(locationRevision).toBe(2)
      expect(f.f.run.executionLocation?.locationRevision).toBe(1)
      const revision = (await f.db.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [f.f.scope.workflowId])).rows[0]!.revision
      const started = value(await f.client.callTool({ name: 'run_start', arguments: {
        workspaceId: args.workspaceId, workflowId: f.f.scope.workflowId, workflowVersionId: f.f.version.id,
        executionSemanticsVersion: 3, expectedWorkflowRevision: Number(revision),
        expectedAgentConfigurationVersionIds: f.f.version.agentConfigurationVersionIds, expectedLocationRevision: locationRevision,
        commandId: randomUUID(), input: {},
      } })) as { run: { id: string } }
      await terminal(f, started.run.id, 60000)
      const otherExecution = (await f.db.pool.query<{ id: string }>('select id from harness_executions where run_id=$1 order by id limit 1', [started.run.id])).rows[0]!.id
      await denied(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.execution, { ...args, executionId: otherExecution }, 404, 'RUN_EXECUTION_NOT_FOUND')
      await denied(f, r.client, r.token, RUN_INSPECTION_TOOLS.executions, { ...args, runId: started.run.id }, 403, 'ACCESS_DENIED')
      expect(new Set(f.provider.startedExecutions).size).toBe(f.provider.startedExecutions.length)
      const indexes = (await f.db.pool.query<{ indexname: string }>(
        "select indexname from pg_indexes where schemaname=current_schema() and indexname like 'eng05_%'" )).rows
      expect(indexes).toHaveLength(5)
      const oldRecord = await parity(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.record, args)
      await resaveChangingRepeat(f)
      expect(await parity(f, f.client, f.writer.token, RUN_INSPECTION_TOOLS.record, args)).toEqual(oldRecord)
      expect(f.dispatchErrors).toEqual([])
    } finally { await f.close() }
  }, 150000)
})
