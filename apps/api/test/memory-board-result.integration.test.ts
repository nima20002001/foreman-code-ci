import { prepareCoordinationWorkflow } from './helpers/coordinationWorkflow.js'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, memoryBoardTools } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

it.runIf(postgresEnabled).each([false, true])('applies result board effects only for a pinned coordination protocol (%s)', async pinned => {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  fixture.configurations[0]!.graphqlTools = memoryBoardTools('write')
  fixture.configurations[0]!.harness = { harness: 'codex', model: 'synthetic-no-native-call',
    reasoningEffort: 'low', sandbox: 'workspace-write', serviceTier: 'standard',
    advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' } }
  fixture.version.approval = { handler: 'native' }
  fixture.version.definition.approval = fixture.version.approval
  fixture.run.approval = fixture.version.approval
  let boardId: string
  let original: { text: string }
  const runtime = await currentOperatorIntegration({ fixture, insertRun: !pinned, approvalNodeIds: [], outputFor: () => {
    original = { text: JSON.stringify({ data: { deliverable: 'Complete' }, summary: 'Work complete.', board: {
      kind: 'changes', operations: [{ kind: 'card_create', boardId, card: {
        title: 'Result task', body: 'Recorded at completion', status: 'todo', completionKind: null,
        reason: null, assignee: null, linkedNodes: [],
      } }],
    } }) }
    return original
  } })
  try {
    const read = async (args: Record<string, unknown>) => {
      const reply = await runtime.client.callTool({ name: 'memory_board_get', arguments: args })
      expect(reply.isError, JSON.stringify(reply.content)).not.toBe(true)
      return decodeMcpToolResult(reply)
    }
    const prepared = pinned ? await prepareCoordinationWorkflow(runtime) : undefined
    const scope = prepared?.scope ?? { kind: 'workflow', workspaceId: runtime.f.scope.workspaceId, workflowId: runtime.f.scope.workflowId }
    boardId = prepared?.boardId ?? ((await read({ scope })).board as { id: string }).id
    let runId = runtime.f.run.id
    if (prepared) {
      const started = await prepared.start()
      runId = started.run.id
      expect(started.run.resultProtocol).toBe('f1-f4-v1')
      await vi.waitFor(async () => expect((await runtime.runs.get(runId))?.executionState).toBe('completed'),
        { timeout: 30000, interval: 50 })
    } else await runtime.engine.start(runId)
    const details = await runtime.runs.getDetails(scope.workspaceId, runId)
    expect(details?.run.outcome).toBe('succeeded')
    expect(details?.executions[0]?.result).toEqual({ outcome: 'succeeded', output: original! })
    const done = await read({ boardId, view: 'cards', status: 'done' })
    if (pinned) expect(done.items).toEqual([expect.objectContaining({ title: 'Result task', status: 'done', completionKind: 'completed' })])
    else expect(done.items).toEqual([])
    await runtime.engine.start(runId)
    expect(await read({ boardId, view: 'cards', status: 'done' })).toEqual(done)
  } finally { await runtime.close() }
}, 60000)
