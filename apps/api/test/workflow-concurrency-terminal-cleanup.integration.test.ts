import { expect, it, vi } from 'vitest'
import { DomainError } from '../src/modules/errors.js'
import { workflowConcurrencyFixture } from './helpers/workflowConcurrencyFixture.js'

const createRuntime = workflowConcurrencyFixture()

it('finishes terminal cleanup when a concurrent lifecycle fence wins after completion', async () => {
  const f = await createRuntime()
  const repeat = f.runs.repeat.bind(f.runs)
  vi.spyOn(f.runs, 'repeat').mockImplementation(async (...args) => {
    const store = await repeat(...args)
    const complete = store.completeRun.bind(store)
    store.completeRun = async () => {
      await complete()
      await f.runs.requestCleanup(f.f.run.id, args[0])
      throw new DomainError('GRAPH_STOP_CONFLICT', 'The Run has a cleanup request.', 409)
    }
    return store
  })
  try {
    await expect(f.engine.start(f.f.run.id)).resolves.toBeUndefined()
    expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    expect(f.provider.counts).toMatchObject({ sessions: 1, starts: 1 })
    expect(f.provider.closedSessions.size).toBe(1)
    const snapshot = await f.runs.getRepeatSnapshot(f.f.run.id)
    expect(snapshot.cleanupPending).toBe(false)
  } finally {
    await f.close()
  }
}, 60_000)
