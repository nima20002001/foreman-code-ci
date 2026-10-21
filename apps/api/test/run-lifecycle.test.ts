import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { Command, GraphInterrupt, MemorySaver, interrupt } from '@langchain/langgraph'
import { DurableInteractionSchema, NATIVE_INTERACTION_FIXTURES, type DurableInteraction } from '@foreman-code/contracts'
import { it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { LangGraphWorkflowEngine } from '../src/modules/runs/engine.js'
import { PostgresRunRepository } from '../src/modules/runs/postgres.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import type { RepeatEngineStartContext } from '../src/modules/runs/repeatStartComposition.js'
import { buildRepeatGraph, readWorkflowCheckpoint, type RepeatCheckpoint } from '../src/modules/runs/repeatGraph.js'
import { executeRepeatRuntime } from '../src/modules/runs/repeatRuntime.js'
import { compileRepeatLayout } from '../src/modules/runs/repeatResolution.js'
import { currentUnitSnapshot } from './helpers/currentUnitSnapshot.js'
import { syntheticCurrentWorkflow } from './helpers/currentSynthetic.js'
import { deferred } from './helpers/deferred.js'

type EngineArguments = ConstructorParameters<typeof LangGraphWorkflowEngine>
type Internals = {
  activeRuns: Map<string, AbortController>
  activeTasks: Map<string, Promise<void>>
  resumeTasks: Map<string, Promise<void>>
}
interface EnginePorts {
  read(): Promise<RepeatCheckpoint>
  wait(checkpoint: RepeatCheckpoint): Promise<DurableInteraction[]>
  consume(items: readonly DurableInteraction[]): Promise<object | undefined>
  enter(context: RepeatEngineStartContext): Promise<void>
  settle(): Promise<boolean>
  settleForRestart(): Promise<boolean>
}
const ports = vi.hoisted(() => ({ owners: new WeakMap<object, EnginePorts>(), savers: new WeakMap<object, EnginePorts>() }))
// Real engine scheduling/ownership, recording SQL-composition ports. Never patch
// removed buildGraph/executeNode methods. The actual common graph/runtime is used
// separately below; these ports do not claim PostgreSQL or native qualification.
vi.mock('../src/modules/runs/repeatStartComposition.js', async (original) => ({
  ...await original<typeof import('../src/modules/runs/repeatStartComposition.js')>(),
  executeRepeatEngineStart: async (context: RepeatEngineStartContext) => {
    const host = ports.owners.get(context.owner); assert.ok(host); await host.enter(context)
  },
}))
vi.mock('../src/modules/runs/repeatGraph.js', async (original) => {
  const actual = await original<typeof import('../src/modules/runs/repeatGraph.js')>()
  return { ...actual, readWorkflowCheckpoint: (...args: Parameters<typeof actual.readWorkflowCheckpoint>) => {
    const host = ports.savers.get(args[2]); return host ? host.read() : actual.readWorkflowCheckpoint(...args)
  } }
})
vi.mock('../src/modules/runs/workflowLifecycle.js', async (original) => ({
  ...await original<typeof import('../src/modules/runs/workflowLifecycle.js')>(),
  persistWorkflowApprovalWait: async (owner: RunOwnership, _saver: unknown, checkpoint: RepeatCheckpoint) => {
    const host = ports.owners.get(owner); assert.ok(host); return host.wait(checkpoint)
  },
  settleWorkflowRun: async (owner: RunOwnership) => {
    const host = ports.owners.get(owner); assert.ok(host); return host.settle()
  },
  settleWorkForRestart: async (owner: RunOwnership) => {
    owner.assertOwned()
    const host = ports.owners.get(owner)
    assert.ok(host)
    return host.settleForRestart()
  },
}))
vi.mock('../src/modules/runs/approvalCheckpointResume.js', async (original) => ({
  ...await original<typeof import('../src/modules/runs/approvalCheckpointResume.js')>(),
  consumeDeliveredApprovals: async (owner: RunOwnership, _saver: unknown, _repository: unknown, items: DurableInteraction[]) => {
    const host = ports.owners.get(owner); assert.ok(host); return host.consume(items)
  },
}))
function fixture() {
  const f = currentUnitSnapshot('run-lifecycle', 'parallel'), saver = new MemorySaver()
  const run = { ...f.run, executionState: 'waiting' as typeof f.run.executionState }
  const items = new Map<string, DurableInteraction>()
  const calls = { entries: [] as RepeatEngineStartContext[], consumed: [] as string[][], bound: [] as string[],
    cancel: 0, finish: 0, settled: 0, owners: 0, peakOwners: 0, releases: 0, factory: 0 }
  const control = {
    checkpoint: { values: { runId: run.id }, next: [], tasks: [] } as RepeatCheckpoint,
    stopRequested: false, cleanupPending: false,
    read: async (): Promise<RepeatCheckpoint> => structuredClone(control.checkpoint),
    work: async (_context: RepeatEngineStartContext): Promise<void> => { void _context; throw new Error('Unexpected runtime entry') },
    waitFailure: undefined as Error | undefined,
  }
  const host: EnginePorts = {
    read: () => control.read(),
    wait: async (checkpoint) => {
      if (control.waitFailure) throw control.waitFailure
      assert.equal(checkpoint.values.runId, run.id)
      const current: DurableInteraction[] = []
      for (const task of checkpoint.tasks) for (const pending of task.interrupts ?? []) {
        const id = (pending.value as { interactionId: string }).interactionId
        const item = items.get(id); assert.ok(item, 'only the current saved interrupt is a fixture binding')
        if (!item.graphInterruptId) { item.graphInterruptId = pending.id; calls.bound.push(pending.id) }
        current.push(structuredClone(item))
      }
      run.executionState = 'waiting'
      return current
    },
    consume: async (current) => {
      assert.ok(current.length)
      for (const item of current) {
        assert.equal(item.status, 'delivered'); assert.equal(item.deliveryState, 'delivered')
        assert.equal(item.graphInterruptId, items.get(item.id)?.graphInterruptId)
      }
      calls.consumed.push(current.map((item) => item.id))
      const ids = new Set(current.map((item) => item.id))
      // Explicit checkpoint-consumer port; not native ACK evidence. Production
      // atomic receipt/claim tests live in wave25-r1-checkpoint.integration.test.ts.
      control.checkpoint.tasks = control.checkpoint.tasks.filter((task) =>
        !task.interrupts?.some((pending) => ids.has((pending.value as { interactionId: string }).interactionId)))
      control.checkpoint.next = control.checkpoint.tasks.map((task) => task.name)
      run.executionState = 'running'
      return {}
    },
    enter: async (context) => { calls.entries.push(context); await control.work(context) },
    // Active fixture work requires restart cleanup rather than being preserved as settled.
    settleForRestart: async () => false,
    settle: async () => {
      assert.ok(control.stopRequested || control.cleanupPending)
      calls.settled++
      Object.assign(run, { executionState: 'completed', outcome: control.stopRequested ? 'canceled' : 'failed' })
      return true
    },
  }
  ports.savers.set(saver, host)
  const factory = {} as RepeatEngineStartContext['factory']
  const runs = {
    repeatRepositoryFactory: () => { calls.factory++; return factory },
    get: async (runId: string) => { assert.equal(runId, run.id); return structuredClone(run) },
    acquireOwnership: async () => {
      assert.equal(calls.owners, 0, 'another resume must not overwrite the current owner')
      calls.owners++; calls.peakOwners = Math.max(calls.peakOwners, calls.owners)
      let released = false
      const owner = { runId: run.id, client: {}, assertOwned() { assert.equal(released, false) },
        async release() { assert.equal(released, false); released = true; calls.owners--; calls.releases++ } }
      ports.owners.set(owner, host)
      return owner
    },
    getRepeatSnapshot: async () => ({ run: structuredClone(run), version: f.version, configurations: f.configurations,
      stopRequested: control.stopRequested, cleanupPending: control.cleanupPending }),
    reconciliationCandidates: async () => [structuredClone(run)],
    updateState: async (_id: string, update: Partial<typeof run>) => { Object.assign(run, update) },
    requestCleanup: async () => { control.cleanupPending = true },
    finishCleanup: async (_id: string, pending: boolean) => { control.cleanupPending = pending },
  }
  const native = { adoptRunOwner: () => undefined, shareRunOwner: () => () => {}, cancelRun: async () => { calls.cancel++ }, finishRun: async () => { calls.finish++ },
    preserveActiveForRestart: async () => false,
    reconcileReviews: async () => undefined, closeForRestart: async () => undefined, requestColdRunCleanup: async () => false,
    nativeBoundaryEvidence: async () => { throw new Error('No native evidence is fabricated in engine port tests') } }
  const interactions = { list: async () => { throw new Error('Historical pagination must never select resume IDs') } }
  const engine = new LangGraphWorkflowEngine(runs as unknown as EngineArguments[0], {
    getVersion: async (versionId: string) => { assert.equal(versionId, f.version.id); return f.version },
  } as unknown as EngineArguments[1],
    native as unknown as EngineArguments[2], saver, '/synthetic/runtime', {} as EngineArguments[5],
    {} as EngineArguments[6], interactions as unknown as EngineArguments[7])
  const internals = engine as unknown as Internals
  function addInteraction(node = 1, delivered = false, suffix = String(node)) {
    const identity = f.identities[node]!
    const item = DurableInteractionSchema.parse({ ...NATIVE_INTERACTION_FIXTURES.codex, id: `interaction-${suffix}`,
      workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id, graphThreadId: run.id,
      executionId: identity.executionId, requestingAgentId: identity.agentId, nativeSessionId: `native-${suffix}`,
      nativeRequestId: `request-${suffix}`, graphInterruptId: `interrupt-${suffix}`, approval: { handler: 'user' },
      ...(delivered ? { status: 'delivered', deliveryState: 'delivered', selectedOptionId: 'codex-approve-once',
        selectedSemantic: 'approve_once', nativeResponse: { decision: 'accept' }, decidedAt: f.createdAt, deliveredAt: f.createdAt } : {}) })
    items.set(item.id, item); return item
  }
  function waiting(...current: DurableInteraction[]) {
    const layout = compileRepeatLayout(f.version)
    control.checkpoint = { values: { runId: run.id }, next: [], tasks: current.map((item) => {
      const identity = f.identities.find((row) => row.executionId === item.executionId)!
      return { name: layout.nodes.find((node) => node.nodeId === identity.workflowNodeId)!.name,
        interrupts: [{ id: item.graphInterruptId ?? `saved-${item.id}`, value: { interactionId: item.id } }] }
    }) }
    control.checkpoint.next = control.checkpoint.tasks.map((task) => task.name)
  }
  function complete() {
    Object.assign(run, { executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded' }, finishedAt: f.createdAt })
    control.checkpoint = { values: { runId: run.id }, next: [], tasks: [] }
  }
  async function reconcile() {
    const errors: unknown[] = []
    await engine.reconcile((error) => { errors.push(error) })
    // reconcile schedules bounded work; it is not a promise for all Run drives.
    await Promise.allSettled([...internals.activeTasks.values()])
    await Promise.resolve()
    return errors
  }
  return { ...f, run, calls, control, engine, internals, runs, native, items, host, addInteraction, waiting, complete, reconcile }
}

it('reconciliation preserves healthy approval waits across repeated ticks', async () => {
  const f = fixture(), item = f.addInteraction(); f.waiting(item)
  for (let tick = 0; tick < 3; tick++) assert.deepEqual(await f.reconcile(), [])
  assert.equal(f.run.executionState, 'waiting'); assert.deepEqual(f.items.get(item.id), item)
  assert.equal(f.calls.cancel, 0); assert.equal(f.calls.settled, 0); assert.equal(f.calls.entries.length, 0)
  assert.equal(f.calls.owners, 0)
})
it('reconciliation repairs only a missing binding after the checkpoint was saved', async () => {
  const f = fixture(), item = f.addInteraction(); delete item.graphInterruptId
  f.run.executionState = 'running'; f.waiting(item)
  assert.deepEqual(await f.reconcile(), [])
  assert.deepEqual(f.calls.bound, [`saved-${item.id}`]); assert.equal(f.run.executionState, 'waiting')
  assert.equal(f.items.get(item.id)?.nativeSessionId, item.nativeSessionId)
  assert.equal(f.items.get(item.id)?.nativeRequestId, item.nativeRequestId)
  assert.equal(f.calls.entries.length, 0); assert.equal(f.calls.settled, 0)
})
it('reconciliation consumes delivered current interrupts without native response replay', async () => {
  const f = fixture(), item = f.addInteraction(1, true); f.waiting(item)
  f.control.work = async () => f.complete()
  assert.deepEqual(await f.reconcile(), [])
  assert.equal(f.run.outcome, 'succeeded'); assert.deepEqual(f.calls.consumed, [[item.id]])
  assert.equal(f.calls.cancel, 0)
})
it('reconciliation rereads terminal runs under ownership instead of settling stale candidates', async () => {
  const f = fixture()
  f.runs.reconciliationCandidates = async () => { const old = structuredClone(f.run); f.complete(); return [old] }
  assert.deepEqual(await f.reconcile(), [])
  assert.equal(f.calls.settled, 0); assert.equal(f.calls.entries.length, 0); assert.equal(f.calls.cancel, 0)
  assert.equal(f.control.cleanupPending, false)
})

/** Actual LangGraph/node/runtime tests. Only the repository/native observation
 * and lifecycle writes are in-memory ports; never database/native qualification. */
function runtimeFixture(names = ['entry', 'approval', 'sibling'], edges: Array<[string, string]> = [['entry', 'approval'], ['entry', 'sibling']]) {
  const f = syntheticCurrentWorkflow(names, edges), checkpointer = new MemorySaver(), controller = new AbortController()
  const state = { executionState: 'queued', stopRequested: false, outcome: 'pending', cancel: 0, cleanup: false, settled: 0 }
  const driver = f.driver()
  const unsupportedWork = async (): Promise<never> => { throw new Error('Unexpected work handoff') }
  const store = { ...f.store,
    ensureWorkEntry: unsupportedWork, admitWorkActivation: unsupportedWork, acceptWorkTerminal: unsupportedWork,
    admitWorkRequest: unsupportedWork, returnWork: unsupportedWork, recordWorkUnresolved: unsupportedWork,
    completeWorkRun: unsupportedWork,
    resolveWaitingWorkJoins: unsupportedWork,
    resolveExcluded: async () => undefined, // All nodes in these fixtures are reachable.
    completeRun: async () => {
      assert.equal(f.resolutions.size, names.length)
      for (const resolution of f.resolutions.values()) assert.ok(['succeeded', 'skipped'].includes(resolution.resolution))
      state.executionState = 'completed'; state.outcome = 'succeeded'
    },
  }
  const lifecycle = {
    preflight: async () => undefined, markRunning: async () => { state.executionState = 'running' },
    currentState: async () => ({ executionState: state.executionState, stopRequested: state.stopRequested }),
    persistWait: async (checkpoint: RepeatCheckpoint) => {
      const waiting = checkpoint.tasks.some((task) => task.interrupts?.length)
      if (waiting) state.executionState = 'waiting'
      return waiting
    },
    cancelNativeAndRequestCleanup: async () => { state.cleanup = true; state.cancel++; return true },
    settleRun: async () => { assert.equal(state.cleanup, true); state.settled++; state.executionState = 'completed'; state.outcome = 'failed' },
    requestCleanup: async () => { state.cleanup = true }, finishNative: async () => undefined,
    finishCleanup: async () => { assert.equal(state.executionState, 'completed'); state.cleanup = false },
  }
  const input = { runId: f.runId, version: f.version, owner: { assertOwned() {} }, signal: controller.signal,
    checkpointer, store, driver, lifecycle }
  return { ...f, state, driver, store, input, controller, checkpointer,
    execute: () => executeRepeatRuntime(input),
    checkpoint: () => readWorkflowCheckpoint(f.runId, f.version, checkpointer) }
}
it('reconciliation finishes a terminal checkpoint from accepted results without invoking nodes again', async () => {
  const f = runtimeFixture(['entry'], [])
  await f.execute(); const calls = [...f.nativeCalls]
  // Crash cut: graph and accepted execution are saved; Run settlement is not.
  f.state.executionState = 'running'; f.state.outcome = 'pending'
  await f.execute()
  assert.equal(f.state.outcome, 'succeeded'); assert.deepEqual(f.nativeCalls, calls)
  assert.equal(f.state.cancel, 0); assert.equal(f.constructed.length, 1)
})
for (const hasApprovalSibling of [false, true]) it(`reconciliation does not replay orphaned native work (approval sibling: ${hasApprovalSibling})`, async () => {
  const f = fixture(); f.run.executionState = 'running'
  if (hasApprovalSibling) f.waiting(f.addInteraction())
  f.control.checkpoint.tasks.push({ name: 'unconfirmed-native-task', interrupts: [] })
  f.control.work = async () => { throw new DomainError('NATIVE_SESSION_START_UNCERTAIN', 'No original continuation; never relaunch.', 409) }
  const errors = await f.reconcile()
  if (hasApprovalSibling) {
    assert.deepEqual(errors, []); assert.equal(f.run.executionState, 'waiting'); assert.equal(f.calls.entries.length, 0)
  } else {
    assert.equal(errors.length, 1); assert.equal((errors[0] as DomainError).code, 'NATIVE_SESSION_START_UNCERTAIN')
    assert.equal(f.run.executionState, 'running')
  }
  // V3 requires positive closure to terminalize; absence is not an interrupted
  // result. Retain the recovery obligation rather than manufacturing settlement.
  assert.equal(f.run.outcome, 'pending'); assert.equal(f.calls.settled, 0); assert.equal(f.calls.cancel, 0)
})
it('a checkpoint read failure leaves delivered approval state recoverable for the next tick', async () => {
  const f = fixture()
  const item = f.addInteraction(1, true)
  f.waiting(item)
  let now = Date.now()
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
  const read = f.control.read
  f.control.read = async () => { throw new Error('checkpoint unavailable') }
  try {
    assert.equal((await f.reconcile()).length, 1)
    assert.equal(f.run.executionState, 'waiting')
    assert.equal(f.items.get(item.id)?.deliveryState, 'delivered')
    assert.equal(f.calls.cancel, 0)
    f.control.read = read
    f.control.work = async () => f.complete()
    now += 999
    assert.deepEqual(await f.reconcile(), [])
    assert.equal(f.run.outcome, 'pending')
    assert.deepEqual(f.calls.consumed, [])
    now++
    assert.deepEqual(await f.reconcile(), [])
    assert.equal(f.run.outcome, 'succeeded')
    assert.deepEqual(f.calls.consumed, [[item.id]])
    assert.equal(f.calls.cancel, 0)
  } finally { clock.mockRestore() }
})
it('run-level resume selects only current IDs even beyond 150 old interactions', async () => {
  const f = fixture()
  for (let n = 0; n < 150; n++) f.addInteraction(1, true, `old-${n}`)
  const left = f.addInteraction(1, true), right = f.addInteraction(2, true); f.waiting(left, right)
  f.control.work = async () => f.complete(); await f.engine.resume(f.run.id)
  assert.deepEqual(f.calls.consumed, [[left.id, right.id]]); assert.equal(f.calls.entries.length, 1)
})
it('consumption combines delivered branches but excludes undecided current interrupts', async () => {
  const f = fixture(), delivered = f.addInteraction(1, true), pending = f.addInteraction(2); f.waiting(delivered, pending)
  f.control.work = async (context) => { await context.lifecycle.persistWait(f.control.checkpoint) }
  await f.engine.resumeInteraction(delivered)
  assert.deepEqual(f.calls.consumed, [[delivered.id]]); assert.equal(f.run.executionState, 'waiting')
  assert.equal(f.items.get(pending.id)?.deliveryState, 'not_started')
})
it('concurrent resume callers wait behind the active run and retain one task/controller owner', async () => {
  const f = fixture(), starting = deferred(), resumed = deferred(), finishing = deferred()
  f.run.executionState = 'queued'; const left = f.addInteraction(1, true), right = f.addInteraction(2, true)
  f.control.work = async () => {
    if (f.calls.entries.length === 1) { await starting.promise; f.waiting(left, right); f.run.executionState = 'waiting'; return }
    resumed.resolve(); await finishing.promise; f.complete()
  }
  const start = f.engine.start(f.run.id), first = f.engine.resumeInteraction(left), second = f.engine.resumeInteraction(right)
  starting.resolve(); await start; await resumed.promise
  const task = f.internals.activeTasks.get(f.run.id), controller = f.internals.activeRuns.get(f.run.id)
  assert.ok(task); assert.ok(controller)
  const third = f.engine.resumeInteraction(left); await Promise.resolve()
  assert.equal(f.internals.activeTasks.get(f.run.id), task); assert.equal(f.internals.activeRuns.get(f.run.id), controller)
  finishing.resolve(); await Promise.all([first, second, third])
  assert.equal(f.calls.peakOwners, 1); assert.equal(f.calls.consumed.length, 1)
  assert.equal(f.internals.activeTasks.size, 0); assert.equal(f.internals.activeRuns.size, 0); assert.equal(f.internals.resumeTasks.size, 0)
})
it('a failed queued resume does not discard another caller or the durable delivered intent', async () => {
  const f = fixture(), item = f.addInteraction(1, true); f.waiting(item)
  const read = f.control.read; let reads = 0
  f.control.read = async () => { if (++reads === 1) throw new Error('temporary checkpoint failure'); return read() }
  f.control.work = async () => f.complete()
  const first = assert.rejects(f.engine.resumeInteraction(item), /temporary checkpoint/)
  await Promise.all([first, f.engine.resumeInteraction(item)])
  assert.equal(f.items.get(item.id)?.deliveryState, 'delivered'); assert.equal(f.run.outcome, 'succeeded'); assert.equal(f.calls.peakOwners, 1)
})
it('failed graph resume I/O remains recoverable without canceling or reconsuming approvals', async () => {
  const f = fixture(), item = f.addInteraction(1, true); f.waiting(item)
  f.control.work = async () => { throw new Error('checkpoint write failed') }
  await assert.rejects(f.engine.resumeInteraction(item), /checkpoint write failed/)
  assert.notEqual(f.run.executionState, 'completed'); assert.equal(f.items.get(item.id)?.deliveryState, 'delivered')
  assert.equal(f.calls.cancel, 0); f.control.work = async () => f.complete()
  assert.deepEqual(await f.reconcile(), []); assert.equal(f.run.outcome, 'succeeded'); assert.equal(f.calls.consumed.length, 1)
})
it('finishing tasks remove tracking only when they still own the registered entries', async () => {
  const f = fixture(), finishing = deferred(); f.run.executionState = 'queued'
  f.control.work = async () => { await finishing.promise; f.complete() }
  const start = f.engine.start(f.run.id), replacementController = new AbortController(), replacementTask = Promise.resolve()
  f.internals.activeRuns.set(f.run.id, replacementController); f.internals.activeTasks.set(f.run.id, replacementTask)
  finishing.resolve(); await start
  assert.equal(f.internals.activeRuns.get(f.run.id), replacementController); assert.equal(f.internals.activeTasks.get(f.run.id), replacementTask)
})
it('a finished branch does not arm a run-wide timer against siblings or successors', async () => {
  const f = runtimeFixture(['entry', 'short', 'long', 'successor'], [['entry', 'short'], ['entry', 'long'], ['long', 'successor']])
  const observe = f.driver.observe
  f.driver.observe = async (execution, signal) => { if (execution.workflowNodeId === 'long') await delay(25); await observe(execution, signal) }
  await f.execute()
  assert.ok(f.completionOrder.indexOf('short') < f.completionOrder.indexOf('long'))
  assert.ok(f.completionOrder.indexOf('long') < f.completionOrder.indexOf('successor'))
  assert.equal(f.state.outcome, 'succeeded'); assert.equal(f.state.cancel, 0)
})
it('approval waiting is not bounded by an active run timer', async () => {
  const f = fixture(), item = f.addInteraction(); f.waiting(item)
  assert.deepEqual(await f.reconcile(), []); await delay(30)
  assert.equal(f.run.executionState, 'waiting'); assert.equal(f.calls.cancel, 0)
  Object.assign(item, { status: 'delivered', deliveryState: 'delivered' }); f.control.work = async () => f.complete()
  await f.engine.resumeInteraction(item); assert.equal(f.run.outcome, 'succeeded')
})
it('does not report its own restart cancellation from background reconciliation', async () => {
  const f = fixture(), entered = deferred(), item = f.addInteraction(1, true)
  f.waiting(item)
  const errors: unknown[] = []
  f.control.work = async context => {
    entered.resolve()
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
    })
  }
  await f.engine.reconcile(error => { errors.push(error) })
  await entered.promise
  await f.engine.shutdown()
  await Promise.resolve()
  assert.equal(errors.length, 0)
  assert.equal(f.calls.owners, 0)
})

it('still reports an unexpected background error after shutdown begins', async () => {
  const f = fixture(), release = deferred()
  const errors: unknown[] = []
  const failure = new DomainError('NATIVE_SESSION_START_UNCERTAIN', 'Unexpected native failure.', 409)
  const start = vi.spyOn(f.engine, 'start').mockImplementation(async () => { await release.promise; throw failure })
  try {
    await f.engine.reconcile(error => { errors.push(error) })
    await f.engine.shutdown()
    release.resolve()
    await delay(0)
    assert.deepEqual(errors, [failure])
  } finally { start.mockRestore() }
})

it('shutdown drains the active resume and rejects queued work without another owner or synthetic Stop', async () => {
  const f = fixture(), entered = deferred(), item = f.addInteraction(1, true); f.waiting(item)
  f.control.work = async (context) => { entered.resolve(); await new Promise<void>((_done, reject) => {
    context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
  }) }
  const first = assert.rejects(f.engine.resumeInteraction(item), { code: 'ENGINE_RESTART' }); await entered.promise
  const second = assert.rejects(f.engine.resumeInteraction(item), { code: 'ENGINE_CLOSING' })
  await f.engine.shutdown(); await Promise.all([first, second])
  assert.equal(f.calls.entries.length, 1); assert.equal(f.calls.owners, 0); assert.equal(f.calls.cancel, 0); assert.equal(f.calls.settled, 0)
  assert.equal(f.internals.activeRuns.size, 0); assert.equal(f.internals.resumeTasks.size, 0)
})
it('shutdown records restart cleanup before closing unsettled work and retains the pending result', async () => {
  const f = fixture()
  const entered = deferred()
  f.run.executionState = 'queued'
  f.control.work = async (context) => {
    entered.resolve()
    await new Promise<void>((_resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(context.signal.reason), { once: true })
    })
  }
  let cleanupRequested = false
  let closedForRestart = false
  f.runs.requestCleanup = async () => {
    assert.equal(f.calls.owners, 1)
    cleanupRequested = true
    f.control.cleanupPending = true
  }
  f.native.closeForRestart = async () => {
    assert.equal(cleanupRequested, true)
    assert.equal(f.control.cleanupPending, true)
    assert.equal(f.calls.owners, 1)
    closedForRestart = true
  }
  const start = assert.rejects(f.engine.start(f.run.id), { code: 'ENGINE_RESTART' })
  await entered.promise
  await f.engine.shutdown()
  await start
  assert.equal(cleanupRequested, true)
  assert.equal(closedForRestart, true)
  assert.equal(f.run.outcome, 'pending')
  assert.equal(f.control.stopRequested, false)
  assert.equal(f.calls.cancel, 0)
  assert.equal(f.calls.settled, 0)
  assert.equal(f.calls.releases, 1)
  assert.equal(f.calls.owners, 0)
})
it('a checkpoint identity rejection propagates before consumption without replacing saved native IDs', async () => {
  const f = fixture(), item = f.addInteraction(1, true); f.waiting(item)
  f.control.waitFailure = new DomainError('INTERACTION_IDENTITY_CONFLICT', 'Original checkpoint identity differs', 409)
  const before = structuredClone(item)
  await assert.rejects(f.engine.resumeInteraction(item), { code: 'INTERACTION_IDENTITY_CONFLICT' })
  assert.deepEqual(f.items.get(item.id), before); assert.deepEqual(f.calls.bound, []); assert.deepEqual(f.calls.consumed, [])
  assert.equal(f.calls.entries.length, 0); assert.equal(f.run.executionState, 'waiting')
})
for (const bubble of [false, true]) it(`ordinary GraphInterrupt does not cancel delayed sibling work (bubbled: ${bubble})`, async () => {
  const f = runtimeFixture(), observe = f.driver.observe
  let siblingFinished = false, siblingAborted = false
  f.driver.observe = async (execution, signal) => {
    if (execution.workflowNodeId === 'approval') {
      if (bubble) throw new GraphInterrupt([{ id: 'unit-interrupt', value: { interactionId: 'unit-approval' } }])
      interrupt({ interactionId: 'unit-approval' }); throw new Error('Undecided approval must remain interrupted')
    }
    if (execution.workflowNodeId === 'sibling') {
      try { await delay(15, undefined, { signal }) } catch (error) { siblingAborted = true; throw error }
      siblingFinished = true
    }
    await observe(execution, signal)
  }
  await f.execute()
  assert.equal(siblingFinished, true); assert.equal(siblingAborted, false); assert.equal(f.state.executionState, 'waiting'); assert.equal(f.state.cancel, 0)
})
it('a definitive sibling error after an interrupt retains its real cause and fails the Run', async () => {
  const f = runtimeFixture(['entry', 'approval', 'failed'], [['entry', 'approval'], ['entry', 'failed']]), observe = f.driver.observe
  const failure = new DomainError('WORKFLOW_SELECTED_EXECUTION_FAILED', 'actual sibling failure', 409)
  f.driver.observe = async (execution, signal) => {
    if (execution.workflowNodeId === 'approval') { interrupt({ interactionId: 'unit-approval' }); throw new Error('Still pending') }
    if (execution.workflowNodeId === 'failed') { await delay(5); throw failure }
    await observe(execution, signal)
  }
  await assert.rejects(f.execute(), (error) => error === failure)
  assert.equal(f.state.outcome, 'failed'); assert.equal(f.state.settled, 1); assert.equal(f.state.cancel, 1)
})

