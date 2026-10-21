import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'vitest'
import { repeatNativeObserver } from '../src/modules/runs/repeatRuntime.js'
import { RunnerAdmission } from '../src/modules/runs/runnerAdmission.js'
import type { RepeatNativeLaunchStore } from '../src/modules/interactions/repeatObservation.js'
import type { ApprovalExecutionCoordinator } from '../src/modules/interactions/execution.js'
import { nativeCompleted } from './eng04-native-fixtures.js'
import { native2Fixture } from './eng04-native2-fixtures.js'

function observerFixture(completed = false) {
  const f = native2Fixture(completed)
  const store: RepeatNativeLaunchStore = { ...f.store,
    readWorkExecutionContext: async () => { throw new Error('Ordinary workflows have no work-handoff context') },
    beginNativeEntry: async () => { throw Object.assign(new Error('No preparation permit'), { code: 'NATIVE_ENTRY_CONFLICT' }) },
    claimLaunch: async () => { throw new Error('claim not configured') },
    recoverSession: async () => f.get(),
  }
  const native: Pick<ApprovalExecutionCoordinator, 'observeExact' | 'assertResume'> = {
    observeExact: async ({ execution, request }) => {
      f.calls.push(request ? 'live-observe' : 'cleanup-observe')
      return { state: 'completed', execution: nativeCompleted(execution), result: nativeCompleted(execution).result! }
    }, assertResume: async () => undefined,
  }
  const context = { run: f.run, version: f.fixture.version, owner: f.owner as never, store, native,
    admission: new RunnerAdmission(1), workflows: { resolveNodeSkills: async () => { throw new Error('node skills are not used by this fixture') }, referencesCreatedByExecution: async () => new Set<string>(), getAgentConfiguration: async () => f.configuration },
    locations: { revalidateRunAuthorization: async () => undefined, revalidateSnapshot: async () => undefined },
    directory: () => f.get().runtimeDirectory! }
  return { ...f, context, store, native, observer: () => repeatNativeObserver(context) }
}

test('NATIVE-2 terminal observer bypasses capacity, configuration and directory work', async () => {
  const f = observerFixture(true)
  f.context.admission.run = async () => { throw new Error('terminal entered capacity') }
  f.context.directory = () => { throw new Error('terminal requested a directory') }
  f.context.workflows.getAgentConfiguration = async () => { throw new Error('terminal requested configuration') }
  await f.observer()(f.get(), new AbortController().signal)
  assert.ok(f.calls.includes('cleanup-observe'))
  assert.ok(!f.calls.includes('live-observe'))
})

