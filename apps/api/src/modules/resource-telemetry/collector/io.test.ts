import { beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ open: vi.fn() }))
vi.mock('node:fs/promises', () => ({ open: fake.open }))
import { readBounded } from './linuxProcfs.js'
import { boundedReader } from './io.js'
beforeEach(() => vi.resetAllMocks())
it('bounds file bytes and closes after overflow', async () => {
  const close = vi.fn().mockResolvedValue(undefined); fake.open.mockResolvedValue({ close, read: async () => ({ bytesRead: 9 }) })
  await expect(readBounded('/proc/42/stat', new AbortController().signal, 8)).rejects.toThrow('limit-exceeded'); expect(close).toHaveBeenCalledOnce()
})
it('joins canceled in-flight fd read then closes', async () => {
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve }); const close = vi.fn().mockResolvedValue(undefined)
  fake.open.mockResolvedValue({ close, read: async () => { await gate; return { bytesRead: 0 } } })
  const abort = new AbortController(); const promise = readBounded('/proc/42/stat', abort.signal); await Promise.resolve(); await Promise.resolve(); abort.abort(); expect(close).not.toHaveBeenCalled(); release(); await expect(promise).rejects.toThrow(); expect(close).toHaveBeenCalledOnce()
})
it('limits open reads to eight and drains queued requests', async () => {
  let active = 0; let maximum = 0; const releases: Array<() => void> = []
  fake.open.mockImplementation(async () => { active++; maximum = Math.max(maximum, active); return {
    read: () => new Promise(resolve => releases.push(() => resolve({ bytesRead: 0 }))), close: async () => { active-- },
  } })
  const reader = boundedReader(); const requests = Array.from({ length: 12 }, () => reader.read('/proc/42/stat', new AbortController().signal))
  for (let round = 0; round < 10; round++) { await Promise.resolve(); await Promise.resolve(); releases.splice(0).forEach(release => release()) }
  await Promise.all(requests); expect(maximum).toBe(8); expect(active).toBe(0)
})
it('aborted queued requests never acquire file descriptors', async () => {
  const releases: Array<() => void> = []; fake.open.mockImplementation(async () => ({ read: () => new Promise(resolve => releases.push(() => resolve({ bytesRead: 0 }))), close: async () => {} }))
  const reader = boundedReader(1); const first = reader.read('/proc/42/stat', new AbortController().signal)
  const abort = new AbortController(); const second = reader.read('/proc/43/stat', abort.signal); const caught = expect(second).rejects.toThrow(); abort.abort()
  await Promise.resolve(); await Promise.resolve(); releases.forEach(release => release()); await first; await caught; expect(fake.open).toHaveBeenCalledOnce()
})
