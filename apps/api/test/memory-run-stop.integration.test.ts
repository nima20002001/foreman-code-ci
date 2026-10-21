import { expect, it, vi } from 'vitest'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { memoryCall, memoryWorkflow, workflowMemory } from './helpers/memoryWorkflow.js'

it.runIf(postgresEnabled)('settles a parent binding when Stop cancels a waiting join before child execution admission', async () => {
  const fixture = memoryWorkflow('parallel')
  const unfinished = fixture.version.definition.nodes[2]!
  const join = fixture.version.definition.nodes[3]!
  fixture.version.approval = { handler: 'user' }
  fixture.version.definition.approval = fixture.version.approval
  fixture.run.approval = fixture.version.approval
  const runtime = await currentOperatorIntegration({ fixture, approvalNodeIds: [unfinished.id],
    outputFor: () => ({ routing: { kind: 'finish' }, data: { latestDeliverable: { text: 'Partial work' },
      remainingFindings: [] } }),
  })
  try {
    const memory = await workflowMemory(runtime, 1)
    await runtime.engine.start(runtime.f.run.id)
    const before = await runtime.runs.getDetails(memory.scope.workspaceId, runtime.f.run.id)
    expect(before?.run.executionState).toBe('waiting')
    expect(before?.executions.some(execution => execution.workflowNodeId === join.id)).toBe(false)
    const active = await memory.read()
    expect(active).toMatchObject({ card: { status: 'doing' }, bindings: [{ state: 'waiting_children' }] })
    await memoryCall(runtime.client, 'run_stop', { workspaceId: memory.scope.workspaceId, runId: runtime.f.run.id })
    await vi.waitFor(async () => expect((await runtime.runs.get(runtime.f.run.id))?.outcome).toBe('canceled'),
      { timeout: 30000, interval: 50 })
    expect(await memory.read()).toMatchObject({ card: { status: 'blocked', reason: expect.stringMatching(/\S/) },
      bindings: [{ state: 'canceled', reason: expect.stringMatching(/\S/) }] })
    const dropped = await memoryCall(runtime.client, 'memory_card_update', { kind: 'card_update',
      boardId: memory.boardId, cardId: memory.cardId, patch: { status: 'done', completionKind: 'dropped', reason: 'Stopped by the operator' } })
    expect(dropped).toMatchObject({ card: { status: 'done', completionKind: 'dropped' },
      bindings: [{ state: 'canceled', resolution: { kind: 'dropped' } }] })
    const late = await memoryCall(runtime.client, 'memory_card_create', { kind: 'card_create', boardId: memory.boardId,
      card: { title: 'Linked after Stop', body: '', status: 'doing', completionKind: null,
        reason: null, assignee: null, linkedNodes: [] },
      workSelections: [{ kind: 'current', work: (active.bindings as Array<{ work: unknown }>)[0]!.work }] })
    expect(late).toMatchObject({ card: { status: 'blocked' }, bindings: [{ state: 'canceled' }] })
  } finally { await runtime.close() }
}, 60000)