test('NATIVE-2 unknown launch COMMIT creates no directory or native work', async () => {
  const f = observerFixture(), root = await mkdtemp(join(tmpdir(), 'eng04-native2-'))
  const directory = join(root, 'occurrence')
  try {
    f.set({ ...f.get(), nativeSessionId: undefined, runtimeDirectory: directory })
    f.store.claimLaunch = async () => { throw new Error('synthetic launch COMMIT acknowledgement lost') }
    await assert.rejects(f.observer()(f.get(), new AbortController().signal))
    assert.equal(existsSync(directory), false)
    assert.ok(!f.calls.includes('live-observe'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('NATIVE-2 a claimed execution without its one-use permit allocates nothing', async () => {
  const f = observerFixture(), root = await mkdtemp(join(tmpdir(), 'eng04-native2-'))
  const directory = join(root, 'occurrence')
  try {
    f.set({ ...f.get(), nativeSessionId: undefined, runtimeDirectory: directory })
    f.store.claimLaunch = async () => f.get()
    await assert.rejects(f.observer()(f.get(), new AbortController().signal), { code: 'NATIVE_ENTRY_CONFLICT' })
    assert.equal(existsSync(directory), false)
    assert.ok(!f.calls.includes('live-observe'))
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('NATIVE-2 preparation precedes mkdir and submission authorization remains with the coordinator', async () => {
  const f = observerFixture(), root = await mkdtemp(join(tmpdir(), 'eng04-native2-'))
  const directory = join(root, 'occurrence')
  try {
    f.set({ ...f.get(), nativeSessionId: undefined, runtimeDirectory: directory })
    f.store.claimLaunch = async () => f.get()
    let permits = 0
    f.store.beginNativeEntry = async (id) => { assert.equal(existsSync(directory), false); return { executionId: id } }
    f.store.consumeLaunch = (id) => { assert.equal(id, f.get().id); assert.equal(existsSync(directory), true); permits++; return permits === 1 }
    f.native.observeExact = async ({ execution, store }) => {
      assert.equal(existsSync(directory), true)
      await store.authorizeNativeSubmission(execution.id)
      assert.equal(store.consumeLaunch(execution.id), true)
      assert.equal(store.consumeLaunch(execution.id), false)
      return { state: 'completed', execution: nativeCompleted(execution), result: nativeCompleted(execution).result! }
    }
    await f.observer()(f.get(), new AbortController().signal)
    assert.equal(permits, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('NATIVE-2 no-session recovery cannot reuse an already-consumed launch receipt', async () => {
  const f = observerFixture()
  f.set({ ...f.get(), nativeSessionId: undefined })
  f.store.claimLaunch = async () => undefined
  f.store.consumeLaunch = () => { throw new Error('recovery consumed fresh launch') }
  await assert.rejects(f.observer()(f.get(), new AbortController().signal), { code: 'NATIVE_SESSION_START_UNCERTAIN' })
  assert.ok(!f.calls.includes('live-observe'))
})

test('NATIVE-2 existing-session recovery does not consume another launch permit', async () => {
  const f = observerFixture()
  f.store.claimLaunch = async () => undefined
  f.store.consumeLaunch = () => { throw new Error('recovery consumed fresh launch') }
  await f.observer()(f.get(), new AbortController().signal)
  assert.ok(f.calls.includes('live-observe'))
})

test.each([undefined, 3_600_000])('passes the saved workflow active-time budget to native execution (%s)', async (timeoutMs) => {
  const f = observerFixture()
  if (timeoutMs !== undefined) f.context.version.definition.executionPolicy!.agentActiveTimeoutMs = timeoutMs
  let observed = false
  const observe = f.native.observeExact
  f.native.observeExact = async (input) => {
    observed = true
    assert.equal(input.agentActiveTimeoutMs, timeoutMs)
    return observe(input)
  }
  f.store.claimLaunch = async () => undefined
  await f.observer()(f.get(), new AbortController().signal)
  assert.equal(observed, true)
})

test('NATIVE-2 Stop while waiting for the shared runner gate cannot claim a launch', async () => {
  const f = observerFixture(), signal = new AbortController()
  let release!: () => void
  const blocker = f.context.admission.run('run-other', new AbortController().signal,
    () => new Promise<void>((resolve) => { release = resolve }))
  let claims = 0
  f.store.claimLaunch = async () => { claims++; return f.get() }
  const task = f.observer()(f.get(), signal.signal)
  for (let i = 0; i < 10 && !f.context.admission.pending; i++) await Promise.resolve()
  signal.abort(new Error('Stop while queued'))
  await assert.rejects(task, /Stop while queued/)
  release(); await blocker
  assert.equal(claims, 0)
  assert.equal(f.context.admission.pending, 0)
})

test('NATIVE-2 execution completed while queued takes cleanup-only path after wakeup', async () => {
  const f = observerFixture()
  let release!: () => void
  const blocker = f.context.admission.run('run-other', new AbortController().signal,
    () => new Promise<void>((resolve) => { release = resolve }))
  const task = f.observer()(f.get(), new AbortController().signal)
  for (let i = 0; i < 10 && !f.context.admission.pending; i++) await Promise.resolve()
  f.set(nativeCompleted(f.get()))
  release(); await blocker; await task
  assert.ok(f.calls.includes('cleanup-observe'))
  assert.ok(!f.calls.includes('live-observe'))
})
