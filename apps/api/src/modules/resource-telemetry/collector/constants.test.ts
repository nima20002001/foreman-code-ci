import { beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ execFile: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: fake.execFile }))
import { qualifyHostConstants } from './linuxProcfs.js'
beforeEach(() => vi.resetAllMocks())
it('qualifies fixed arguments once without inherited credentials', async () => {
  fake.execFile.mockImplementation((_file, args, _options, callback) => callback(null, args[0] === 'CLK_TCK' ? '250\n' : '16384\n'))
  expect(await qualifyHostConstants(new AbortController().signal)).toEqual({ clockTicksPerSecond: 250n, pageSize: 16384n })
  expect(fake.execFile).toHaveBeenCalledTimes(2)
  for (const call of fake.execFile.mock.calls) { expect(call[0]).toBe('/usr/bin/getconf'); expect(call[2]).toMatchObject({ timeout: 2000, maxBuffer: 128, cwd: '/', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' } }) }
})
it.each(['0', '-1', '18446744073709551616'])('rejects unqualified constant %s', async value => {
  fake.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, value))
  await expect(qualifyHostConstants(new AbortController().signal)).rejects.toThrow()
})
it('joins the second initialization subprocess when the first fails', async () => {
  let finish!: () => void
  fake.execFile.mockImplementation((_file, args, _options, callback) => { if (args[0] === 'CLK_TCK') callback(new Error('failure'), ''); else finish = () => callback(null, '4096') })
  let done = false; const result = qualifyHostConstants(new AbortController().signal).catch(() => { done = true })
  await Promise.resolve(); expect(done).toBe(false); finish(); await result; expect(done).toBe(true)
})