// Method-level repository unit tests: this method uses only requireOwner/client.
// The prototype receiver is not a production repository or a runtime composition.
const budgetRepository = () => Object.create(PostgresRunRepository.prototype) as PostgresRunRepository
it('remaining approval budget uses the owner connection, deduplicates IDs and selects the tightest budget', async () => {
  const queries: Array<{ sql: string; values: unknown[] }> = []
  const owner = { runId: 'run', assertOwned() {}, client: { async query(sql: string, values: unknown[]) {
    queries.push({ sql, values }); return { rows: [{ remaining_ms: '80.5', stopped_at: null }, { remaining_ms: '20', stopped_at: null }] }
  } } } as unknown as RunOwnership
  assert.equal(await budgetRepository().remainingApprovalTime('run', ['a', 'b', 'a'], owner), 20)
  assert.equal(queries.length, 1); assert.deepEqual(queries[0]!.values, ['run', ['a', 'b']])
  assert.match(queries[0]!.sql, /b\.approval_wait_started_at is not null then 0/)
  assert.match(queries[0]!.sql, /b\.active_timeout_ms-b\.active_elapsed_ms/)
  assert.match(queries[0]!.sql, /clock_timestamp\(\)-b\.active_started_at/)
})
for (const rows of [[], [{ remaining_ms: '100', stopped_at: new Date() }]]) it(`missing or stopped persisted budgets fail closed (${rows.length} rows)`, async () => {
  const owner = { runId: 'run', assertOwned() {}, client: { query: async () => ({ rows }) } } as unknown as RunOwnership
  await assert.rejects(budgetRepository().remainingApprovalTime('run', ['a'], owner), { code: 'EXECUTION_STOPPED' })
})
it('[real LangGraph] parallel interrupts preserve predecessors and exact task-local resume identities', async () => {
  const f = runtimeFixture(['entry', 'left', 'right'], [['entry', 'left'], ['entry', 'right']]), observe = f.driver.observe
  const entries = new Map<string, number>()
  f.driver.observe = async (execution, signal) => {
    const id = execution.workflowNodeId; entries.set(id, (entries.get(id) ?? 0) + 1)
    if (id !== 'entry') {
      if (id === 'right') await delay(15)
      const resumed = interrupt({ interactionId: `approval-${id}` }) as { interactionId: string }
      assert.equal(resumed.interactionId, `approval-${id}`)
    }
    await observe(execution, signal)
  }
  const { graph, config } = buildRepeatGraph(f.input)
  await graph.invoke({ runId: f.runId, executionIds: {}, occurrences: {}, boundaries: {} }, config)
  const saved = await f.checkpoint(), pending = saved.tasks.flatMap((task) => task.interrupts ?? [])
  assert.equal(pending.length, 2)
  // Raw Commands belong only to this compiler unit test, not the engine's
  // authenticated production resume API. Atomic SQL consumption is separate.
  const map = Object.fromEntries(pending.map((item) => [item.id, item.value]))
  await graph.invoke(new Command({ resume: map }), config)
  await f.store.completeRun()
  assert.equal(f.state.outcome, 'succeeded'); assert.equal(entries.get('entry'), 1)
  assert.equal(entries.get('left'), 2); assert.equal(entries.get('right'), 2)
  assert.equal(f.nativeCalls.filter((id) => id === 'entry').length, 1)
  assert.deepEqual((await f.checkpoint()).next, [])
})
it('[real LangGraph] a pending approval with a completed sibling stays healthy during checkpoint inspection', async () => {
  const f = runtimeFixture(), observe = f.driver.observe
  f.driver.observe = async (execution, signal) => {
    if (execution.workflowNodeId === 'approval') { interrupt({ interactionId: 'unit-approval' }); throw new Error('Still pending') }
    if (execution.workflowNodeId === 'sibling') await delay(15)
    await observe(execution, signal)
  }
  await f.execute()
  const before = [...f.nativeCalls]
  for (let tick = 0; tick < 3; tick++) assert.equal((await f.checkpoint()).tasks.flatMap((task) => task.interrupts ?? []).length, 1)
  assert.deepEqual(f.nativeCalls, before); assert.equal(before.filter((id) => id === 'sibling').length, 1)
  assert.equal(f.state.executionState, 'waiting'); assert.equal(f.state.cancel, 0); assert.equal(f.state.settled, 0)
})
