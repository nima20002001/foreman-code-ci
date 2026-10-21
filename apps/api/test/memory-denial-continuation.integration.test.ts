import { expect, it } from 'vitest'
import { WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { memoryCall, memoryWorkflow, workflowMemory, type MemoryRuntime } from './helpers/memoryWorkflow.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

it.runIf(postgresEnabled)('settles work linked during its denied handoff continuation', async () => {
  const fixture = memoryWorkflow()
  const edge = fixture.version.definition.edges[0]!
  edge.maxWorkHandoffsPerRun = 1
  fixture.version.definition.executionPolicy = { maxParallelism: 1, maxNodeExecutions: 5 }
  fixture.version.definition.nodes[0]!.choice = { outcomes: [{ outcome: 'review',
    target: { kind: 'edge', relationshipId: edge.id } }] }
  let memory: Awaited<ReturnType<typeof workflowMemory>>
  let linked: Record<string, unknown> | undefined
  const runtime: MemoryRuntime = await currentOperatorIntegration({ fixture, approvalNodeIds: [],
    outputFor: (_node, request) => {
      const { work } = WorkActivationInputSchema.parse(request.input)
      let routing: Record<string, string> = { kind: 'request', outcome: 'review' }
      if (work.kind === 'work_request') routing = { kind: 'return', requestId: work.request.requestId, outcome: 'needs_changes' }
      if (work.kind === 'limit_denial') routing = { kind: 'finish' }
      return { routing, data: { latestDeliverable: { text: 'Complete' },
        remainingFindings: work.kind === 'work_request' ? ['Revise once'] : [] } }
    },
    managerFactory: () => {
      const manager = runtime.provider.connection()
      let input: ReturnType<typeof WorkActivationInputSchema.parse>
      return { ...manager, async createSession(start) {
        if (!isWorkflowStart(start)) throw new Error('Expected workflow session')
        input = WorkActivationInputSchema.parse(start.request.input)
        return manager.createSession(start)
      }, async *startTurn(session, turn) {
        if (input.work.kind === 'limit_denial') {
          linked = await memoryCall(runtime.client, 'memory_card_create', { kind: 'card_create', boardId: memory.boardId,
            card: { title: 'Linked after route exhaustion', body: '', status: 'doing', completionKind: null,
              reason: null, assignee: null, linkedNodes: [] }, workSelections: [{ kind: 'current', work: {
              kind: 'activation', runId: runtime.f.run.id, workflowVersionId: runtime.f.version.id,
              activationId: input.work.denial.requesterActivationId,
            } }] })
          expect(linked).toMatchObject({ bindings: [{ state: 'waiting_children' }] })
        }
        yield* manager.startTurn(session, turn)
      } }
    },
  })
  try {
    memory = await workflowMemory(runtime)
    await runtime.engine.start(runtime.f.run.id)
    expect((await runtime.runs.get(runtime.f.run.id))?.outcome).toBe('succeeded')
    expect(linked).toBeDefined()
    const detail = await memoryCall(runtime.client, 'memory_board_get', { boardId: memory.boardId,
      view: 'card', cardId: (linked!.card as { id: string }).id })
    expect(detail).toMatchObject({ card: { status: 'done', completionKind: 'completed' }, bindings: [{ state: 'accepted' }] })
  } finally { await runtime.close() }
}, 60000)
