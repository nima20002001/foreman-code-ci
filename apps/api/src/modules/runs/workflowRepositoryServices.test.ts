import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import type { AcceptedWorkflowRunV3, WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import * as transactions from '../run-graph/connection.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import * as snapshots from './repeatStartRead.js'
import * as executions from './repeatPostgres.js'
import * as capacity from './workflowExecutionBudget.js'
import { allowTechnicalRetryLocked } from './workflowRepositoryServices.js'

const startedAt = Date.parse('2026-10-01T00:00:00.000Z')
const run = { id: 'run', executionState: 'running' } as AcceptedWorkflowRunV3
const version = { definition: { executionPolicy: { maxNodeExecutions: 20 } } } as WorkflowVersionV3

function failedAttempt(attempt: number, code: string, elapsedMs = 0): HarnessExecution {
  return HarnessExecutionSchema.parse({
    id: `execution-${attempt}`, runId: run.id, workflowNodeId: 'node', agentId: 'agent',
    agentConfigurationVersionId: 'configuration', attempt, input: {}, state: 'completed',
    createdAt: new Date(startedAt - 60_000).toISOString(),
    finishedAt: new Date(startedAt + elapsedMs).toISOString(),
    result: { outcome: 'failed', error: { code, message: 'Attempt failed.', retryable: true } },
  })
}

function retryStore(attempts: HarnessExecution[], infrastructureIds = attempts.map(item => item.id)) {
  const execution = attempts.at(-1)!
  vi.spyOn(executions, 'readRepeatExecutionLocked').mockResolvedValue({
    execution, ref: { nodeId: 'node', occurrence: null }, slotId: 'slot', input: {} as never,
    inputDigest: 'digest', accepted: false,
  })
  const query = vi.fn(async () => ({ rows: attempts.map(record => ({
    record, failure_result: infrastructureIds.includes(record.id) ? record.result : null,
  })) }))
  return { sql: { query, transaction: true } as unknown as GraphTransactionSql, execution }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(startedAt + 40_000)
  vi.stubEnv('FOREMAN_EXECUTION_RETRY_BACKOFF_MS', '10000,30000,60000')
  vi.spyOn(transactions, 'assertGraphTransaction').mockImplementation(() => undefined)
  vi.spyOn(snapshots, 'readAcceptedRepeatRunLocked').mockResolvedValue({
    run, version, configurations: [], stopRequested: false, cleanupPending: false,
  })
  vi.spyOn(capacity, 'hasWorkflowExecutionCapacityLocked').mockResolvedValue(true)
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

describe('workflow infrastructure retry budget', () => {
  it('allows a fourth attempt after credential, start, and preparation infrastructure failures', async () => {
    const attempts = [
      failedAttempt(1, 'WORKER_CREDENTIAL_EXPIRING'),
      failedAttempt(2, 'EXECUTION_START_INTERRUPTED', 10_000),
      failedAttempt(3, 'EXECUTION_PREPARATION_UNAVAILABLE', 40_000),
    ]
    const { sql, execution } = retryStore(attempts)
    await expect(allowTechnicalRetryLocked(sql, run, version, execution)).resolves.toBe(true)
  })

  it('recovers the infrastructure deadline from persisted attempts on every read', async () => {
    const attempts = [failedAttempt(1, 'WORKER_CREDENTIAL_EXPIRING'),
      failedAttempt(2, 'EXECUTION_START_INTERRUPTED', 10_000)]
    const first = retryStore(attempts)
    await expect(allowTechnicalRetryLocked(first.sql, run, version, first.execution)).resolves.toBe(true)
    vi.setSystemTime(startedAt + 600_000)
    const recovered = retryStore(attempts)
    await expect(allowTechnicalRetryLocked(recovered.sql, run, version, recovered.execution)).resolves.toBe(false)
  })

  it.each([539_999, 540_000, 600_000])('includes backoff in the ten-minute deadline at %s ms', async elapsed => {
    vi.setSystemTime(startedAt + elapsed)
    const attempts = [failedAttempt(1, 'WORKER_CREDENTIAL_EXPIRING'),
      failedAttempt(2, 'EXECUTION_START_INTERRUPTED', 10_000),
      failedAttempt(3, 'EXECUTION_PREPARATION_UNAVAILABLE', 40_000)]
    const { sql, execution } = retryStore(attempts)
    await expect(allowTechnicalRetryLocked(sql, run, version, execution)).resolves.toBe(elapsed < 540_000)
  })

  it('starts the retry window at the infrastructure failure, even after a long Agent turn', async () => {
    vi.setSystemTime(startedAt + 3_600_000)
    const attempts = [failedAttempt(1, 'EXECUTION_INTERRUPTED', 3_600_000)]
    const { sql, execution } = retryStore(attempts)
    await expect(allowTechnicalRetryLocked(sql, run, version, execution)).resolves.toBe(true)
  })

  it.each([1, 2, 3])('preserves the Agent failure budget at failure %s', async count => {
    const attempts = Array.from({ length: count }, (_, index) => failedAttempt(index + 1, 'AGENT_FAILED'))
    const { sql, execution } = retryStore(attempts, [])
    await expect(allowTechnicalRetryLocked(sql, run, version, execution)).resolves.toBe(count < 3)
  })

  it('does not charge infrastructure attempts against the Agent failure budget', async () => {
    const attempts = [failedAttempt(1, 'WORKER_CREDENTIAL_EXPIRING'),
      failedAttempt(2, 'EXECUTION_START_INTERRUPTED'), failedAttempt(3, 'AGENT_FAILED')]
    const { sql, execution } = retryStore(attempts, [attempts[0]!.id, attempts[1]!.id])
    await expect(allowTechnicalRetryLocked(sql, run, version, execution)).resolves.toBe(true)
  })

  it('stops at three Agent failures even when infrastructure attempts are interleaved', async () => {
    const attempts = [failedAttempt(1, 'AGENT_FAILED'), failedAttempt(2, 'WORKER_CREDENTIAL_EXPIRING'),
      failedAttempt(3, 'AGENT_FAILED'), failedAttempt(4, 'EXECUTION_START_INTERRUPTED'),
      failedAttempt(5, 'AGENT_FAILED')]
    const { sql, execution } = retryStore(attempts, [attempts[1]!.id, attempts[3]!.id])
    await expect(allowTechnicalRetryLocked(sql, run, version, execution)).resolves.toBe(false)
  })

  it('does not retry a non-retryable Agent failure', async () => {
    const failed = failedAttempt(1, 'AGENT_FAILED')
    failed.result!.error!.retryable = false
    const { sql, execution } = retryStore([failed], [])
    await expect(allowTechnicalRetryLocked(sql, run, version, execution)).resolves.toBe(false)
  })

  it.each(['stop', 'cleanup', 'capacity'] as const)('preserves the %s boundary for infrastructure retries', async boundary => {
    if (boundary === 'capacity') vi.mocked(capacity.hasWorkflowExecutionCapacityLocked).mockResolvedValue(false)
    else vi.mocked(snapshots.readAcceptedRepeatRunLocked).mockResolvedValue({
      run, version, configurations: [], stopRequested: boundary === 'stop', cleanupPending: boundary === 'cleanup',
    })
    const { sql, execution } = retryStore([failedAttempt(1, 'WORKER_CREDENTIAL_EXPIRING')])
    await expect(allowTechnicalRetryLocked(sql, run, version, execution)).resolves.toBe(false)
  })
})
