import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'

export function workResultRepairCorrelation(executionId: string, attempt = 0): string {
  const command = `execution:${executionId}`
  return attempt === 0 ? command : `${command}:result-repair:${attempt}`
}

export async function readWorkResultRepairAttempt(sql: GraphSqlClient, executionId: string): Promise<number> {
  const row = (await sql.query<{ attempt: number }>(
    'select attempt from execution_work_result_repairs where execution_id=$1 order by attempt desc limit 1',
    [executionId])).rows[0]
  return row?.attempt ?? 0
}

export async function assertWorkflowCorrelation(sql: GraphSqlClient, executionId: string,
  correlationId: string | undefined): Promise<void> {
  if (correlationId === workResultRepairCorrelation(executionId)) return
  const attempt = await readWorkResultRepairAttempt(sql, executionId)
  for (let repair = 1; repair <= attempt; repair++) {
    if (correlationId === workResultRepairCorrelation(executionId, repair)) return
  }
  throw new DomainError('NATIVE_TURN_IDENTITY_CONFLICT', 'The workflow turn has no reserved result repair.', 409)
}
