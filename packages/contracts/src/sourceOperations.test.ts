import { expect, it } from 'vitest'
import { SourceStorageCapacitySchema, SOURCE_MATERIALIZATION_RECORD_MAX_BYTES } from './sourceOperations.js'
import { SOURCE_MANIFEST_MAX_BYTES } from './sourceMaterialization.js'

it('exposes the materialization record budget to source operation consumers', () => {
  expect(SOURCE_MATERIALIZATION_RECORD_MAX_BYTES).toBe(SOURCE_MANIFEST_MAX_BYTES + 64 * 1024)
})

const capacity = {
  filesystem: { device: '1', inode: '2', mountId: '3' },
  totalBytes: 16 * 2 ** 30,
  availableBytes: 8 * 2 ** 30,
  cpuCount: 8,
  availableMemoryBytes: 8 * 2 ** 30,
  observedAt: '2026-01-01T00:00:00.000Z',
}

it('validates shared host capacity without accepting a caller filesystem path', () => {
  expect(SourceStorageCapacitySchema.parse(capacity)).toEqual(capacity)
  expect(SourceStorageCapacitySchema.safeParse({ ...capacity, canonicalPath: '/unapproved' }).success).toBe(false)
})

it.each([
  { availableBytes: -1 },
  { availableBytes: capacity.totalBytes + 1 },
  { totalBytes: Number.MAX_SAFE_INTEGER + 1 },
  { cpuCount: 0 },
  { availableMemoryBytes: -1 },
  { observedAt: 'unknown' },
])('rejects invalid host resource measurements %j', override => {
  expect(SourceStorageCapacitySchema.safeParse({ ...capacity, ...override }).success).toBe(false)
})
