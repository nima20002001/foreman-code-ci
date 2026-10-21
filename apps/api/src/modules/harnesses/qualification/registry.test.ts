import { afterEach, expect, it, vi } from 'vitest'
import { HarnessQualificationRegistry } from './registry.js'
import { retryStartupDatabase } from '../../../infrastructure/startupDatabase.js'

afterEach(() => { vi.useRealTimers() })

it('returns repository failures directly when no startup retry policy is supplied', async () => {
  const failure = new Error('Query read timeout')
  const list = vi.fn().mockRejectedValue(failure)
  const registry = new HarnessQualificationRegistry({ list, find: async () => null }, {})
  await expect(registry.load()).rejects.toBe(failure)
  expect(list).toHaveBeenCalledOnce()
})

it('loads saved qualifications after a transient database read timeout', async () => {
  vi.useFakeTimers()
  const list = vi.fn().mockRejectedValueOnce(new Error('Query read timeout')).mockResolvedValue([])
  const registry = new HarnessQualificationRegistry({ list, find: async () => null }, {})
  const loaded = registry.load(retryStartupDatabase).catch(error => error)
  await vi.advanceTimersByTimeAsync(100)
  expect(await loaded).toBeUndefined()
  expect(list).toHaveBeenCalledTimes(2)
})

it('does not retry saved qualification loading when database authentication fails', async () => {
  const failure = Object.assign(new Error('password authentication failed'), { code: '28P01' })
  const list = vi.fn().mockRejectedValue(failure)
  const registry = new HarnessQualificationRegistry({ list, find: async () => null }, {})
  await expect(registry.load(retryStartupDatabase)).rejects.toBe(failure)
  expect(list).toHaveBeenCalledOnce()
})

it('cancels saved qualification loading during shutdown without another database read', async () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const list = vi.fn().mockRejectedValue(new Error('Query read timeout'))
  const registry = new HarnessQualificationRegistry({ list, find: async () => null }, {})
  const loaded = registry.load(work => retryStartupDatabase(work, { signal: controller.signal })).catch(error => error)
  await vi.advanceTimersByTimeAsync(0)
  const reason = new Error('Startup is closing')
  controller.abort(reason)
  expect(await loaded).toMatchObject({ name: 'AbortError', cause: reason })
  await vi.advanceTimersByTimeAsync(5_000)
  expect(list).toHaveBeenCalledOnce()
})
