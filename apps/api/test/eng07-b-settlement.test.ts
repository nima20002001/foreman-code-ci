import { describe, expect, it, vi } from 'vitest'
import { RunRecordDetailSchema, makeCurrentWorkflowFixture, type RunRecordDetail } from '@foreman-code/contracts/wave25'
import { waitForSuccessfulRunCleanup } from './helpers/runSettlement.testSupport.js'

type Intent = { pending: boolean; attempts: number } | undefined
const source = makeCurrentWorkflowFixture('eng07-settlement', 'sequential')
function record(patch: Partial<RunRecordDetail> = {}): RunRecordDetail {
  return RunRecordDetailSchema.parse({ run: { ...source.run, executionState: 'completed', outcome: 'succeeded',
    result: { outcome: 'succeeded', output: { secret: 'DO-NOT-LOG-RESULT' } },
    startedAt: source.createdAt, finishedAt: source.createdAt }, stopRequested: false, cleanupPending: false, ...patch })
}
function fixture(samples: Array<{ intent: Intent; record: RunRecordDetail }>) {
  let reads = 0
  const query = vi.fn(async (sql: string, args: unknown[]) => {
    expect(sql).toBe('select pending,attempts from run_cleanup_intents where run_id=$1')
    expect(args).toEqual([source.run.id])
    const { intent } = samples[Math.min(reads, samples.length - 1)]!
    return { rows: intent ? [intent] : [] }
  })
  const readRecord = vi.fn(async () => samples[Math.min(reads++, samples.length - 1)]!.record)
  const input = { pool: { query } as unknown as Parameters<typeof waitForSuccessfulRunCleanup>[0]['pool'],
    runId: source.run.id, readRecord, timeoutMs: 1000, intervalMs: 1 }
  return { input, query, readRecord }
}
const checked = { pending: false, attempts: 1 }

describe('ENG07-B successful Run settlement barrier', () => {
  it('rejects missing or unchecked evidence and waits for settled public readback', async () => {
    const expected = record(), f = fixture([
      { intent: undefined, record: expected }, // Fault sample: missing evidence, not a normal successful commit.
      { intent: { pending: true, attempts: 0 }, record: record({ cleanupPending: true }) },
      { intent: { pending: false, attempts: 0 }, record: expected }, // Not a positive cleanup check.
      { intent: checked, record: record({ cleanupPending: true }) },
      { intent: checked, record: expected },
    ])
    expect(await waitForSuccessfulRunCleanup(f.input)).toEqual(expected)
    expect(f.query).toHaveBeenCalledTimes(5)
    expect(f.readRecord).toHaveBeenCalledTimes(5)
  })

  it('does not mistake a running Run for a successful terminal Run', async () => {
    const expected = record(), running = record({ run: { ...source.run, executionState: 'running', outcome: 'pending' } })
    const f = fixture([{ intent: checked, record: running }, { intent: checked, record: expected }])
    expect(await waitForSuccessfulRunCleanup(f.input)).toEqual(expected)
    expect(f.readRecord).toHaveBeenCalledTimes(2)
  })

  it.each([
    { name: 'missing intent', intent: undefined, pending: false },
    { name: 'unchecked intent', intent: { pending: false, attempts: 0 }, pending: false },
    { name: 'pending intent after failed checks', intent: { pending: true, attempts: 3 }, pending: true },
    { name: 'pending public cleanup', intent: checked, pending: true },
  ])('times out rather than hiding $name', async ({ intent, pending }) => {
    const f = fixture([{ intent, record: record({ cleanupPending: pending }) }])
    await expect(waitForSuccessfulRunCleanup({ ...f.input, timeoutMs: 20 }))
      .rejects.toThrow('Run cleanup did not settle:')
  })

  it.each(['failed', 'canceled'] as const)('never counts a settled %s Run as success', async (outcome) => {
    const terminal = record(), f = fixture([{ intent: checked, record: record({ run: {
      ...terminal.run, outcome, result: { outcome, ...(outcome === 'failed' ? {
        error: { code: 'EXPECTED_TEST_FAILURE', message: 'Expected failed Run', retryable: false },
      } : {}) },
    } }) }])
    await expect(waitForSuccessfulRunCleanup({ ...f.input, timeoutMs: 20 }))
      .rejects.toThrow(`"outcome":"${outcome}"`)
  })

  it('requires Stop to remain absent', async () => {
    const f = fixture([{ intent: checked, record: record({ stopRequested: true }) }])
    await expect(waitForSuccessfulRunCleanup({ ...f.input, timeoutMs: 20 }))
      .rejects.toThrow('"stopRequested":true')
  })

  it('propagates an authorization/read failure without polling it away', async () => {
    const f = fixture([{ intent: checked, record: record() }]), denied = new Error('ACCESS_DENIED')
    f.readRecord.mockRejectedValueOnce(denied)
    await expect(waitForSuccessfulRunCleanup(f.input)).rejects.toBe(denied)
    expect(f.query).toHaveBeenCalledTimes(1); expect(f.readRecord).toHaveBeenCalledTimes(1)
  })

  it('propagates SQL failures before attempting the public read', async () => {
    const f = fixture([{ intent: checked, record: record() }]), unavailable = new Error('database unavailable')
    f.query.mockRejectedValueOnce(unavailable)
    await expect(waitForSuccessfulRunCleanup(f.input)).rejects.toBe(unavailable)
    expect(f.readRecord).not.toHaveBeenCalled()
  })

  it('rejects a readback for another Run', async () => {
    const value = record(), f = fixture([{ intent: checked, record: record({ run: { ...value.run, id: 'wrong-run' } }) }])
    await expect(waitForSuccessfulRunCleanup(f.input)).rejects.toThrow('Settlement read returned a different Run')
    expect(f.query).toHaveBeenCalledTimes(1)
  })

  it('reports content-free state on timeout, not private result or location data', async () => {
    const value = record(), f = fixture([{ intent: undefined, record: value }])
    const error = await waitForSuccessfulRunCleanup({ ...f.input, timeoutMs: 20 }).catch((failure: unknown) => failure)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('"intentPresent":false')
    expect(message).not.toContain('DO-NOT-LOG-RESULT')
    expect(message).not.toContain('executionLocation')
    expect(message).not.toContain('authorizationPrincipalId')
  })
})
