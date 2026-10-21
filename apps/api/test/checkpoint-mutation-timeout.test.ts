import type pg from 'pg'
import { emptyCheckpoint } from '@langchain/langgraph-checkpoint'
import { afterEach, expect, it, vi } from 'vitest'
import { ApprovalPostgresSaver } from '../src/infrastructure/approvalCheckpointSaver.js'

afterEach(() => vi.restoreAllMocks())

const config = { configurable: {
  thread_id: 'checkpoint-timeout-run', checkpoint_ns: '', checkpoint_id: 'checkpoint-parent',
  checkpoint_owner_generation: '7',
} }
const empty = { rows: [], rowCount: 0 }

function fixture(failures: Error[], failureAt = 1, advanceClock = () => {}) {
  const releases: ReturnType<typeof vi.fn>[] = []
  const connect = vi.fn(async () => {
    const failure = failures.shift()
    let statement = 0
    const replies = [empty, { rows: [{ generation: '7' }], rowCount: 1 }, { rows: [], rowCount: 1 }]
    const release = vi.fn()
    releases.push(release)
    return {
      release,
      query: vi.fn(async () => {
        const index = statement++
        if (failure && index === failureAt) {
          advanceClock()
          throw failure
        }
        return replies[index] ?? empty
      }),
    }
  })
  const saver = new ApprovalPostgresSaver({ connect } as unknown as pg.Pool)
  return { saver, connect, releases }
}

function write(saver: ApprovalPostgresSaver, operation: 'put' | 'putWrites') {
  if (operation === 'putWrites') return saver.putWrites(config, [['__interrupt__', [{ id: 'approval' }]]], 'task')
  return saver.put(config, emptyCheckpoint(), { source: 'loop', step: 1, parents: {} }, {})
}

it.each(['put', 'putWrites'] as const)('retries an owner-query timeout in %s and notifies after persistence', async operation => {
  const f = fixture([new Error('Query read timeout')])
  const observer = vi.fn(async () => {})
  f.saver.observeApprovalInterrupts(config.configurable.thread_id, observer)
  await write(f.saver, operation)
  expect(f.connect).toHaveBeenCalledTimes(2)
  expect(f.releases).toHaveLength(2)
  for (const release of f.releases) expect(release).toHaveBeenCalledOnce()
  expect(observer).toHaveBeenCalledTimes(operation === 'putWrites' ? 1 : 0)
})

it.each([0, 3, 4])('retries the whole checkpoint write after a timeout at transaction step %s', async failureAt => {
  const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
  const f = fixture([timeout], failureAt)
  await write(f.saver, 'putWrites')
  expect(f.connect).toHaveBeenCalledTimes(2)
  for (const release of f.releases) expect(release).toHaveBeenCalledOnce()
})

it.each(['put', 'putWrites'] as const)('returns exhausted %s timeouts to the caller without publishing approval', async operation => {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const timeout = new Error('Query read timeout')
  const f = fixture([timeout, timeout], 1, () => { now += 15_000 })
  const observer = vi.fn(async () => {})
  f.saver.observeApprovalInterrupts(config.configurable.thread_id, observer)
  await expect(write(f.saver, operation)).rejects.toMatchObject({
    code: 'DATABASE_RETRY_DEADLINE_EXCEEDED', cause: timeout,
  })
  expect(f.connect).toHaveBeenCalledTimes(2)
  expect(observer).not.toHaveBeenCalled()
})

it('rejects ownership loss without retrying or notifying approval observers', async () => {
  const f = fixture([])
  f.connect.mockResolvedValueOnce({
    release: vi.fn(), query: vi.fn().mockResolvedValue(empty),
  })
  const observer = vi.fn(async () => {})
  f.saver.observeApprovalInterrupts(config.configurable.thread_id, observer)
  await expect(write(f.saver, 'putWrites')).rejects.toMatchObject({ code: 'RUN_OWNERSHIP_LOST' })
  expect(f.connect).toHaveBeenCalledOnce()
  expect(observer).not.toHaveBeenCalled()
})
