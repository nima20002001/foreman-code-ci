import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './wave25Agent3.js'

export function foundationManagedAcceptance(source: 'http' | 'mcp') {
  describe.skipIf(!postgresEnabled)(`Managed ${source} workflow acceptance`, () => {
    afterEach(() => vi.restoreAllMocks())
    it('validates approval on Save, pins it on real Start and preserves persisted configuration versions', async () => {
      const f = await currentOperatorIntegration()
      try {
        const location = await f.locations.set(f.writer.principal, source, { workspaceId: f.f.scope.workspaceId,
          runnerId: f.f.run.executionLocation!.runnerId, rootPath: f.db.directory,
          expectedLocationRevision: 1, commandId: randomUUID() })
        const input = await f.create()
        async function save(value: typeof input) {
          if (source === 'mcp') {
            const response = await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save, arguments: value })
            if (response.isError) throw new Error(JSON.stringify(decodeMcpToolResult(response)))
            return CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(response))
          }
          const response = await f.app.inject({ method: 'PUT', url: `/api/management/workspaces/${value.workspaceId}/workflows/${value.workflowId}/definition`,
            headers: { authorization: `Bearer ${f.writer.token}` }, payload: value })
          if (response.statusCode !== 200) throw new Error(response.body)
          return CurrentWorkflowSaveResultSchema.parse(response.json())
        }
        await expect(save({ ...input, graph: { ...input.graph, approval: { handler: 'orchestrator' } as never } })).rejects.toThrow()
        expect((await f.db.pool.query('select id from workflow_versions where workflow_id=$1', [input.workflowId])).rows).toHaveLength(0)
        const saved = await save({ ...input, commandId: randomUUID() })
        const start = { workspaceId: input.workspaceId, workflowId: input.workflowId, workflowVersionId: saved.value.currentVersionId,
          executionSemanticsVersion: 3, expectedWorkflowRevision: saved.value.revision,
          expectedLocationRevision: location.value.locationRevision,
          expectedAgentConfigurationVersionIds: saved.value.version.agentConfigurationVersionIds, commandId: randomUUID(), input: {} }
        const engineStart = f.engine.start.bind(f.engine)
        // Start responds after admission; await its scheduled drive without imposing a separate load-sensitive deadline.
        const dispatched = new Promise<string>((resolve, reject) => {
          vi.spyOn(f.engine, 'start').mockImplementation((runId) => {
            const task = engineStart(runId)
            void task.then(() => resolve(runId), reject)
            return task
          })
        })
        let run: { id: string }
        if (source === 'mcp') {
          const result = await f.client.callTool({ name: 'run_start', arguments: start })
          expect(result.isError, JSON.stringify(decodeMcpToolResult(result))).not.toBe(true)
          run = (decodeMcpToolResult(result) as { run: { id: string } }).run
        } else {
          const result = await f.app.inject({ method: 'POST', url: `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/runs`,
            headers: { authorization: `Bearer ${f.writer.token}` }, payload: start })
          expect(result.statusCode, result.body).toBe(202); run = result.json().run
        }
        expect(await dispatched).toBe(run.id)
        expect((await f.runs.get(run.id))?.executionState).toBe('waiting')
        const detail = await f.app.inject({
          method: 'GET',
          url: `/api/management/workspaces/${input.workspaceId}/runs/${run.id}`,
          headers: { authorization: `Bearer ${f.writer.token}` },
        })
        expect(detail.statusCode, detail.body).toBe(200)
        expect(detail.json().run).toMatchObject({
          executionState: 'waiting',
          outcome: 'pending',
          workflowVersionId: saved.value.currentVersionId,
          agentConfigurationVersionIds: input.expectedAgentConfigurationVersionIds,
        })
        const remote = await f.client.callTool({
          name: 'run_get',
          arguments: { workspaceId: input.workspaceId, runId: run.id, detail: 'full' },
        })
        expect(remote.isError, JSON.stringify(decodeMcpToolResult(remote))).not.toBe(true)
        expect(decodeMcpToolResult(remote)).toEqual(detail.json())
        expect(await f.runs.get(run.id)).toMatchObject({ approval: saved.value.version.approval,
          workflowVersionId: saved.value.currentVersionId, agentConfigurationVersionIds: input.expectedAgentConfigurationVersionIds })
        const configured = (await f.db.pool.query('select record from agent_configuration_versions where id=any($1::text[])', [Object.values(input.expectedAgentConfigurationVersionIds)])).rows.map((row) => row.record)
        expect(configured).toEqual(expect.arrayContaining(f.f.configurations))
        expect(f.dispatchErrors).toEqual([])
      } finally { await f.close() }
    }, 90000)
  })
}
