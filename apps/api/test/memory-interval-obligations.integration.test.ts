import { expect, it, vi } from 'vitest'
import { memoryBoardTools } from '@foreman-code/contracts'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { prepareCoordinationWorkflow } from './helpers/coordinationWorkflow.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { memoryCall, memoryWorkflow, type MemoryRuntime } from './helpers/memoryWorkflow.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

it.runIf(postgresEnabled)('applies interval board effects without creating an unsettled business obligation', async () => {
  const fixture = memoryWorkflow('single')
  agentWorkflowNode(fixture.version.definition.nodes[0]).interval = { everySeconds: 10 }
  fixture.configurations[0]!.graphqlTools = memoryBoardTools('write')
  const harness = fixture.configurations[0]!.harness
  if (harness.harness !== 'codex') throw new Error('Expected a Codex fixture')
  harness.sandbox = 'workspace-write'
  let boardId: string
  const runtime: MemoryRuntime = await currentOperatorIntegration({ fixture, insertRun: false, approvalNodeIds: [],
    outputFor: (_node, request) => {
      const tick = typeof request.input === 'object' && request.input !== null && !Array.isArray(request.input) && request.input.tick
      return { text: JSON.stringify({ ...(tick ? {} : { routing: { kind: 'finish' } }),
        data: tick ? { text: 'Check complete' } : { latestDeliverable: { text: 'Work complete' }, remainingFindings: [] },
        summary: 'Completed check.', board: tick ? { kind: 'changes', operations: [{ kind: 'card_create', boardId,
          card: { title: 'Follow up from interval', body: '', status: 'todo', completionKind: null,
            reason: null, assignee: null, linkedNodes: [] } }] } : { kind: 'none', reason: 'no_changes' } }) }
    },
  })
  try {
    const prepared = await prepareCoordinationWorkflow(runtime)
    boardId = prepared.boardId
    const started = await prepared.start()
    await vi.waitFor(async () => {
      const details = await runtime.runs.getDetails(prepared.scope.workspaceId, started.run.id)
      expect(details?.executions.some(execution => execution.state === 'completed'
        && typeof execution.input === 'object' && execution.input !== null && !Array.isArray(execution.input)
        && execution.input.tick)).toBe(true)
    }, { timeout: 30000, interval: 100 })
    const cards = await memoryCall(runtime.client, 'memory_board_get', { boardId, view: 'cards', status: 'todo' })
    expect(cards.items).toHaveLength(1)
    const cardId = (cards.items as Array<{ id: string }>)[0]!.id
    expect(await memoryCall(runtime.client, 'memory_board_get', { boardId, view: 'card', cardId }))
      .toMatchObject({ bindings: [], claims: [], card: { status: 'todo' } })
    expect(await memoryCall(runtime.client, 'memory_card_update', { kind: 'card_update', boardId, cardId,
      patch: { status: 'done', completionKind: 'completed' } })).toMatchObject({ card: { status: 'done' } })
    await memoryCall(runtime.client, 'run_stop', { workspaceId: prepared.scope.workspaceId, runId: started.run.id })
  } finally { await runtime.close() }
}, 60000)
