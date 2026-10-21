import { expect } from 'vitest'
import { WorkflowExecutionChatResolutionSchema } from '@foreman-code/contracts'
import { graphRpc, graphRpcValue } from '../eng04-graph-composition-fixture.js'
import type { currentOperatorIntegration } from './currentOperatorIntegration.js'

type Fixture = Awaited<ReturnType<typeof currentOperatorIntegration>>

export async function workflowChatCall(f: Fixture, name: string, input: unknown) {
  const reply = await graphRpc(f.app, f.writer.token, 'tools/call', { name, arguments: input })
  expect(reply.result?.isError, JSON.stringify(reply)).not.toBe(true)
  return graphRpcValue(reply.result)
}

export async function workflowChatTarget(f: Fixture, workflowNodeId: string, executionId?: string) {
  const resolution = WorkflowExecutionChatResolutionSchema.parse(await workflowChatCall(f, 'agent_chat_read', {
    resolve: { workspaceId: f.f.run.workspaceId, workflowId: f.f.run.workflowId,
      runId: f.f.run.id, workflowNodeId, ...(executionId ? { executionId } : {}) },
  }))
  if (resolution.kind !== 'selected') throw new Error(`Expected a selected chat target: ${resolution.kind}`)
  return resolution.target
}
