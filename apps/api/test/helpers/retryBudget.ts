import { afterEach, describe, expect, vi } from 'vitest'
import { postgresEnabled } from './wave25Agent3.js'
import { executionRows, type RecoveryFixture } from './eng06DRecovery.js'

export const attempts = (rows: Awaited<ReturnType<typeof executionRows>>) => rows.map((row) => row.execution.attempt).sort((a, b) => a - b)
export async function occurrences(f: RecoveryFixture, runId = f.base.f.run.id) {
  return (await f.base.db.pool.query<{ occurrence_index: number }>(
    'select occurrence_index from run_repeat_occurrences where run_id=$1 order by occurrence_index', [runId])).rows
}
export function sameSlot(rows: Awaited<ReturnType<typeof executionRows>>) {
  expect(new Set(rows.map((row) => row.slot_id)).size).toBe(1)
  expect(new Set(rows.map((row) => row.input_json)).size).toBe(1)
  expect(new Set(rows.map((row) => row.input_digest)).size).toBe(1)
  expect(new Set(rows.map((row) => row.execution.id)).size).toBe(rows.length)
  for (const row of rows) {
    expect(row.execution.sessionContinuation).toBeUndefined()
    expect(row.execution.agentConfigurationVersionId).toBe(rows[0]!.execution.agentConfigurationVersionId)
    expect(row.execution.input).toEqual(rows[0]!.execution.input)
  }
}

export function describeRetryBudget(label: string, cases: () => void) {
  describe.skipIf(!postgresEnabled)(label, () => {
    afterEach(() => vi.restoreAllMocks())
    cases()
  })
}
