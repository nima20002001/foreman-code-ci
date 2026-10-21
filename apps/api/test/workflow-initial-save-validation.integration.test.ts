import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { decodeMcpToolResult, WorkflowSummaryPageSchema } from '@foreman-code/contracts/operator-mcp'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { initialSave, setupWorkflowCreateIntegration } from './helpers/operatorWorkflowCreate.js'

const setup = setupWorkflowCreateIntegration()

it('reports conflicting handoff and repeat policies without leaving a workflow behind', async () => {
  const f = await setup({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'repeat') })
  try {
    const workspaceId = f.f.scope.workspaceId
    const list = async () => {
      const reply = await f.client.callTool({ name: 'workflow_list', arguments: { workspaceId, limit: 100 } })
      expect(reply.isError).not.toBe(true)
      return WorkflowSummaryPageSchema.parse(decodeMcpToolResult(reply))
    }
    const before = await list()
    const save = initialSave(f.f.version.definition, f.f.version.agentConfigurationVersionIds)
    const rejected = await f.client.callTool({ name: 'workflow_create', arguments: {
      workspaceId, commandId: randomUUID(), name: 'Conflicting policies', defaultWorktree: null,
      initialSave: { ...save, graph: { ...save.graph, handoffs: { contractVersion: 1 } } },
    } })
    expect(rejected.isError).toBe(true)
    expect(await list()).toEqual(before)
    expect(decodeMcpToolResult(rejected)).toMatchObject({ error: {
      code: 'GRAPH_INVALID',
      details: { issues: [{ code: 'custom', path: ['handoffs'], message: 'HANDOFF_REPEAT_POLICY_CONFLICT' }] },
    } })
  } finally {
    await f.close()
  }
}, 120_000)
