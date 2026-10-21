import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readRecord, writeRecord } from '../src/modules/harnesses/recovery/storage.js'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, fstatSync: vi.fn(actual.fstatSync), linkSync: vi.fn(actual.linkSync) }
})

const directories: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = fs.mkdtempSync(join(tmpdir(), 'recovery-record-'))
  directories.push(directory)
  const path = join(directory, 'record.json')
  const value = { launchId: 'original', closed: true }
  writeRecord(path, value, true)
  return { directory, path, value }
}

describe('recovery record reads', () => {
  it('reads an immutable record while its writer is paused before removing the temporary link', async () => {
    const f = fixture()
    const path = join(f.directory, 'publishing.json')
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fs.linkSync).mockImplementationOnce((temporary, destination) => {
      actual.linkSync(temporary, destination)
      expect(fs.statSync(path).nlink).toBe(2)
      expect(readRecord(path)).toEqual(f.value)
    })

    writeRecord(path, f.value, true)
    expect(readRecord(path)).toEqual(f.value)
    expect(fs.statSync(path).nlink).toBe(1)
  })

  it('reads a complete publication whose writer exited before removing the temporary link', () => {
    const f = fixture()
    fs.linkSync(f.path, join(f.directory, `.pending-${randomUUID()}`))

    expect(readRecord(f.path)).toEqual(f.value)
    expect(fs.statSync(f.path).nlink).toBe(2)
  })

  it('reads a completed immutable publication after its temporary hard link disappears', async () => {
    const f = fixture()
    const temporary = join(f.directory, '.pending-publication')
    fs.linkSync(f.path, temporary)
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fs.fstatSync).mockImplementationOnce(((fd: number) => {
      const stat = actual.fstatSync(fd)
      fs.unlinkSync(temporary)
      return stat
    }) as typeof fs.fstatSync)

    expect(readRecord(f.path)).toEqual(f.value)
    expect(fs.statSync(f.path).nlink).toBe(1)
  })

  it('rejects a record whose extra hard link remains', () => {
    const f = fixture()
    fs.linkSync(f.path, join(f.directory, 'retained-link'))
    expect(() => readRecord(f.path)).toThrow('Unsafe or oversized recovery record.')
  })

  it('rejects an unrelated hard link even when a pending file exists', () => {
    const f = fixture()
    fs.linkSync(f.path, join(f.directory, 'retained-link'))
    fs.writeFileSync(join(f.directory, `.pending-${randomUUID()}`), JSON.stringify(f.value), { mode: 0o600 })
    expect(() => readRecord(f.path)).toThrow('Unsafe or oversized recovery record.')
  })

  it('rejects more than two links even when one is a publication link', () => {
    const f = fixture()
    fs.linkSync(f.path, join(f.directory, `.pending-${randomUUID()}`))
    fs.linkSync(f.path, join(f.directory, 'retained-link'))
    expect(() => readRecord(f.path)).toThrow('Unsafe or oversized recovery record.')
  })

  it('does not count the record itself as its temporary publication link', () => {
    const f = fixture()
    const temporary = join(f.directory, `.pending-${randomUUID()}`)
    fs.linkSync(f.path, temporary)
    expect(() => readRecord(temporary)).toThrow('Unsafe or oversized recovery record.')
  })

  it('rejects a symlink posing as the temporary publication link', () => {
    const f = fixture()
    fs.linkSync(f.path, join(f.directory, 'retained-link'))
    fs.symlinkSync(f.path, join(f.directory, `.pending-${randomUUID()}`))
    expect(() => readRecord(f.path)).toThrow('Unsafe or oversized recovery record.')
  })

  it('rejects a publication link in a nonprivate directory', () => {
    const f = fixture()
    fs.linkSync(f.path, join(f.directory, `.pending-${randomUUID()}`))
    fs.chmodSync(f.directory, 0o755)
    expect(() => readRecord(f.path)).toThrow('Nonprivate native observation directory.')
  })

  it('preserves the first immutable record when another writer publishes to the same path', () => {
    const f = fixture()
    expect(() => writeRecord(f.path, { launchId: 'other' }, true)).toThrow()
    expect(readRecord(f.path)).toEqual(f.value)
    expect(fs.statSync(f.path).nlink).toBe(1)
  })

  it.each(['nonprivate', 'oversized', 'symlink'] as const)('rejects a %s record', (kind) => {
    const f = fixture()
    if (kind === 'nonprivate') fs.chmodSync(f.path, 0o640)
    if (kind === 'oversized') fs.writeFileSync(f.path, 'x'.repeat(64 * 1024 + 1))
    const path = kind === 'symlink' ? join(f.directory, 'symlink.json') : f.path
    if (kind === 'symlink') fs.symlinkSync(f.path, path)
    expect(() => readRecord(path)).toThrow()
  })

  it.each(['nonprivate', 'oversized'] as const)('rejects a %s record during publication', (kind) => {
    const f = fixture()
    fs.linkSync(f.path, join(f.directory, `.pending-${randomUUID()}`))
    if (kind === 'nonprivate') fs.chmodSync(f.path, 0o640)
    if (kind === 'oversized') fs.writeFileSync(f.path, 'x'.repeat(64 * 1024 + 1))
    expect(() => readRecord(f.path)).toThrow('Unsafe or oversized recovery record.')
  })
})
