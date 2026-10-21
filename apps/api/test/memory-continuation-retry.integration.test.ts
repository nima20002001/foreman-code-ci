import { expect, it } from 'vitest'
import { WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { memoryWorkflow, workflowMemory, type MemoryRuntime } from './helpers/memoryWorkflow.js'

it.runIf(postgresEnabled)('launches a technical retry of a review continuation on its existing card binding', async () => {
  const fixture = memoryWorkflow()
  fixture.version.definition.executionPolicy = { maxParallelism: 1, maxNodeExecutions: 5 }
  fixture.version.definition.nodes[0]!.choice = { outcomes: [{ outcome: 'review',
    target: { kind: 'edge', relationshipId: fixture.version.definition.edges[0]!.id } }] }
  let failedOnce = false
  const runtime: MemoryRuntime = await currentOperatorIntegration({ fixture, approvalNodeIds: [],
    outputFor: (_node, request) => {
      const input = WorkActivationInputSchema.parse(request.input)
      if (input.work.kind === 'work_request') return { routing: { kind: 'return',
        requestId: input.work.request.requestId, outcome: 'needs_changes' },
      data: { latestDeliverable: { revision: 1 }, remainingFindings: ['Correct the result'] } }
      return { routing: input.work.kind === 'entry' ? { kind: 'request', outcome: 'review' } : { kind: 'finish' },
        data: { latestDeliverable: { revision: 2 }, remainingFindings: [] } }
    },
    managerFactory: () => {
      const manager = runtime.provider.connection()
      let continuation = false
      return { ...manager, async createSession(input) {
        if (!isWorkflowStart(input)) throw new Error('Expected workflow session')
        continuation = WorkActivationInputSchema.parse(input.request.input).work.kind === 'work_return'
        return manager.createSession(input)
      }, async *startTurn(session, input) {
        for await (const event of manager.startTurn(session, input)) {
          yield event
          if (continuation && event.type === 'turn.started' && !failedOnce) {
            failedOnce = true
            throw new HarnessExecutionError('PROVIDER_TEMPORARILY_UNAVAILABLE', 'Transient provider interruption.', true)
          }
        }
      } }
    },
  })
  try {
    const memory = await workflowMemory(runtime)
    await runtime.engine.start(runtime.f.run.id)
    expect(failedOnce).toBe(true)
    const details = await runtime.runs.getDetails(memory.scope.workspaceId, runtime.f.run.id)
    expect(details?.run.outcome).toBe('succeeded')
    const attempts = details!.executions.filter(execution => WorkActivationInputSchema.parse(execution.input).work.kind === 'work_return')
      .sort((left, right) => left.attempt - right.attempt)
    expect(attempts.map(execution => execution.attempt)).toEqual([1, 2])
    expect(attempts[0]?.result).toMatchObject({ outcome: 'failed', error: { retryable: true } })
    expect(attempts[1]?.result?.outcome).toBe('succeeded')
    expect(attempts[1]?.input).toEqual(attempts[0]?.input)
    expect(await memory.read()).toMatchObject({ card: { status: 'done' },
      bindings: [{ state: 'accepted', currentExecutionId: attempts[1]!.id }] })
  } finally { await runtime.close() }
}, 60000)
