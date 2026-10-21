import { expect, it } from 'vitest'
import { WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { memoryWorkflow, memoryCall, workflowMemory, type MemoryRuntime } from './helpers/memoryWorkflow.js'

it.runIf(postgresEnabled).each(['child', 'continuation'] as const)('keeps a late-linked parent unresolved during %s work and settles it afterward', async phase => {
  const fixture = memoryWorkflow()
  if (phase === 'continuation') {
    fixture.version.definition.executionPolicy = { maxParallelism: 1, maxNodeExecutions: 4 }
    fixture.version.definition.nodes[0]!.choice = { outcomes: [{ outcome: 'review',
      target: { kind: 'edge', relationshipId: fixture.version.definition.edges[0]!.id } }] }
  }
  let memory: Awaited<ReturnType<typeof workflowMemory>>
  let linked: Record<string, unknown> | undefined
  const denials: unknown[] = []
  let originalWork: unknown
  const runtime: MemoryRuntime = await currentOperatorIntegration({ fixture, approvalNodeIds: [],
    outputFor: (_node, request) => {
      const input = WorkActivationInputSchema.parse(request.input)
      const needsChanges = phase === 'continuation' && input.work.kind === 'work_request'
      let routing: Record<string, string> = { kind: 'finish' }
      if (input.work.kind === 'entry' && phase === 'continuation') routing = { kind: 'request', outcome: 'review' }
      if (input.work.kind === 'work_request') routing = { kind: 'return', requestId: input.work.request.requestId,
        outcome: needsChanges ? 'needs_changes' : 'accepted' }
      return { routing, data: { latestDeliverable: { text: 'Complete' }, remainingFindings: needsChanges ? ['Revise once'] : [] } }
    },
    managerFactory: () => {
      const manager = runtime.provider.connection()
      let workKind: string | undefined
      return { ...manager, async createSession(input) {
        if (!isWorkflowStart(input)) throw new Error('Expected workflow session')
        workKind = WorkActivationInputSchema.parse(input.request.input).work.kind
        return manager.createSession(input)
      }, async *startTurn(session, input) {
        if (workKind === 'work_request') {
          const current = await memory.read()
          originalWork = (current.bindings as Array<{ work: unknown }>)[0]!.work
        }
        if (phase === 'child' && workKind === 'work_request' || phase === 'continuation' && workKind === 'work_return') {
          const work = originalWork
          linked = await memoryCall(runtime.client, 'memory_card_create', { kind: 'card_create', boardId: memory.boardId,
            card: { title: 'Linked during review', body: '', status: 'doing', completionKind: null,
              reason: null, assignee: null, linkedNodes: [] }, workSelections: [{ kind: 'current', work }] })
          for (const completionKind of ['completed', 'dropped']) {
            const reply = await runtime.client.callTool({ name: 'memory_card_update', arguments: {
              kind: 'card_update', boardId: memory.boardId, cardId: (linked.card as { id: string }).id,
              patch: { status: 'done', completionKind, reason: 'Explicit request during review' },
            } })
            denials.push(reply)
          }
        }
        yield* manager.startTurn(session, input)
      } }
    },
  })
  try {
    memory = await workflowMemory(runtime)
    await runtime.engine.start(runtime.f.run.id)
    expect(linked).toMatchObject({ bindings: [{ state: 'waiting_children' }] })
    expect(denials).toHaveLength(2)
    for (const denial of denials) expect(denial).toMatchObject({ isError: true })
    const detail = await memoryCall(runtime.client, 'memory_board_get', { boardId: memory.boardId,
      view: 'card', cardId: (linked!.card as { id: string }).id })
    expect(detail).toMatchObject({ card: { status: 'done', completionKind: 'completed' }, bindings: [{ state: 'accepted' }] })
  } finally { await runtime.close() }
}, 60000)
