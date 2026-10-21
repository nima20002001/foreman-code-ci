import { expect } from 'vitest'
import { executionRows, readback, type Form, type RecoveryFixture } from './eng06DRecovery.js'

export const forms: Form[] = ['sequential', 'repeat']

export async function parked(f: RecoveryFixture) {
  await expect.poll(async () => {
    const rows = await executionRows(f)
    return { run: (await f.runtime.runs.getRepeatSnapshot(f.base.f.run.id)).run.executionState,
      states: rows.map((row) => row.execution.state), submissions: f.provider.counts.starts,
      parked: rows.every((row) => f.provider.atBarrier(row.execution.id)) }
  }, { timeout: 20000, interval: 50 }).toEqual({ run: 'running', states: ['running'], submissions: 1, parked: true })
  const before = await readback(f)
  expect(before.record.run).not.toHaveProperty('result')
  expect(before.details).toHaveLength(1)
  expect(before.details[0]!.acceptedResult).toEqual({ status: 'not_accepted' })
  expect(before.details[0]).not.toHaveProperty('reportedResult')
  return before
}
