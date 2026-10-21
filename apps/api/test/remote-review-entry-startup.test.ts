import { afterEach, expect, it, vi } from 'vitest'
import { waitForRequesterSession } from './helpers/remoteReviewEntryStartup.js'

afterEach(() => { vi.useRealTimers() })

it('gives the reviewer and requester separate native startup waits', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const started = performance.now()
  const waiting = waitForRequesterSession({
    entryNodeId: 'reviewer',
    readExecutions: async () => [{
      id: 'reviewer-execution', workflowNodeId: 'reviewer',
      state: performance.now() - started >= 60_000 ? 'completed' : 'starting',
      ...(performance.now() - started >= 60_000 ? { result: { outcome: 'succeeded' as const } } : {}),
    }],
    readCalls: async () => performance.now() - started >= 120_000
      ? [{ requesterSessionBlocked: { pid: 123 } }] : [],
    reconcile: async () => {},
  }).then(calls => ({ calls }), error => ({ error }))
  await vi.advanceTimersByTimeAsync(120_000)
  expect(await waiting).toEqual({ calls: [{ requesterSessionBlocked: { pid: 123 } }] })
})

it('reconciles the workflow while waiting for requester session creation', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  let reconciliations = 0
  const waiting = waitForRequesterSession({
    entryNodeId: 'reviewer',
    readExecutions: async () => [{
      id: 'reviewer-execution', workflowNodeId: 'reviewer',
      state: reconciliations > 0 ? 'completed' : 'starting',
      ...(reconciliations > 0 ? { result: { outcome: 'succeeded' as const } } : {}),
    }],
    readCalls: async () => reconciliations > 1 ? [{ requesterSessionBlocked: { pid: 123 } }] : [],
    reconcile: async () => { reconciliations += 1 },
  }).then(calls => ({ calls }), error => ({ error }))
  await vi.advanceTimersByTimeAsync(90_000)
  expect(await waiting).toEqual({ calls: [{ requesterSessionBlocked: { pid: 123 } }] })
})
