import assert from 'node:assert/strict'
import { describe, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { readWorkflowClosure } from '../src/modules/interactions/workflowClosure.js'
import { currentRestartUnit } from './helpers/currentRestartUnit.js'
import { recoveryDatabase, recoveryExecution } from './helpers/eng06Recovery.testSupport.js'

type CoordinatorArgs = ConstructorParameters<typeof ApprovalExecutionCoordinator>

function fixture(options: Parameters<typeof recoveryDatabase>[0] = {}) {
  const db = recoveryDatabase(options), calls: string[] = []
  const recovery = { available: true }
  const snapshot = { run: { id: db.owner.runId, executionState: 'running', outcome: 'pending' },
    version: { definition: {} }, cleanupPending: false, stopRequested: false }
  const runs = {
    repeatRepositoryFactory: () => ({}),
    getExecution: async () => db.state.execution,
    getExecutionConfiguration: async () => AgentConfigurationVersionSchema.parse({
      id: db.state.execution.agentConfigurationVersionId, agentId: db.state.execution.agentId,
      workspaceId: 'workspace', version: 1, productRole: 'orchestrator',
      harness: DEFAULT_HARNESS_DEFAULTS.codex, prompt: {}, assignedSkills: [],
      contentHash: 'sha256:recovery-fixture', createdAt: db.state.execution.createdAt,
    }),
    getRepeatSnapshot: async () => structuredClone(snapshot),
    requestCleanup: async () => { calls.push('request-cleanup'); db.state.fenced = true; snapshot.cleanupPending = true },
    async *executionPages() { yield structuredClone([db.state.execution, ...db.state.others.values()]) },
    repeat: async () => ({ settleNegativeExecution: async (id: string, canceled: boolean) => {
      const execution = id === db.state.execution.id ? db.state.execution : db.state.others.get(id)
      assert.ok(execution)
      if (execution.nativeSessionId) assert.ok(await readWorkflowClosure(db.connection, db.state.execution), 'settlement cannot precede closure')
      calls.push(canceled ? 'settle-canceled' : 'settle-interrupted')
    } }),
    acquireOwnership: async () => db.owner,
    readOutputSettlement: async () => undefined,
  }
  const interactions = { coordination: { finishStoppedReviews: async () => {
    assert.ok(await readWorkflowClosure(db.connection, db.state.execution), 'retirement cannot precede closure')
    calls.push('retire-reviews')
  } }, cancelPendingForRun: async () => { calls.push('cancel-interactions'); return 1 } }
  const manager = { resolve: () => { calls.push('resolve'); throw new Error('Cold native allocation is forbidden') } }
  const coordinator = new ApprovalExecutionCoordinator(runs as unknown as CoordinatorArgs[0],
    interactions as unknown as CoordinatorArgs[1], { stop: async () => { calls.push('stop-budget') } } as unknown as CoordinatorArgs[2],
    manager as unknown as CoordinatorArgs[3], 5_000,
    { revokeForExecution: async () => { calls.push('revoke-credential') } } as unknown as CoordinatorArgs[5],
    undefined, { read: (execution) => readWorkflowClosure(db.connection, execution) } as CoordinatorArgs[7], undefined, undefined, undefined,
    async (id) => {
      if (!recovery.available) return false
      assert.equal(id, db.state.execution.id); assert.equal(db.state.active, false); calls.push('close-processes'); return true
    })
  // The SQL double cannot run real attempt settlement; record the per-attempt decision instead.
  vi.spyOn(coordinator, 'abandonAttempt').mockImplementation(async (_owner, execution, failure) => {
    calls.push(`abandon:${execution.id}:${failure.outcome === 'failed' ? failure.error?.code : failure.outcome}`)
  })
  return { ...db, calls, runs, snapshot, coordinator, recovery }
}

describe('ENG06-A cold Run and Stop orchestration', () => {
  it('abandons an interrupted requester attempt alone before recovering an earlier completed reviewer', async () => {
    const f = fixture()
    f.state.execution = recoveryExecution('completed')
    f.state.fenced = false
    const requester = recoveryExecution('starting')
    requester.id = 'interrupted-requester'
    delete requester.nativeSessionId
    f.state.others.set(requester.id, requester)
    const original = structuredClone(f.state.execution)
    try {
      await f.coordinator.requestColdRunCleanup(f.owner)
      assert.equal(f.calls[0], 'abandon:interrupted-requester:EXECUTION_INTERRUPTED')
      assert.ok(!f.calls.includes('request-cleanup'))
      assert.deepEqual(f.state.execution, original)
      assert.equal(f.snapshot.cleanupPending, false)
    } finally {
      await f.owner.release()
    }
  })

  it('leaves a running restart-detached turn available for original-result recovery', async () => {
    const f = fixture({ detached: true })
    f.state.fenced = false
    const original = structuredClone(f.state.execution)
    try {
      assert.equal(await f.coordinator.requestColdRunCleanup(f.owner), false)
      assert.deepEqual(f.state.execution, original)
      assert.deepEqual(f.calls, [])
      assert.equal(f.snapshot.cleanupPending, false)
      assert.equal(f.state.proof, undefined)
    } finally { await f.owner.release() }
  })

  for (const unavailable of ['closed', 'finalized', 'fenced'] as const) {
    it(`abandons rather than recovers a running detached turn whose lifetime is ${unavailable}`, async () => {
      const f = fixture({ detached: true, closed: unavailable === 'closed' })
      f.state.fenced = unavailable === 'fenced'
      f.state.finalized = unavailable === 'finalized'
      try {
        assert.equal(await f.coordinator.requestColdRunCleanup(f.owner), false)
        assert.deepEqual(f.calls, [`abandon:${f.state.execution.id}:EXECUTION_INTERRUPTED`])
        assert.equal(f.state.proof, undefined)
      } finally { await f.owner.release() }
    })
  }

  it('rejects a running detached turn whose saved session changed before recovery', async () => {
    const f = fixture({ detached: true })
    f.state.fenced = false
    f.state.session!.nativeSessionId = 'replacement-session'
    try {
      await assert.rejects(f.coordinator.requestColdRunCleanup(f.owner), { code: 'NATIVE_WORKFLOW_CLOSURE_CONFLICT' })
      assert.deepEqual(f.calls, [])
      assert.equal(f.snapshot.cleanupPending, false)
    } finally { await f.owner.release() }
  })

  for (const state of ['starting', 'running'] as const) it(`abandons a cold ${state} attempt alone so its node retries`, async () => {
    const f = fixture(); f.state.execution.state = state; f.state.fenced = false
    assert.equal(await f.coordinator.requestColdRunCleanup(f.owner), false)
    assert.deepEqual(f.calls, [`abandon:${f.state.execution.id}:EXECUTION_INTERRUPTED`])
    assert.equal(f.snapshot.cleanupPending, false)
    await f.owner.release()
  })

  it('fences a cold waiting execution before reentry', async () => {
    const f = fixture(); f.state.execution.state = 'waiting'; f.state.fenced = false
    assert.equal(await f.coordinator.requestColdRunCleanup(f.owner), true)
    assert.deepEqual(f.calls, ['request-cleanup']); assert.equal(f.snapshot.cleanupPending, true)
    await f.owner.release()
  })

  for (const state of ['queued', 'completed'] as const) it(`does not reinterpret ${state} execution absence as death`, async () => {
    const f = fixture({ closed: true }); f.state.execution = recoveryExecution(state)
    if (state === 'queued') delete f.state.execution.nativeSessionId
    assert.equal(await f.coordinator.requestColdRunCleanup(f.owner), false)
    assert.deepEqual(f.calls, [])
    await f.owner.release()
  })

  it('recovers physical lifetime without poisoning a completed result with a Run cleanup intent', async () => {
    const f = fixture({ detached: true }); f.state.execution = recoveryExecution('completed'); f.state.fenced = false
    const original = structuredClone(f.state.execution)
    assert.equal(await f.coordinator.requestColdRunCleanup(f.owner), false)
    assert.deepEqual(f.state.execution, original)
    assert.deepEqual(f.calls, ['close-processes'])
    assert.equal(f.snapshot.cleanupPending, false)
    assert.ok(await readWorkflowClosure(f.connection, original))
    await f.owner.release()
  })

  it('leaves a completed terminal uncertain, not failed, when registry evidence is absent', async () => {
    const f = fixture(); f.state.execution = recoveryExecution('completed'); f.state.fenced = false
    const original = structuredClone(f.state.execution)
    f.recovery.available = false
    await assert.rejects(f.coordinator.requestColdRunCleanup(f.owner), AggregateError)
    assert.deepEqual(f.state.execution, original)
    assert.deepEqual(f.calls, [])
    assert.equal(f.snapshot.cleanupPending, false)
    assert.equal(f.state.proof, undefined)
    await f.owner.release()
  })

  for (const detached of [false, true]) it(`fences a cold finalized reviewer (${detached ? 'detached' : 'crashed'}) before physical recovery`, async () => {
    const f = fixture({ detached }); f.state.execution = recoveryExecution('completed')
    f.state.finalized = true; f.state.fenced = false
    const original = structuredClone(f.state.execution)
    try {
      // workflow_finalized_at separates a later reviewer from the original
      // terminal-before-close cut. Selection cannot itself produce a receipt.
      assert.equal(await f.coordinator.requestColdRunCleanup(f.owner), true)
      assert.deepEqual(f.calls, ['request-cleanup'])
      assert.equal(f.snapshot.cleanupPending, true)
      assert.equal(f.state.proof, undefined)
      assert.deepEqual(f.state.execution, original)
      f.recovery.available = false
      await assert.rejects(f.coordinator.cancelRun(f.owner.runId, f.owner), AggregateError)
      assert.equal(f.state.proof, undefined)
      assert.equal(f.calls.includes('retire-reviews'), false)
      assert.equal(f.calls.includes('settle-interrupted'), false)
      f.recovery.available = true
      await f.coordinator.cancelRun(f.owner.runId, f.owner)
      assert.ok(await readWorkflowClosure(f.connection, original))
      assert.ok(f.calls.indexOf('retire-reviews') > f.calls.indexOf('close-processes'))
      assert.ok(f.calls.indexOf('settle-interrupted') > f.calls.indexOf('retire-reviews'))
      assert.deepEqual(f.state.execution, original)
      assert.equal(f.calls.includes('resolve'), false)
    } finally { await f.owner.release() }
  })

  it('does not select reviewer cleanup from a mismatched session', async () => {
    const f = fixture(); f.state.execution = recoveryExecution('completed')
    f.state.finalized = true; f.state.fenced = false
    f.state.session!.nativeSessionId = 'replacement-session'
    try {
      await assert.rejects(f.coordinator.requestColdRunCleanup(f.owner), { code: 'NATIVE_SESSION_IDENTITY_MISMATCH' })
      assert.deepEqual(f.calls, [])
      assert.equal(f.snapshot.cleanupPending, false)
      assert.equal(f.state.proof, undefined)
    } finally { await f.owner.release() }
  })

  it('leaves a genuine in-process approval owner available for normal delivery', async () => {
    const f = currentRestartUnit()
    const instance = f.cold()
    try {
      await instance.attachOriginal()
      assert.equal(await instance.coordinator.requestColdRunCleanup(f.owner), false)
      assert.equal(f.state.cleanup, false)
      assert.equal(f.state.creates, 0)
      assert.equal(f.state.turns, 0)
    } finally { await f.connection.close() }
  })

  it('blocks the delivery reconciler from allocating a cold requester before the Run recovery scan', async () => {
    const f = fixture(); f.state.execution.state = 'waiting'
    await assert.rejects(f.coordinator.attachOwnedSession({ executionId: f.state.execution.id,
      agentId: f.state.execution.agentId, harness: 'codex', workingDirectory: f.state.execution.workingDirectory! },
    f.state.session!), { code: 'NATIVE_SESSION_RECOVERY_REQUIRED' })
    assert.deepEqual(f.calls, [])
    assert.equal(await f.coordinator.requestColdRunCleanup(f.owner), true)
    await f.owner.release()
  })

  it('orders cold Stop closure before review retirement and negative attempt settlement; repeats without new native work', async () => {
    const f = fixture({ detached: true }); f.snapshot.stopRequested = true
    await f.coordinator.cancelRun(f.owner.runId, f.owner)
    assert.deepEqual(f.calls, ['cancel-interactions', 'revoke-credential', 'stop-budget',
      'close-processes', 'retire-reviews', 'settle-canceled'])
    await f.coordinator.cancelRun(f.owner.runId, f.owner)
    assert.equal(f.calls.filter((call) => call === 'close-processes').length, 1)
    assert.equal(f.state.inserts, 1); assert.equal(f.calls.includes('resolve'), false)
    await f.owner.release()
  })

  it('settles an ordinary sequential two-node admission without starting the second node', async () => {
    const f = fixture()
    const next = recoveryExecution('queued')
    Object.assign(next, { id: 'execution-b', workflowNodeId: 'node-b', runtimeDirectory: '/runtime/execution-b' })
    delete next.nativeSessionId
    f.state.others.set(next.id, next)
    const pins = structuredClone([f.state.execution.input, next.input])
    await f.runs.requestCleanup()
    await f.coordinator.cancelRun(f.owner.runId, f.owner)
    assert.equal(f.calls.filter((call) => call === 'close-processes').length, 1)
    assert.equal(f.calls.filter((call) => call === 'settle-interrupted').length, 2)
    assert.equal(f.calls.includes('resolve'), false)
    assert.deepEqual([f.state.execution.input, next.input], pins)
    assert.equal(f.state.inserts, 1, 'queued sibling must not acquire a native lifetime receipt')
    await f.owner.release()
  })

  it('does not let the ownerless early Stop pass mint a durable recovery receipt', async () => {
    const f = fixture(); f.snapshot.stopRequested = true
    await f.coordinator.cancelRun(f.owner.runId)
    assert.deepEqual(f.calls, ['cancel-interactions', 'revoke-credential', 'stop-budget'])
    assert.equal(f.state.proof, undefined)
    await f.owner.release()
  })

  it('keeps uncertainty retryable without settling or retiring when physical evidence is unavailable', async () => {
    const f = fixture(); f.snapshot.cleanupPending = true
    const internals = f.coordinator as unknown as { recoverNativeProcesses: () => Promise<boolean> }
    internals.recoverNativeProcesses = async () => false
    await assert.rejects(f.coordinator.cancelRun(f.owner.runId, f.owner), AggregateError)
    assert.equal(f.state.proof, undefined)
    assert.equal(f.calls.includes('retire-reviews'), false); assert.equal(f.calls.includes('settle-interrupted'), false)
    internals.recoverNativeProcesses = async () => true
    await f.coordinator.cancelRun(f.owner.runId, f.owner)
    assert.equal(f.calls.at(-1), 'settle-interrupted')
    await f.owner.release()
  })

})
