import { afterEach, expect, it, vi } from 'vitest'
import { APP_MCP_TIMEOUTS, appLauncherConnection } from '../src/modules/harnesses/appMcpLauncher.js'
import { nativeConnection } from '../src/modules/harnesses/nativeMcpCommon.js'
import { deviceRequestTimeoutMs } from '../src/modules/devices/deviceRequestRetry.js'
import { deviceForegroundWaitMs } from '../src/modules/devices/deviceRequestQueue.js'
import { withWorkerMcpDeadline, workerMcpUploadCeilingMs } from '../src/modules/devices/workerMcpDeadline.js'

afterEach(() => vi.useRealTimers())

it('configures the native client to outlast both queues, upload and execution', () => {
  const native = nativeConnection(appLauncherConnection())
  const budgetMs = deviceRequestTimeoutMs + deviceForegroundWaitMs + workerMcpUploadCeilingMs + 100_000
  expect(Number(native.tool_timeout_sec) * 1000).toBeGreaterThan(budgetMs)
  expect(APP_MCP_TIMEOUTS.startup_timeout_sec).toBe(60)
})

it('cancels a stalled upload after fifteen seconds even after two minutes of progress', async () => {
  vi.useFakeTimers()
  let active!: AbortSignal
  let progress!: (bytes: number) => void
  const pending = withWorkerMcpDeadline(async (signal, _uploaded, onProgress, started) => {
    active = signal
    progress = onProgress
    started()
    return new Promise<never>(() => {})
  }, undefined, { uploading: true })
  const result = expect(pending).rejects.toMatchObject({ code: 'timeout' })
  for (let index = 1; index <= 13; index++) {
    await vi.advanceTimersByTimeAsync(10_000)
    progress(index * 1024 * 1024)
    expect(active.aborted).toBe(false)
  }
  await vi.advanceTimersByTimeAsync(14_999)
  expect(active.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await result
  expect(active.aborted).toBe(true)
})
