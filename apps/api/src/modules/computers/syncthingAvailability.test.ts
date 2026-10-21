import { afterEach, expect, it, vi } from 'vitest'
import { systemSyncthingPorts } from './syncthingSystem.js'

const mock = vi.hoisted(() => ({ find: vi.fn(), run: vi.fn() }))
vi.mock('./accountProbe.js', () => ({ systemPorts: () => mock }))
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks() })

it('coalesces availability probes and bounds process calls until the cached observation expires', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  mock.find.mockResolvedValue('/tools/syncthing')
  mock.run.mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  const ports = systemSyncthingPorts({})
  const observations = await Promise.all(Array.from({ length: 10 }, () => ports.available()))
  expect(observations).toEqual(Array.from({ length: 10 }, () => ({ installed: true, running: true })))
  expect(mock.run).toHaveBeenCalledTimes(1)
  mock.run.mockResolvedValue({ code: 3, stdout: '', stderr: '' })
  vi.advanceTimersByTime(5000)
  expect(await ports.available()).toEqual({ installed: true, running: false })
  expect(mock.run).toHaveBeenCalledTimes(2)
  vi.setSystemTime(Date.now() - 1000)
  await ports.available()
  expect(mock.run).toHaveBeenCalledTimes(3)
})

it('invalidates cached availability when the selected installation changes', async () => {
  mock.find.mockResolvedValue('/tools/syncthing')
  mock.run.mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  const ports = systemSyncthingPorts({})
  await ports.available()
  mock.find.mockResolvedValue(null)
  expect(await ports.available()).toEqual({ installed: false, running: false })
  mock.find.mockResolvedValue('/replacement/syncthing')
  mock.run.mockResolvedValue({ code: 3, stdout: '', stderr: '' })
  expect(await ports.available()).toEqual({ installed: true, running: false })
  await ports.available()
  expect(mock.run).toHaveBeenCalledTimes(2)
})

it('does not reuse failed probes and honors an already canceled caller even with a cached result', async () => {
  mock.find.mockResolvedValue('/tools/syncthing')
  mock.run.mockRejectedValueOnce(new Error('Service manager unavailable'))
  const ports = systemSyncthingPorts({})
  await expect(ports.available()).rejects.toThrow('Service manager unavailable')
  mock.run.mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  await ports.available()
  const controller = new AbortController()
  controller.abort(new Error('Caller canceled'))
  await expect(ports.available(controller.signal)).rejects.toThrow('Caller canceled')
  await ports.available()
  expect(mock.run).toHaveBeenCalledTimes(2)
})

it('lets one caller cancel without canceling or duplicating another caller’s shared probe', async () => {
  mock.find.mockResolvedValue('/tools/syncthing')
  let finish!: () => void
  mock.run.mockImplementation((_file: string, _args: string[], signal: AbortSignal) =>
    new Promise((resolve, reject) => {
      finish = () => resolve({ code: 0, stdout: '', stderr: '' })
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
  const ports = systemSyncthingPorts({})
  const controller = new AbortController()
  const canceled = ports.available(controller.signal)
  const rejected = expect(canceled).rejects.toThrow('Caller canceled')
  const remaining = ports.available()
  await vi.waitFor(() => expect(mock.run).toHaveBeenCalled())
  controller.abort(new Error('Caller canceled'))
  await rejected
  finish()
  expect(await remaining).toEqual({ installed: true, running: true })
  expect(mock.run).toHaveBeenCalledTimes(1)
})
