import { beforeEach, expect, it, vi } from 'vitest'
import { systemSyncthingPorts } from './syncthingSystem.js'

const filesystem = vi.hoisted(() => ({ inspected: 0, conflictAt: -1, nested: false }))
beforeEach(() => { filesystem.inspected = 0; filesystem.conflictAt = -1; filesystem.nested = false })
vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  const entry = { name: 'ordinary.txt', isFile: () => { filesystem.inspected++; return true }, isDirectory: () => false }
  return { ...original,
    readdir: async () => Array.from({ length: 20_000 }, () => entry),
    opendir: async (path: string) => ({
      async *[Symbol.asyncIterator]() {
        if (path.endsWith('/nested')) {
          yield { ...entry, name: 'late.sync-conflict-20261016.txt' }
          return
        }
        for (let index = 0; index < 20_000; index++) {
          if (index === 9_999 && filesystem.nested) {
            yield { name: 'nested', isFile: () => false, isDirectory: () => true }
          } else {
            yield { ...entry, name: index === filesystem.conflictAt ? 'late.sync-conflict-20261016.txt' : `ordinary-${index}.txt` }
          }
        }
      },
    }),
  }
})

it('bounds conflict traversal even when every file is ordinary', async () => {
  const ports = systemSyncthingPorts()
  expect(await ports.conflicts('/shared/workspace')).toEqual([])
  expect(filesystem.inspected).toBe(10_000)
})


it.each([false, true])('resumes bounded scans to find later conflicts with nested=%s', async nested => {
  filesystem.conflictAt = nested ? -1 : 10_000
  filesystem.nested = nested
  const ports = systemSyncthingPorts()
  expect(await ports.conflicts('/shared/workspace')).toEqual([])
  const names = new Set<string>()
  for (let index = 0; index < 3; index++) {
    const inspected = filesystem.inspected
    for (const name of await ports.conflicts('/shared/workspace')) names.add(name)
    expect(filesystem.inspected - inspected).toBeLessThanOrEqual(10_000)
  }
  expect([...names]).toEqual([nested ? 'nested/late.sync-conflict-20261016.txt' : 'late.sync-conflict-20261016.txt'])
})


it('retains discovered conflicts across slices and removes them after a complete rescan', async () => {
  filesystem.conflictAt = 0
  const ports = systemSyncthingPorts()
  const names = ['late.sync-conflict-20261016.txt']
  expect(await ports.conflicts('/shared/workspace')).toEqual(names)
  expect(await ports.conflicts('/shared/workspace')).toEqual(names)
  expect(await ports.conflicts('/shared/workspace')).toEqual(names)
  filesystem.conflictAt = -1
  expect(await ports.conflicts('/shared/workspace')).toEqual(names)
  expect(await ports.conflicts('/shared/workspace')).toEqual(names)
  expect(await ports.conflicts('/shared/workspace')).toEqual([])
})
