import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionResult } from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { settleWorkflowRun } from '../src/modules/runs/workflowLifecycle.js'
import { currentUnitSnapshot } from './helpers/currentUnitSnapshot.js'

const ports = vi.hoisted(() => ({
  open: vi.fn(),
  readRun: vi.fn(),
  readPublicState: vi.fn(),
  assertSettlement: vi.fn(),
  commitChecks: [] as Array<() => Promise<void>>,
}))

vi.mock('../src/modules/runs/repeatLifecycle.js', () => ({ openWorkflowLifecycleLocked: ports.open }))
vi.mock('../src/modules/runs/repeatStartRead.js', () => ({ readAcceptedRepeatRunLocked: ports.readRun }))
vi.mock('../src/modules/run-graph/publicRunState.js', () => ({ readPublicRunStateLocked: ports.readPublicState }))
vi.mock('../src/modules/run-graph/connection.js', () => ({
  beforeGraphCommit: (_sql: unknown, check: () => Promise<void>) => ports.commitChecks.push(check),
  poisonGraphTransaction: vi.fn(),
  withExclusiveGraphConnection: vi.fn(),
}))
vi.mock('../src/modules/run-graph/repeatReceipts.js', () => ({ requireRepeatCanonicalReceiptBeforeCommit: vi.fn() }))
vi.mock('../src/modules/runs/workflowRepositoryServices.js', () => ({
  assertWorkflowRunSettlementLocked: ports.assertSettlement,
}))
vi.mock('../src/modules/runs/repeatPostgres.js', () => ({ readRepeatExecutionLocked: vi.fn() }))

function failure(code: string, retryable = false): ExecutionResult {
  return { outcome: 'failed', error: { code, message: `Failure: ${code}`, retryable } }
}

interface FailedCandidate {
  result: ExecutionResult
  failed_resolution: boolean
}

function fixture(candidates: FailedCandidate[], options: { stopped?: boolean; failure?: ExecutionResult } = {}) {
  const f = currentUnitSnapshot('failure-cause', 'parallel')
  let run = { ...f.run }
  const query = vi.fn().mockResolvedValueOnce({ rows: [{ failure_result: options.failure ?? null }] })
  if (!options.failure && !options.stopped) {
    // Candidate executions are supplied in the database's newest-first order.
    query.mockResolvedValueOnce({ rows: candidates })
  }
  query.mockImplementation(async (_statement: string, values: unknown[]) => {
    run = JSON.parse(values[2] as string)
    return { rows: [], rowCount: 1 }
  })
  const sql = { query, transaction: true } as unknown as GraphTransactionSql
  const snapshot = () => ({ ...f, run: structuredClone(run), cleanupPending: true, stopRequested: options.stopped ?? false })
  const publication = {
    sql,
    scope: f.scope,
    source: async (_source: unknown, mutate: () => Promise<void>) => mutate(),
  }
  ports.open.mockImplementation(async () => ({ publication, snapshot: snapshot() }))
  ports.readRun.mockImplementation(async () => snapshot())
  ports.readPublicState.mockImplementation(async () => ({ executionState: run.executionState, outcome: run.outcome }))
  const fence = { ownerId: 'owner-fixture', fence: 1 }
  const owner = {
    runId: run.id,
    assertOwned: vi.fn(),
    readOneShotFence: async () => fence,
    oneShotConnection: () => ({
      transaction: async <T>(work: (transaction: GraphTransactionSql) => Promise<T>) => {
        const result = await work(sql)
        for (const check of ports.commitChecks) await check()
        return result
      },
    }),
  } as unknown as RunOwnership
  return { owner, readRun: () => structuredClone(run) }
}

beforeEach(() => {
  vi.clearAllMocks()
  ports.commitChecks.length = 0
})

describe('workflow failure cause', () => {
  it('keeps the exhausted node failure when a newer parallel sibling is interrupted by cleanup', async () => {
    const cause = failure('NATIVE_TURN_FAILED', true)
    const f = fixture([
      { result: failure('EXECUTION_INTERRUPTED'), failed_resolution: false },
      { result: cause, failed_resolution: true },
    ])

    expect(await settleWorkflowRun(f.owner)).toBe(true)
    expect(f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'failed', result: cause })
  })

  it('ignores a newer superseded failed attempt when choosing a resolved node failure', async () => {
    const cause = failure('NODE_RETRIES_EXHAUSTED', true)
    const f = fixture([
      { result: failure('TEMPORARY_PROVIDER_FAILURE', true), failed_resolution: false },
      { result: cause, failed_resolution: true },
    ])

    await settleWorkflowRun(f.owner)
    expect(f.readRun().result).toEqual(cause)
  })

  it('uses the generic failure when only cleanup interruptions and unresolved attempts remain', async () => {
    const f = fixture([
      { result: failure('EXECUTION_INTERRUPTED'), failed_resolution: false },
      { result: failure('TEMPORARY_PROVIDER_FAILURE', true), failed_resolution: false },
    ])

    await settleWorkflowRun(f.owner)
    expect(f.readRun().result).toMatchObject({
      outcome: 'failed', error: { code: 'WORKFLOW_SELECTED_EXECUTION_FAILED', retryable: false },
    })
  })

  it('preserves the recorded interruption cause when settling an interrupted run', async () => {
    const cause = failure('EXECUTION_INTERRUPTED')
    const f = fixture([{ result: cause, failed_resolution: false }])

    await settleWorkflowRun(f.owner, true)
    expect(f.readRun().result).toEqual(cause)
  })

  it('preserves an explicit cleanup failure', async () => {
    const cause = failure('PREPARATION_FAILED')
    const f = fixture([], { failure: cause })

    await settleWorkflowRun(f.owner)
    expect(f.readRun().result).toEqual(cause)
  })

  it('gives Stop precedence over an explicit failure', async () => {
    const f = fixture([], { stopped: true, failure: failure('NATIVE_TURN_FAILED') })

    await settleWorkflowRun(f.owner)
    expect(f.readRun()).toMatchObject({ outcome: 'canceled', result: { outcome: 'canceled' } })
  })
})
