import { beforeEach, expect, it, vi } from 'vitest'
const fake = vi.hoisted(() => ({ open: vi.fn(), statfs: vi.fn(), close: vi.fn(), stat: vi.fn(), read: vi.fn() }))
vi.mock('node:fs/promises', () => ({ open: fake.open, statfs: fake.statfs }))
vi.mock('./linuxProcfs.js', async original => ({ ...await original<typeof import('./linuxProcfs.js')>(), readBounded: fake.read }))
import { constants } from 'node:fs'
import { accountingHandle } from './linuxCgroup.js'
const boundary = { kind: 'cgroup-v2' as const, path: '/sys/fs/cgroup/registered', device: '2', inode: '3' }
beforeEach(() => {
  vi.resetAllMocks(); fake.open.mockResolvedValue({ fd: 12, stat: fake.stat, close: fake.close }); fake.close.mockResolvedValue(undefined)
  fake.stat.mockResolvedValue({ dev: 2n, ino: 3n }); fake.statfs.mockResolvedValue({ type: 0x63677270 })
  fake.read.mockImplementation(async path => path.endsWith('cpu.stat') ? 'usage_usec 100\n' : '2048\n')
})
it('uses fd-pinned source and no-follow directory, closes after capture', async () => {
  const result = await accountingHandle(boundary, true).read(new AbortController().signal)
  expect(result).toEqual({ cpu: 100n, memory: 2048, cpuFailure: null, memoryFailure: null })
  expect(fake.open).toHaveBeenCalledWith(boundary.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  expect(fake.read.mock.calls.map(call => call[0])).toEqual(['/proc/self/fd/12/cpu.stat', '/proc/self/fd/12/memory.current']); expect(fake.close).toHaveBeenCalledOnce()
})
it('rejects inode/path reuse and joins close', async () => { fake.stat.mockResolvedValue({ dev: 2n, ino: 4n }); await expect(accountingHandle(boundary, true).read(new AbortController().signal)).rejects.toThrow('identity-changed'); expect(fake.close).toHaveBeenCalledOnce(); expect(fake.read).not.toHaveBeenCalled() })
it('rejects identity replacement during reads', async () => { fake.stat.mockResolvedValueOnce({ dev: 2n, ino: 3n }).mockResolvedValueOnce({ dev: 2n, ino: 4n }); await expect(accountingHandle(boundary, true).read(new AbortController().signal)).rejects.toThrow('identity-changed'); expect(fake.close).toHaveBeenCalledOnce() })
it('rejects non-cgroup filesystem', async () => { fake.statfs.mockResolvedValue({ type: 1 }); await expect(accountingHandle(boundary, true).read(new AbortController().signal)).rejects.toThrow('identity-changed'); expect(fake.close).toHaveBeenCalledOnce() })
it('rejects symlink open without alternative path', async () => { fake.open.mockRejectedValue(Object.assign(new Error('symlink'), { code: 'ELOOP' })); await expect(accountingHandle(boundary, true).read(new AbortController().signal)).rejects.toThrow('symlink'); expect(fake.read).not.toHaveBeenCalled() })
it('preserves missing versus denied with independent RAM', async () => { fake.read.mockImplementation(async path => { if (path.endsWith('cpu.stat')) throw Object.assign(new Error(), { code: 'EACCES' }); return '0' }); expect(await accountingHandle(boundary, true).read(new AbortController().signal)).toMatchObject({ cpu: null, cpuFailure: 'permission-denied', memory: 0 }); expect(fake.close).toHaveBeenCalledOnce() })
it('abort after read still closes pinned fd', async () => { const abort = new AbortController(); fake.read.mockImplementation(async path => { if (path.endsWith('memory.current')) abort.abort(); return path.endsWith('cpu.stat') ? 'usage_usec 100' : '0' }); await expect(accountingHandle(boundary, true).read(abort.signal)).rejects.toThrow(); expect(fake.close).toHaveBeenCalledOnce() })
it('invalid memory does not erase valid CPU', async () => { fake.read.mockImplementation(async path => path.endsWith('cpu.stat') ? 'usage_usec 100' : '-1'); expect(await accountingHandle(boundary, true).read(new AbortController().signal)).toMatchObject({ cpu: 100n, memory: null, memoryFailure: 'invalid-counter' }) })
it('retains the original certificate when its producer record is later replaced', async () => {
  const captured = { ...boundary }; const handle = accountingHandle(captured, true)
  captured.path = '/sys/fs/cgroup/replacement'; captured.inode = '99'
  expect(await handle.read(new AbortController().signal)).toMatchObject({ cpu: 100n, memory: 2048 })
  expect(fake.open.mock.calls[0]?.[0]).toBe(boundary.path); expect(handle.boundary).toEqual(boundary)
})
