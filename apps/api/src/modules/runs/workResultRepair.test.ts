import { describe, expect, it } from 'vitest'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { assertWorkflowCorrelation, readWorkResultRepairAttempt, workResultRepairCorrelation } from './workResultRepair.js'

function store(attempt: number, executionId = 'execution-1'): GraphSqlClient {
  return { query: async (_query: string, values: unknown[]) => {
    expect(values).toEqual([executionId])
    return { rows: attempt ? [{ attempt }] : [], rowCount: attempt ? 1 : 0 }
  } } as unknown as GraphSqlClient
}

describe('persisted work result repair allowance', () => {
  it.each([0, 1, 2])('recovers the reserved attempt %s and its execution correlation', async attempt => {
    const sql = store(attempt)
    expect(await readWorkResultRepairAttempt(sql, 'execution-1')).toBe(attempt)
    await expect(assertWorkflowCorrelation(sql, 'execution-1', workResultRepairCorrelation('execution-1', attempt)))
      .resolves.toBeUndefined()
  })

  it.each([0, 1, 2])('rejects unreserved, foreign, and malformed correlations after %s reservations', async attempt => {
    const sql = store(attempt)
    for (const correlation of [undefined, workResultRepairCorrelation('other-execution', 1),
      workResultRepairCorrelation('execution-1', attempt + 1), 'execution:execution-1:result-repair:01']) {
      await expect(assertWorkflowCorrelation(sql, 'execution-1', correlation))
        .rejects.toMatchObject({ code: 'NATIVE_TURN_IDENTITY_CONFLICT' })
    }
  })
})
