import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'
import { prepareWorkerConversationMcp } from './workerMcpAccess.js'

afterEach(() => vi.useRealTimers())

async function prepare(delayMs: number) {
  const f = workerConversationFixture()
  const controller = new AbortController()
  let callSignal: AbortSignal | undefined
  const request = vi.fn(async (_namespace: string, raw: unknown,
    options: { signal: AbortSignal; timeoutMs?: number }): Promise<DeviceApplicationResult> => {
    if ((raw as { operation: string }).operation === 'conversation-mcp.authorize') {
      return { payload: { expiresAt: new Date(Date.now() + 600_000).toISOString() } }
    }
    callSignal = options.signal
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => {
        clearTimeout(response)
        clearTimeout(timeout)
        options.signal.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve({ payload: { statusCode: 200, contentType: 'application/json', body: '{"state":"passed"}' } })
      }
      const abort = () => finish(options.signal.reason)
      const response = setTimeout(() => finish(), delayMs)
      const timeout = setTimeout(() => finish(new DeviceApplicationError('timeout')), options.timeoutMs ?? 30_000)
      options.signal.addEventListener('abort', abort, { once: true })
    })
  })
  const relay = await prepareWorkerConversationMcp({ source: { method: 'conversation.status',
    binding: { ...f.binding, appMcpAccess: 'scoped' }, admissionId: randomUUID() },
    token: 'operator-test-token', signal: controller.signal, request })
  return { relay, controller, request, callSignal: () => callSignal }
}

it('completes a supported sixty-second Operator wait without the default channel timeout', async () => {
  vi.useFakeTimers()
  const f = await prepare(60_000)
  const pending = f.relay.request({ jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'ci_get', arguments: { waitSeconds: 60 } } })
  const checked = expect(pending).resolves.toMatchObject({ body: '{"state":"passed"}' })
  await Promise.allSettled([checked, vi.advanceTimersByTimeAsync(60_000)])
  await checked
  expect(f.request.mock.calls[1]![2].timeoutMs).toBe(120_000)
})

it('answers stalled Operator calls at the relay deadline and does not replay them', async () => {
  vi.useFakeTimers()
  const f = await prepare(150_000)
  let settled: unknown
  const pending = f.relay.request({ method: 'tools/call' }).catch(error => { settled = error })
  await vi.advanceTimersByTimeAsync(99_999)
  expect(settled).toBeUndefined()
  await vi.advanceTimersByTimeAsync(1)
  expect(settled).toMatchObject({ code: 'timeout', retryable: true })
  expect(f.callSignal()?.aborted).toBe(true)
  await pending
  expect(f.request).toHaveBeenCalledTimes(2)
})

it('cancels an in-flight Operator call without waiting for its deadline', async () => {
  vi.useFakeTimers()
  const f = await prepare(60_000)
  const cause = new Error('Operator turn ended')
  const pending = f.relay.request({ method: 'tools/list' })
  const checked = expect(pending).rejects.toBe(cause)
  f.controller.abort(cause)
  await checked
  expect(f.callSignal()?.aborted).toBe(true)
  expect(f.request).toHaveBeenCalledTimes(2)
})
