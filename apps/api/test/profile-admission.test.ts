import { expect, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { repeatNativeObserver } from '../src/modules/runs/repeatRuntime.js'
import { RunnerAdmission } from '../src/modules/runs/runnerAdmission.js'
import type { RepeatNativeLaunchStore } from '../src/modules/interactions/repeatObservation.js'
import { native2Fixture } from './eng04-native2-fixtures.js'

it.each(['main', 'device:worker'])('rejects a failed selected profile before waiting for occupied capacity on %s', async hostKey => {
  const f = native2Fixture(false)
  f.set({ ...f.get(), state: 'queued', nativeSessionId: undefined })
  const admission = new RunnerAdmission(1)
  let release!: () => void
  const blocker = admission.run('other-run', new AbortController().signal,
    () => new Promise<void>(resolve => { release = resolve }), { hostKey })
  const failure = new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The selected model is absent from the native catalog.',
    409, { reason: 'profile_check_failed' })
  const preparePlacement = vi.fn(async () => { throw failure })
  const claimLaunch = vi.fn(async () => f.get())
  const observeExact = vi.fn()
  const store: RepeatNativeLaunchStore = { ...f.store, claimLaunch,
    recoverSession: async () => f.get(), beginNativeEntry: async () => { throw new Error('Unexpected native entry') },
    readWorkExecutionContext: async () => { throw new Error('Ordinary execution has no work context') },
  }
  const context = { run: f.run, version: f.fixture.version, owner: f.owner as never, store,
    native: { observeExact, assertResume: async () => {} }, admission,
    workflows: { resolveNodeSkills: async () => { throw new Error('node skills are not used by this fixture') }, referencesCreatedByExecution: async () => new Set<string>(), getAgentConfiguration: async () => f.configuration },
    locations: { revalidateRunAuthorization: async () => {}, revalidateSnapshot: async () => {} },
    preparePlacement, executionHostKey: async () => hostKey, directory: () => '/workspace/runtime',
  }
  let rejected: unknown
  const task = repeatNativeObserver(context)(f.get(), new AbortController().signal)
    .catch(error => { rejected = error })
  try {
    await vi.waitFor(() => expect(rejected).toBe(failure), { timeout: 1000 })
    expect(preparePlacement).toHaveBeenCalledTimes(1)
    expect(admission.pending).toBe(0)
    expect(admission.inFlight).toBe(1)
    expect(claimLaunch).not.toHaveBeenCalled()
    expect(observeExact).not.toHaveBeenCalled()
  } finally {
    release()
    await blocker
    await task
  }
})
