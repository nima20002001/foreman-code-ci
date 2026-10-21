import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { RUN_INSPECTION_TOOLS, RunExecutionsPageSchema, RunExecutionDetailSchema, RunExecutionBindingsPageSchema } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { RunInspectionService } from '../src/modules/runs/inspection.js'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { RepeatRepositoryFactory } from '../src/modules/runs/repeatRepositoryHost.js'
import { workActivationSlotId } from '../src/modules/runs/repeatResolution.js'
import { createWorkflowRepositoryServices } from '../src/modules/runs/workflowRepositoryServices.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { graphFixture, graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { nim2691TaskDatabase } from './helpers/nim2691Database.js'

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('current handoff inspection over authenticated HTTP/MCP', () => {
  it('reads the persisted activation slot and denies another workspace without changing Run facts', async () => {
    await nim2691TaskDatabase(async (pool, directory) => {
      await applyApplicationMigrations(pool)
      const db = { pool, directory, schema: 'public', close: async () => undefined }
      const t = await graphFixture(db, { form: 'single', handoffs: true, qualifiedReads: true })
      const owner = await RunOwnership.acquire(pool, t.run.id, () => undefined)
      assert.ok(owner)
      let executionId: string, activationId: string
      try {
        const locations = new WorkspaceLocationService(pool, t.commands, directory, 'runner-local')
        const factory = new RepeatRepositoryFactory(locations, directory,
          createWorkflowRepositoryServices(createWorkflowNativeCaptureChannel().verify).services)
        const store = factory.forOwner(owner, t.version)
        activationId = await store.ensureWorkEntry()
        const node = agentWorkflowNode(t.version.definition.nodes[0])
        const admitted = await store.admitWorkActivation(activationId, () => ({
          id: `inspection-execution-${randomUUID()}`, runId: t.run.id, workflowNodeId: node.id, agentId: node.agentId,
          agentConfigurationVersionId: t.version.agentConfigurationVersionIds[node.agentId]!, attempt: 1,
          input: {}, state: 'queued', createdAt: new Date().toISOString(),
        }))
        executionId = admitted.execution.id
      } finally { await owner.release(); await t.app.close() }
      // Read-only production service composition; no native process is launched by this test.
      const services = { commands: t.commands, runGraph: t.graph,
        runs: { inspection: new RunInspectionService(pool) } } as unknown as OperatorServices
      const app = buildApp({ readiness: { database: { ping: async () => { await pool.query('select 1') } },
        checkpoints: { ping: async () => undefined } }, operator: { access: t.access, services } })
      try {
        const scope = { workspaceIds: [t.scope.workspaceId], workflowIds: [t.scope.workflowId], runIds: [t.run.id] }
        const reader = await t.credential([{ actions: ['capabilities:read'], scope: {} },
          { actions: ['runs:read'], scope },
          { actions: ['workflows:read'], scope: { workspaceIds: scope.workspaceIds, workflowIds: scope.workflowIds } }])
        const denied = await t.credential([{ actions: ['capabilities:read'], scope: {} },
          { actions: ['runs:read', 'workflows:read'], scope: { workspaceIds: ['foreign-workspace'] } }])
        const input = { workspaceId: t.scope.workspaceId, runId: t.run.id }
        const url = `/api/management/workspaces/${input.workspaceId}/runs/${input.runId}/executions`
        const before = (await pool.query('select record from harness_executions where id=$1', [executionId])).rows[0]
        const http = await app.inject({ method: 'GET', url, headers: graphHeaders(reader.token) })
        expect(http.statusCode, http.body).toBe(200)
        const page = RunExecutionsPageSchema.parse(http.json())
        expect(page.items).toHaveLength(1)
        expect(page.items[0]).toMatchObject({ executionId, state: 'queued', acceptedResultAvailable: false })
        const mcp = await graphRpc(app, reader.token, 'tools/call', { name: RUN_INSPECTION_TOOLS.executions, arguments: input })
        expect(mcp.result?.isError).not.toBe(true)
        expect(RunExecutionsPageSchema.parse(graphRpcValue(mcp.result))).toEqual(page)
        const detailInput = { ...input, executionId }
        const detailHttp = await app.inject({ method: 'GET', url: `${url}/${executionId}`, headers: graphHeaders(reader.token) })
        expect(detailHttp.statusCode, detailHttp.body).toBe(200)
        const detail = RunExecutionDetailSchema.parse(detailHttp.json())
        const originalInput = before.record.input
        expect(detail.acceptedInput.value).toEqual(originalInput)
        expect(detail.acceptedResult).toEqual({ status: 'not_accepted' })
        const detailMcp = await graphRpc(app, reader.token, 'tools/call', { name: RUN_INSPECTION_TOOLS.execution, arguments: detailInput })
        expect(detailMcp.result?.isError).not.toBe(true)
        expect(RunExecutionDetailSchema.parse(graphRpcValue(detailMcp.result))).toEqual(detail)
        const bindingsHttp = await app.inject({ method: 'GET', url: `${url}/${executionId}/bindings`, headers: graphHeaders(reader.token) })
        expect(bindingsHttp.statusCode, bindingsHttp.body).toBe(200)
        const bindings = RunExecutionBindingsPageSchema.parse(bindingsHttp.json())
        expect(bindings.items).toEqual([])
        const bindingsMcp = await graphRpc(app, reader.token, 'tools/call', { name: RUN_INSPECTION_TOOLS.bindings, arguments: detailInput })
        expect(bindingsMcp.result?.isError).not.toBe(true)
        expect(RunExecutionBindingsPageSchema.parse(graphRpcValue(bindingsMcp.result))).toEqual(bindings)
        for (const [suffix, name] of [['', RUN_INSPECTION_TOOLS.execution], ['/bindings', RUN_INSPECTION_TOOLS.bindings]] as const) {
          const deniedHttp = await app.inject({ method: 'GET', url: `${url}/${executionId}${suffix}`, headers: graphHeaders(denied.token) })
          expect(deniedHttp.statusCode).toBe(403)
          const deniedDetailMcp = await graphRpc(app, denied.token, 'tools/call', { name, arguments: detailInput })
          expect(deniedDetailMcp.result?.isError).toBe(true)
          expect(JSON.stringify(deniedDetailMcp.result)).toContain('ACCESS_DENIED')
        }
        const hidden = await app.inject({ method: 'GET', url, headers: graphHeaders(denied.token) })
        expect(hidden.statusCode).toBe(403)
        expect(hidden.json()).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
        const deniedMcp = await graphRpc(app, denied.token, 'tools/call', { name: RUN_INSPECTION_TOOLS.executions, arguments: input })
        expect(deniedMcp.result?.isError).toBe(true)
        expect(JSON.stringify(deniedMcp.result)).toContain('ACCESS_DENIED')
        const slot = (await pool.query('select slot_id,work_activation_id from run_repeat_executions where execution_id=$1', [executionId])).rows[0]
        expect(slot).toEqual({ slot_id: workActivationSlotId(t.run.id, activationId), work_activation_id: activationId })
        expect((await pool.query('select record from harness_executions where id=$1', [executionId])).rows[0]).toEqual(before)
      } finally { await app.close() }
    })
  }, 120_000)
})
