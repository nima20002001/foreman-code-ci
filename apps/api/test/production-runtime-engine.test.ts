import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import type pg from 'pg'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { DurableInteraction, ExecutionResult } from '@foreman-code/contracts'
import type { GraphResumeClaim } from '../src/modules/interactions/deliveryPostgres.js'
import type { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import type { RepeatEngineStartContext } from '../src/modules/runs/repeatStartComposition.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'

// Engine REGISTRATION/fence tests with explicit recording ports. Actual graph
// progression lives in eng04-a1-engine-foundation.test.ts. Neither is PG/native proof.
const calls = vi.hoisted(() => ({ entries: [] as RepeatEngineStartContext[],
  work: undefined as undefined | ((context: RepeatEngineStartContext) => Promise<void>) }))
vi.mock('../src/modules/runs/repeatStartComposition.js', () => ({ executeRepeatEngineStart: async (context: RepeatEngineStartContext) => {
  calls.entries.push(context); await calls.work?.(context)
} }))

const checkpoints = vi.hoisted(() => ({ interrupted: false, delivered: false, consumed: false, stale: false, claim: undefined as GraphResumeClaim | undefined }))
vi.mock('../src/modules/runs/repeatGraph.js', () => ({ readWorkflowCheckpoint: async () => ({
  values: {}, tasks: checkpoints.interrupted ? [{ interrupts: [{}] }] : [],
}) }))
const lifecycleCalls = vi.hoisted(() => ({ settle: undefined as undefined | (() => void) }))
vi.mock('../src/modules/runs/workflowLifecycle.js', () => ({
  persistWorkflowApprovalWait: async () => [{ id: 'approval-a1', status: checkpoints.delivered ? 'delivered' : 'pending',
    deliveryState: checkpoints.delivered ? 'delivered' : 'pending' }],
  settleWorkflowRun: async () => lifecycleCalls.settle?.(),
  // Registration fixtures have no submitted executions requiring restart cleanup.
  settleWorkForRestart: async () => true,
}))
vi.mock('../src/modules/runs/approvalCheckpointResume.js', () => ({
  consumeDeliveredApprovals: async (_owner: unknown, _checkpointer: unknown, _interactions: unknown, _delivered: unknown, claim?: GraphResumeClaim) => {
    checkpoints.consumed = true; checkpoints.claim = claim; return checkpoints.stale ? undefined : {}
  },
}))
async function fixture(options: {
  form?: 'single' | 'parallel' | 'conditional' | 'approval' | 'repeat'
  maximumActiveRuns?: number
} = {}) {
  calls.entries = []; calls.work = undefined
  checkpoints.interrupted = false; checkpoints.delivered = false; checkpoints.consumed = false; checkpoints.stale = false; checkpoints.claim = undefined
  const f = makeCurrentWorkflowFixture('a1-engine-registration', options.form ?? 'single')
  const run = AcceptedWorkflowRunV3Schema.parse({ ...f.run, authorizationPrincipalId: 'principal-a1-engine',
    executionLocation: { runnerId: 'runner-a1-engine', rootPath: '/synthetic/a1-engine', locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` } })
  const state = { run, stopRequested: false, cleanupPending: false, owned: true, released: 0,
    factoryReads: 0, nativeCancel: 0, clean: true, events: [] as string[],
    cleanupFailure: undefined as ExecutionResult | undefined }
  const snapshot = () => ({ run: state.run, version: f.version, configurations: f.configurations,
    stopRequested: state.stopRequested, cleanupPending: state.cleanupPending })
  const connection = new ExclusiveGraphConnection({ query: async (text: string, values: unknown[]) => {
    const q = text.replace(/\s+/g, ' ').trim()
    assert.match(q, /select exists\(/)
    assert.match(q, /from execution_native_recoveries p join harness_executions e/)
    assert.match(q, /where e\.run_id=\$1\) as recovered/)
    assert.deepEqual(values, [run.id])
    // Registration-only fixtures have no recovered physical lifetime. This is
    // the diagnostic read, never a fabricated closure or settlement receipt.
    return { rows: [{ recovered: false }], rowCount: 1, command: 'SELECT', oid: 0, fields: [] }
  } } as unknown as pg.ClientBase, () => { if (!state.owned) throw new Error('owner-lost') })
  const owner = { runId: run.id, oneShotConnection: () => connection, assertOwned() { if (!state.owned) throw new Error('owner-lost') },
    release: async () => { state.released++; state.events.push('release') } } as unknown as RunOwnership
  const factory = {} as RepeatEngineStartContext['factory']
  const runs = {
    acquireOwnership: (async () => owner) as (runId: string, onLost: () => void) => Promise<RunOwnership | undefined>,
    getRepeatSnapshot: async () => {
      AcceptedWorkflowRunV3Schema.parse(state.run)
      return snapshot()
    }, repeatRepositoryFactory() { state.factoryReads++; return factory },
    get: async (runId: string) => { assert.equal(runId, run.id); return structuredClone(state.run) },
    requestCleanup: async (_id: string, _owner?: RunOwnership, failure?: ExecutionResult) => {
      state.cleanupFailure ??= failure
      state.cleanupPending = true
      state.events.push('request-cleanup')
    },
    finishCleanup: async (_id: string, failed: boolean) => { state.cleanupPending = failed; state.events.push('finish-cleanup') },
    reconciliationCandidates: async () => [state.run] }
  const terminal = () => { state.run = { ...state.run, executionState: 'completed', outcome: 'canceled',
    result: { outcome: 'canceled' }, finishedAt: f.createdAt } }
  lifecycleCalls.settle = () => {
    state.events.push('settle')
    terminal()
    if (state.cleanupFailure) state.run = { ...state.run, outcome: 'failed', result: state.cleanupFailure }
  }
  const stopSharingOwner = vi.fn()
  let nativeOwner: RunOwnership | undefined
  const native = { shareRunOwner: vi.fn(() => stopSharingOwner),
    adoptRunOwner: (actual: RunOwnership) => { actual.assertOwned(); nativeOwner = actual },
    preserveActiveForRestart: async () => false,
    cancelRun: async () => { state.nativeCancel++; if (!state.clean) throw new Error('native closure uncertain') },
    finishRun: async () => { assert.equal(nativeOwner, owner); state.events.push('finish-native') },
    nativeBoundaryEvidence: async () => { throw new Error('No fake native evidence in registration tests') },
    closeForRestart: async () => { state.events.push('restart-close') }, reconcileReviews: async () => undefined, requestColdRunCleanup: async () => false }
  const { LangGraphWorkflowEngine: Engine } = await import('../src/modules/runs/engine.js')
  type Args = ConstructorParameters<typeof LangGraphWorkflowEngine>
  const engine = new Engine(runs as unknown as Args[0], {
    getVersion: async (versionId: string) => { assert.equal(versionId, f.version.id); return f.version },
  } as unknown as Args[1], native as unknown as Args[2], {} as Args[3],
    '/synthetic/a1-engine', {} as Args[5], {} as Args[6], {} as Args[7],
    async () => { state.events.push('terminal-notification') }, {
      workerParallelism: 2,
      ...(options.maximumActiveRuns ? { maximumActiveRuns: options.maximumActiveRuns } : {}),
    })
  return { f, run, state, owner, native, runs, engine, factory, terminal, stopSharingOwner }
}

test('reconciliation leaves a Run owned by another engine alone', async () => {
  const h = await fixture()
  vi.spyOn(h.runs, 'acquireOwnership').mockResolvedValue(undefined)
  await h.engine.reconcile(error => { throw error })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(h.state.nativeCancel, 0)
  assert.equal(h.state.released, 0)
})

test('backs off failed reconciliation, caps the delay, and clears it after recovery', async () => {
  const h = await fixture()
  let now = 0
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const failure = new Error('Native closure unconfirmed')
  const acquire = vi.spyOn(h.runs, 'acquireOwnership').mockRejectedValue(failure)
  const errors: unknown[] = []
  const reconcile = async () => {
    await h.engine.reconcile(error => errors.push(error))
    await new Promise(resolve => setImmediate(resolve))
  }
  try {
    for (const delay of [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000]) {
      await reconcile()
      const attempts = acquire.mock.calls.length
      now += delay - 1
      await reconcile()
      assert.equal(acquire.mock.calls.length, attempts)
      now++
    }
    assert.equal(errors.length, 8)
    acquire.mockResolvedValue(h.owner)
    await reconcile()
    assert.equal(calls.entries.length, 1)
    // A successful recovery removes the delay for the next eligible pass.
    await reconcile()
    assert.equal(calls.entries.length, 2)
  } finally { clock.mockRestore() }
})

test('leaves capacity for later Runs while an earlier cleanup is backing off', async () => {
  const h = await fixture({ maximumActiveRuns: 1 })
  h.runs.reconciliationCandidates = async () => [
    h.state.run, { ...h.state.run, id: `${h.run.id}-later` },
  ]
  const acquire = vi.spyOn(h.runs, 'acquireOwnership')
    .mockRejectedValueOnce(new Error('Native closure unconfirmed'))
    .mockResolvedValue(undefined)
  const errors: unknown[] = []
  await h.engine.reconcile(error => errors.push(error))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(acquire.mock.calls.length, 1)
  await h.engine.reconcile(error => errors.push(error))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(acquire.mock.calls.length, 2)
  assert.equal(acquire.mock.calls[1]![0], `${h.run.id}-later`)
  assert.equal(errors.length, 1)
})

for (const form of ['single', 'parallel', 'conditional', 'approval', 'repeat'] as const) test(`ENG04 A1 engine ${form}: the same owner/gate/composition entry`, async () => {
  const h = await fixture({ form })
  await h.engine.start(h.run.id)
  assert.equal(calls.entries.length, 1); assert.equal(calls.entries[0]!.owner, h.owner)
  assert.equal(calls.entries[0]!.factory, h.factory)
  assert.equal(calls.entries[0]!.configuredParallelism, 2); assert.equal(h.state.released, 1)
  await assert.rejects(calls.entries[0]!.nativeBoundaryEvidence('synthetic-execution'), /No fake native evidence/)
})

test('ENG04 A1 simultaneous Start notifications allocate only one owner/runtime task', async () => {
  const h = await fixture(); let release!: () => void
  const barrier = new Promise<void>((done) => { release = done })
  calls.work = async () => barrier
  const one = h.engine.start(h.run.id), two = h.engine.start(h.run.id)
  assert.equal(one, two); release(); await one
  assert.equal(calls.entries.length, 1); assert.equal(h.state.released, 1)
})

test('publishes the acquired Run owner to native managers before awaiting its snapshot', async () => {
  const h = await fixture()
  const snapshot = h.runs.getRepeatSnapshot
  h.runs.getRepeatSnapshot = async () => {
    assert.deepEqual(h.native.shareRunOwner.mock.calls, [[h.owner]])
    assert.equal(h.stopSharingOwner.mock.calls.length, 0)
    return snapshot()
  }
  await h.engine.start(h.run.id)
  assert.equal(h.stopSharingOwner.mock.calls.length, 1)
  assert.equal(h.state.released, 1)
})

test('stops sharing the engine owner before releasing a failed drive', async () => {
  const h = await fixture()
  const failure = new Error('Snapshot unavailable')
  h.runs.getRepeatSnapshot = async () => { throw failure }
  const release = h.owner.release.bind(h.owner)
  vi.spyOn(h.owner, 'release').mockImplementation(async () => {
    assert.equal(h.stopSharingOwner.mock.calls.length, 1)
    await release()
  })
  await assert.rejects(h.engine.start(h.run.id), error => error === failure)
  assert.equal(h.state.released, 1)
})

test('reconciliation defers a Run held by its reviewer and starts it after the owner is released', async () => {
  const h = await fixture()
  const acquire = vi.spyOn(h.runs, 'acquireOwnership').mockResolvedValueOnce(undefined)
  const errors: unknown[] = []
  await h.engine.reconcile(error => errors.push(error))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(acquire.mock.calls.length, 1)
  assert.equal(calls.entries.length, 0)
  assert.equal(errors.length, 0)

  await h.engine.reconcile(error => errors.push(error))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.entries.length, 1)
  assert.equal(h.state.released, 1)
  assert.equal(errors.length, 0)
})

test('reconciliation still reports ownership query failures', async () => {
  const h = await fixture()
  const failure = new Error('database disconnected')
  vi.spyOn(h.runs, 'acquireOwnership').mockRejectedValueOnce(failure)
  const errors: unknown[] = []
  await h.engine.reconcile(error => errors.push(error))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(errors, [failure])
  assert.equal(calls.entries.length, 0)
})

test('ENG04 A1 cold running recovery uses the same gate but requires authoritative continuation', async () => {
  const h = await fixture(); await h.engine.start(h.run.id)
  const gate = calls.entries[0]!.admission
  h.state.run = { ...h.run, executionState: 'running', startedAt: h.f.createdAt }
  await h.engine.resume(h.run.id)
  assert.equal(calls.entries.length, 2)
  assert.equal(calls.entries[1]!.admission, gate)
})

test('ENG04 A1 approval notices require a delivered current checkpoint', async () => {
  const h = await fixture(); h.state.run = { ...h.run, executionState: 'waiting' }; checkpoints.interrupted = true
  const interaction = { id: 'approval-a1', runId: h.run.id, graphThreadId: h.run.id } as DurableInteraction
  const claim = { id: 'claim-a1' } as unknown as GraphResumeClaim
  await h.engine.resumeInteraction(interaction, claim)
  assert.equal(calls.entries.length, 0); assert.equal(checkpoints.consumed, false)
  checkpoints.delivered = true; checkpoints.stale = true
  await h.engine.resumeInteraction(interaction, claim)
  assert.equal(calls.entries.length, 0); assert.equal(checkpoints.claim, claim)
  checkpoints.stale = false
  await h.engine.resumeInteraction(interaction, claim)
  assert.equal(calls.entries.length, 1); assert.equal(checkpoints.consumed, true)
  await assert.rejects(h.engine.resumeInteraction({ ...interaction, graphThreadId: 'another-run' }), { code: 'INTERACTION_RUN_MISMATCH' })
})

test('ENG04 A1 cancellation requires a committed authorized Stop before any native action', async () => {
  const h = await fixture()
  await assert.rejects(h.engine.cancel(h.run.id), { code: 'REPEAT_STOP_AUTHORIZATION_REQUIRED' })
  assert.equal(h.state.nativeCancel, 0)
  h.state.stopRequested = true
  assert.equal(await h.engine.cancel(h.run.id), true)
  assert.equal(h.state.nativeCancel, 2); assert.equal(h.state.cleanupPending, false)
  assert(h.state.events.indexOf('settle') < h.state.events.indexOf('finish-cleanup'))
})

test('ENG04 A1 uncertain native cleanup retains intent and cannot report stopped-and-settled', async () => {
  const h = await fixture(); h.state.stopRequested = true; h.state.clean = false
  await assert.rejects(h.engine.cancel(h.run.id), /native closure uncertain/)
  assert.equal(h.state.cleanupPending, true)
})

test('ENG04 A1 terminal notifications finish exact lifecycle, never re-enter graph execution', async () => {
  const h = await fixture(); h.terminal()
  await h.engine.start(h.run.id)
  assert.equal(calls.entries.length, 0)
  assert(h.state.events.includes('finish-native')); assert(h.state.events.includes('terminal-notification'))
  assert.equal(h.state.cleanupPending, false)
})

test('ENG04 A1 owner loss blocks factory/runtime without creating fallback work', async () => {
  const h = await fixture(); h.state.owned = false
  await assert.rejects(h.engine.start(h.run.id), /owner-lost/)
  assert.equal(h.state.factoryReads, 1); assert.equal(calls.entries.length, 0)
})

test('restart waits for captured native closure and drains tasks without synthetic Stop', async () => {
  const h = await fixture(); let entered!: () => void, closed!: () => void
  const started = new Promise<void>((done) => { entered = done }), closure = new Promise<void>((done) => { closed = done })
  h.native.closeForRestart = async () => {
    h.state.events.push('restart-close-start')
    await closure
    h.state.events.push('restart-close')
  }
  calls.work = async (context) => {
    entered()
    await new Promise<void>((_resolve, reject) => context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true }))
  }
  const active = h.engine.start(h.run.id)
  void active.catch(() => { /* ignore: the restart below aborts this start on purpose; engine events carry the assertion */ })
  await started; const shutdown = h.engine.shutdown()
  await vi.waitFor(() => assert(h.state.events.includes('restart-close-start')))
  assert.equal(h.state.released, 0)
  assert.equal(h.state.stopRequested, false)
  assert.equal(h.state.cleanupPending, false)
  closed(); await shutdown; await assert.rejects(active, { code: 'ENGINE_RESTART' })
  assert.equal(h.state.released, 1); assert.equal(h.state.stopRequested, false)
  assert(h.state.events.indexOf('restart-close') < h.state.events.indexOf('release'))
  assert.equal(h.state.nativeCancel, 0)
  assert(!h.state.events.includes('request-cleanup'))
  assert(!h.state.events.includes('settle')); assert(!h.state.events.includes('finish-cleanup'))
  await assert.rejects(h.engine.start(h.run.id), { code: 'ENGINE_CLOSING' })
})

test('current engine rejects incomplete composition at construction', async () => {
  const { LangGraphWorkflowEngine: Engine } = await import('../src/modules/runs/engine.js')
  const runs = { repeatRepositoryFactory: () => ({}) }
  assert.throws(() => Reflect.construct(Engine, [runs, {}, {}, {}, '/synthetic/runtime', {}, {}, undefined]),
    { code: 'WORKFLOW_RUNTIME_COMPOSITION_REQUIRED' })
})
