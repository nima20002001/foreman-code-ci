import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import {
  CURRENT_WORKFLOW_TOOLS, CurrentEditReadResultSchema, CurrentRunDetailsSchema, CurrentWorkflowReadResultSchema,
} from '@foreman-code/contracts/wave25'
import { setupWorkflowCreateIntegration } from './helpers/operatorWorkflowCreate.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

function value(result: Parameters<typeof decodeMcpToolResult>[0] & { isError?: boolean | undefined }) {
  expect(result.isError, JSON.stringify(result)).not.toBe(true)
  return decodeMcpToolResult(result)
}

describe.runIf(postgresEnabled)('staged workflow approval omission through authenticated MCP', () => {
  const integration = setupWorkflowCreateIntegration()

  it('stops an affected Run and saves the inherited approval consistently in the journal and workflow', async () => {
    const f = await integration()
    try {
      const scope = { workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId }
      const runScope = { workspaceId: scope.workspaceId, runId: f.f.run.id, detail: 'full' }
      const before = CurrentWorkflowReadResultSchema.parse(value(
        await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: scope })))
      const queued = CurrentRunDetailsSchema.parse(value(
        await f.client.callTool({ name: 'run_get', arguments: runScope })))
      expect(queued.run.executionState).toBe('queued')
      const graph = structuredClone(before.version.definition)
      const node = graph.nodes[0]!
      if (node.kind === 'job') throw new Error('Expected an Agent node')
      node.initialPrompt = 'Use the revised task instructions.'
      delete graph.approval
      const stage = { ...scope, action: 'stage_edits', draftId: randomUUID(), commandId: randomUUID(),
        executionSemanticsVersion: 3, expectedRevision: before.revision,
        expectedWorkflowVersionId: before.currentVersionId,
        expectedAgentConfigurationVersionIds: before.version.agentConfigurationVersionIds, graph }
      const staged = CurrentEditReadResultSchema.parse(value(
        await f.client.callTool({ name: 'workflow_edit_v3', arguments: stage })))
      const intent = staged.intent!
      expect(intent.state).toBe('staged')
      expect(intent.affected.map(run => run.runId)).toEqual([queued.run.id])
      expect(intent.stops.map(stop => stop.input.runId)).toEqual([queued.run.id])
      const editScope = { ...scope, draftId: stage.draftId, intentId: intent.id }
      const advance = { ...editScope, action: 'stop_and_save', commandId: intent.advanceCommandId }
      let finished = CurrentEditReadResultSchema.parse(value(
        await f.client.callTool({ name: 'workflow_edit_v3', arguments: advance })))
      if (finished.intent?.state === 'waiting') {
        await expect.poll(async () => {
          finished = CurrentEditReadResultSchema.parse(value(
            await f.client.callTool({ name: 'workflow_edit_v3', arguments: advance })))
          return finished.intent?.state
        }, { timeout: 5_000 }).toBe('saved')
      }
      expect(finished.intent?.state, JSON.stringify(finished.intent?.error)).toBe('saved')
      expect(intent.stagedDraft.graph.approval).toEqual(before.version.approval)
      expect(intent.saveInput.graph.approval).toEqual(before.version.approval)
      expect(intent.saveInput.graph).toEqual(intent.stagedDraft.graph)
      const saved = finished.intent!.result!
      expect(saved.revision).toBe(before.revision + 1)
      expect(saved.currentVersionId).not.toBe(before.currentVersionId)
      expect(saved.version.approval).toEqual(before.version.approval)
      expect(saved.version.definition.approval).toEqual(before.version.approval)
      expect(saved.version.definition.nodes[0]).toMatchObject({ initialPrompt: node.initialPrompt })
      const stopped = CurrentRunDetailsSchema.parse(value(
        await f.client.callTool({ name: 'run_get', arguments: runScope })))
      expect(stopped.run.outcome).toBe('canceled')
      expect(CurrentWorkflowReadResultSchema.parse(value(
        await f.client.callTool({ name: 'workflow_saved_get_v3', arguments: scope }))).version).toEqual(saved.version)
      expect(CurrentWorkflowReadResultSchema.parse(value(await f.client.callTool({
        name: 'workflow_saved_get_v3', arguments: { ...scope, workflowVersionId: before.currentVersionId },
      }))).version).toEqual(before.version)
      expect(value(await f.client.callTool({ name: 'workflow_edit_v3', arguments: advance }))).toEqual(finished)
      expect(value(await f.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.editRead,
        arguments: { ...editScope, action: 'read_edits' } }))).toEqual(finished)
    } finally {
      await f.close()
    }
  }, 30_000)
})
