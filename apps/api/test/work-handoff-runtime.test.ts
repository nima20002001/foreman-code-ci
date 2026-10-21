import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { executeRepeatRuntime, type RepeatRuntimeLifecycle } from '../src/modules/runs/repeatRuntime.js'

// Actual graph/runtime with deterministic repository and lifecycle ports.
// Persistence, native closure and MCP readback are covered in the SQL regression.
function fixture(code: string) {
  const base = makeCurrentWorkflowFixture('handoff-runtime', 'single')
  const version = WorkflowVersionV3Schema.parse({ ...base.version,
    definition: { ...base.version.definition, handoffs: { contractVersion: 1 } } })
  const node = version.definition.nodes[0]!
  if (node.kind === 'job') throw new Error('Agent fixture contains a Job')
  const execution = HarnessExecutionSchema.parse({ id: 'execution-runtime', runId: base.run.id,
    workflowNodeId: node.id, agentId: node.agentId,
    agentConfigurationVersionId: version.agentConfigurationVersionIds[node.agentId],
    attempt: 1, input: {}, state: 'completed', createdAt: base.createdAt, finishedAt: base.createdAt,
    result: { outcome: 'failed', error: { code: 'PROVIDER_FAILED', message: 'Failed.', retryable: false } },
  })
  const error = new DomainError(code, 'Handoff operation failed.', 409)
  const state = { executionState: 'running', failed: 0, canceled: 0, directionWaits: 0, candidates: 0 }
  const unavailable = async (): Promise<never> => { throw new Error('Unexpected repository operation') }
  const store: Parameters<typeof executeRepeatRuntime>[0]['store'] = {
    ensureWorkEntry: async () => 'activation-entry',
    admitWorkActivation: async () => ({ execution, reused: true }),
    acceptWorkTerminal: async () => { throw error },
    admit: unavailable, acceptTerminal: unavailable, enterBlock: unavailable, readOccurrence: unavailable,
    transition: unavailable, resolveExcluded: unavailable, completeRun: unavailable,
    admitWorkRequest: unavailable, returnWork: unavailable, recordWorkUnresolved: unavailable,
    resolveWaitingWorkJoins: async () => [],
    completeWorkRun: unavailable,
  }
  const lifecycle: RepeatRuntimeLifecycle = {
    preflight: async () => undefined, markRunning: async () => undefined,
    currentState: async () => ({ executionState: state.executionState, stopRequested: false }),
    persistWait: async () => false,
    persistDirectionWait: async () => { state.executionState = 'waiting'; state.directionWaits++ },
    requestCleanup: async () => undefined,
    cancelNativeAndRequestCleanup: async () => { state.canceled++; return true },
    settleRun: async () => { state.executionState = 'completed'; state.failed++ },
    finishNative: async () => undefined, finishCleanup: async () => undefined,
  }
  const saver = new MemorySaver()
  const execute = () => executeRepeatRuntime({ runId: base.run.id, version, store, lifecycle,
    owner: { assertOwned() {} }, signal: new AbortController().signal, checkpointer: saver,
    driver: { candidate: () => { state.candidates++; throw new Error('Replay allocated an execution') },
      observe: async () => undefined } })
  return { state, store, error, execute, execution }
}

describe('handoff runtime failure disposition', () => {
  it.each([
    'WORK_SELECTED_EXECUTION_FAILED', 'WORK_RUN_EXECUTION_BUDGET_EXHAUSTED',
    'WORK_REQUEST_ROUTE_FORBIDDEN', 'WORK_RETURN_ANCESTRY_CONFLICT', 'WORK_HANDOFF_DELIVERY_TOO_LARGE',
  ])('settles the permanent failure %s once across reconciliation', async (code) => {
    const f = fixture(code)
    await expect(f.execute()).rejects.toBe(f.error)
    expect(f.state).toMatchObject({ executionState: 'completed', failed: 1, canceled: 1, candidates: 0 })
    await expect(f.execute()).rejects.toBeInstanceOf(Error)
    expect(f.state.failed).toBe(1)
    expect(f.state.candidates).toBe(0)
  })

  it.each([
    'WORK_TERMINAL_PENDING', 'WORK_NEEDS_DIRECTION', 'NATIVE_SESSION_START_UNCERTAIN',
  ])('retains the recoverable disposition of %s', async (code) => {
    const f = fixture(code)
    await expect(f.execute()).rejects.toBe(f.error)
    expect(f.state).toMatchObject({ executionState: 'running', failed: 0, canceled: 0, candidates: 0 })
  })

  it('persists a direction wait when repository settlement reports unresolved work', async () => {
    const f = fixture('unused')
    f.store.acceptWorkTerminal = async () => ({ kind: 'accepted', replayed: true,
      execution: HarnessExecutionSchema.parse({ ...f.execution, result: { outcome: 'succeeded', output: {
        routing: { kind: 'finish' }, data: { latestDeliverable: { revision: 1 }, remainingFindings: [{ id: 'open' }] },
      } } }) })
    f.store.recordWorkUnresolved = async () => ({ unresolvedId: 'unresolved-work', replayed: true })
    f.store.completeWorkRun = async () => 'needs_direction'
    await f.execute()
    expect(f.state).toMatchObject({ executionState: 'waiting', failed: 0, directionWaits: 1, candidates: 0 })
    await f.execute()
    expect(f.state).toMatchObject({ executionState: 'waiting', failed: 0, directionWaits: 2, candidates: 0 })
  })

  it.each(['WORK_ACTIVATIONS_UNRESOLVED', 'WORK_REQUEST_UNRESOLVED', 'WORK_DENIAL_CONTINUATION_UNRESOLVED'])(
    'keeps the run open when completion is waiting on %s', async code => {
      const f = fixture(code)
      f.store.acceptWorkTerminal = async () => ({ kind: 'accepted', replayed: true,
        execution: HarnessExecutionSchema.parse({ ...f.execution, result: { outcome: 'succeeded', output: {
          routing: { kind: 'finish' }, data: { latestDeliverable: { revision: 1 }, remainingFindings: [] },
        } } }) })
      f.store.completeWorkRun = async () => { throw f.error }
      await expect(f.execute()).rejects.toBe(f.error)
      expect(f.state).toMatchObject({ executionState: 'running', failed: 0, canceled: 0, candidates: 0 })
    })
})
