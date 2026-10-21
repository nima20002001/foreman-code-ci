import { setImmediate } from 'node:timers/promises'
import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type HarnessNativeEvent } from '@foreman-code/contracts'
import { lockWorkerExecution, type WorkerExecutionIdentity } from '../access/workerLifecycle.js'
import { createWorkflowNativeCaptureChannel } from '../interactions/workflowNativeCapture.js'
import type { SingleWriterSessionManager, SessionWriteLease } from '../interactions/sessionWriter.js'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import * as lifecycle from './repeatLifecycle.js'
import { PostgresRunRepository } from './postgres.js'
import type { RunOwnership } from './ownership.js'
import { WorkflowNativeProofServices } from './workflowNativeProof.js'
import { currentRepositoryFixture, unavailableRuntime } from '../../../test/eng04-runtime-repository-fixture.js'
import { rejectableDeferred } from '../../../test/helpers/deferred.js'

afterEach(() => vi.restoreAllMocks())

function fixture() {
  const { run, f: { createdAt } } = currentRepositoryFixture()
  const execution = HarnessExecutionSchema.parse({ id: 'stream-execution', runId: run.id,
    workflowNodeId: 'node', agentId: 'agent', agentConfigurationVersionId: 'configuration', attempt: 1,
    input: { task: 'stream' }, state: 'running', nativeSessionId: 'session', createdAt, startedAt: createdAt })
  const workerExecution = { ...execution, id: 'worker-execution' }
  const session = { harness: 'codex' as const, nativeSessionId: 'session', providerVersion: 'fixture' }
  const channel = createWorkflowNativeCaptureChannel()
  const entered = rejectableDeferred<void>()
  const resume = rejectableDeferred<void>()
  const unlocked = rejectableDeferred<void>()
  const committed: HarnessNativeEvent[] = []
  const notified: number[] = []
  let staged: HarnessNativeEvent[] = []
  let lifecycleHeld = false
  let pause = true
  let failSemantic = false
  // The transaction adapter models the Run lock owned by the graph writer.
  // Source work remains suspended until the test releases its captured frame.
  const raw = { async query(text: string) {
    if (text === 'commit') committed.push(...staged)
    if (text === 'commit' || text === 'rollback') {
      staged = []
      lifecycleHeld = false
      unlocked.resolve()
    }
    return { rows: [], rowCount: 0 }
  } } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(raw, () => {})
  const owner = { runId: run.id, assertOwned() {}, oneShotConnection: () => connection } as unknown as RunOwnership
  vi.spyOn(lifecycle, 'openWorkflowLifecycleLocked').mockImplementation(async () => {
    lifecycleHeld = true
    return { snapshot: { run } } as Awaited<ReturnType<typeof lifecycle.openWorkflowLifecycleLocked>>
  })
  const native = new WorkflowNativeProofServices(channel.verify)
  const persist = async (frames: readonly { event: HarnessNativeEvent }[]) => {
    for (const { event } of frames) {
      if (event.type === 'native.notification' && pause) {
        pause = false
        entered.resolve()
        await resume.promise
      }
      if (event.type === 'turn.started' && failSemantic) throw new Error('semantic publication failed')
      staged.push(event)
    }
  }
  vi.spyOn(native, 'tryAppendTranscriptsLocked').mockImplementation(async (_sql, frames) => {
    if (!frames.every(({ event }) => event.type === 'native.notification')) return false
    await persist(frames)
    return true
  })
  vi.spyOn(native, 'appendEventsLocked').mockImplementation(async (_sql, _run, frames) => persist(frames))
  const repository = new PostgresRunRepository({} as pg.Pool,
    {} as ConstructorParameters<typeof PostgresRunRepository>[1],
    { revalidateRunAuthorization: async () => {} } as unknown as ConstructorParameters<typeof PostgresRunRepository>[2],
    { ...unavailableRuntime(), native }, async evidence => {
      const capture = channel.verify.read(evidence)
      if (capture.source.type === 'event') notified.push(capture.source.event.sequence)
    })
  const lease = { fence: { id: 'lane', token: 'token' }, previous: { connectionGeneration: 1 },
    providerId: 'turn' } as SessionWriteLease
  const manager = { harness: 'codex', assertCapturedLease() {} } as unknown as SingleWriterSessionManager
  const events: HarnessNativeEvent[] = [
    { executionId: execution.id, connectionId: 'connection', sequence: 0,
      type: 'native.notification', occurredAt: createdAt, payload: { text: 'first transcript' } },
    { executionId: execution.id, connectionId: 'connection', sequence: 1,
      type: 'turn.started', occurredAt: createdAt, payload: { threadId: 'session', turn: { id: 'turn' } } },
    { executionId: execution.id, connectionId: 'connection', sequence: 2,
      type: 'native.notification', occurredAt: createdAt, payload: { text: 'second transcript' } },
  ]
  const frames = events.map(event => ({ event, evidence: channel.capture.capture({ owner, execution, session,
    manager, lease, kind: 'live', source: { type: 'event', event }, lifetimeGeneration: 1,
    closureGeneration: '1', assertCurrent() {} }) }))
  const identity: WorkerExecutionIdentity = { execution_id: workerExecution.id, run_id: run.id,
    agent_id: workerExecution.agentId, workspace_id: run.workspaceId, workflow_id: run.workflowId,
    execution_record: workerExecution, run_record: run, execution_closed_at: null,
    run_closed_at: null, approval_stopped_at: null }
  const worker = { async query(text: string) {
    if (text.startsWith('select run_id')) return { rows: [{ run_id: run.id }] }
    if (text.startsWith('select id from runs') && lifecycleHeld) await unlocked.promise
    if (text.includes('he.record as execution_record')) return { rows: [identity] }
    return { rows: [] }
  } } as unknown as pg.PoolClient
  return { entered: entered.promise, resume: () => resume.resolve(), committed, notified, events,
    append: () => repository.appendNativeEvents(frames, owner, { ...lease.fence, live: true, providerId: 'turn' }),
    validateWorker: () => lockWorkerExecution(worker, workerExecution.id, undefined, 'share'),
    failSemantic: () => { failSemantic = true }, close: () => connection.close() }
}

it('keeps another execution usable while a mixed batch persists a slow transcript', async () => {
  const f = fixture()
  const append = f.append()
  let validation: Promise<WorkerExecutionIdentity> | undefined
  try {
    await f.entered
    let validated = false
    validation = f.validateWorker().then(identity => {
      validated = true
      return identity
    })
    await setImmediate()
    expect(validated).toBe(true)
  } finally {
    f.resume()
    await append
    await validation
    await f.close()
  }
  expect(f.committed).toEqual(f.events)
  expect(f.notified).toEqual([0, 1, 2])
})

it('retains the committed transcript prefix when the following semantic publication fails', async () => {
  const f = fixture()
  f.failSemantic()
  f.resume()
  try {
    await expect(f.append()).rejects.toThrow('semantic publication failed')
    expect(f.committed).toEqual(f.events.slice(0, 1))
    expect(f.notified).toEqual([0])
  } finally { await f.close() }
})
