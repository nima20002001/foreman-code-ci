import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { insertProviderRun } from './helpers/wave25Br1003Runtime.js'
import { workflowConcurrencyFixture } from './helpers/workflowConcurrencyFixture.js'

const createRuntime = workflowConcurrencyFixture()

it('completes concurrent Runs of the same single Agent without sharing native ownership', async () => {
  const f = await createRuntime({ workerParallelism: 4 })
  const runIds = [f.f.run.id]
  try {
    for (let index = 0; index < 3; index += 1) {
      const run = WorkflowRunV3Schema.parse({ ...f.f.run, id: `run-${randomUUID()}` })
      await insertProviderRun(f.db.pool, { ...f.f, run })
      runIds.push(run.id)
    }
    const results = await Promise.allSettled(runIds.map(id => f.engine.start(id)))
    expect(results.filter(result => result.status === 'rejected')).toEqual([])
    for (const id of runIds) {
      expect(await f.runs.get(id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    }
    expect(f.provider.counts).toMatchObject({ sessions: 4, starts: 4 })
    expect(f.provider.closedSessions.size).toBe(4)
  } finally {
    await f.close()
  }
}, 90_000)
