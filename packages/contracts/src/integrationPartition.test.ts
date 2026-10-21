import { expect, it } from 'vitest'
import { integrationPartition } from './ciHost.js'

const heavy = [
  'apps/api/test/remote-review-production-main-crash.integration.test.ts',
  'apps/api/test/computer-workflow-save.regression-directories.integration.test.ts',
  'apps/api/test/local-human-native.integration.test.ts',
  'apps/api/test/native-stream-lifecycle.integration.test.ts',
]
const ordinary = ['first', 'second', 'third', 'fourth'].map(name => `apps/api/test/${name}.integration.test.ts`)

it.each([undefined, [8, 1, 1, 1]])('spreads heavy files before ordinary work with weights %j', weights => {
  const files = [...ordinary, ...heavy]
  const durations = Object.fromEntries(files.map((file, index) => [file, 1000 - index * 100]))
  const slices = Array.from({ length: 4 }, (_, index) => integrationPartition(files, durations,
    { index, count: 4, ...(weights ? { weights } : {}) }))

  expect(slices.flat().sort()).toEqual([...files].sort())
  expect(slices.map(slice => slice.filter(file => heavy.includes(file)).length)).toEqual([1, 1, 1, 1])
  expect(slices[0]).toContain(heavy[0])
  // Once the longest heavy file occupies the fastest host, the next must use an empty partition.
  expect(slices[1]).toContain(heavy[1])
})

it('keeps heavy counts balanced when there are more heavy files than partitions', () => {
  const extra = 'apps/api/test/remote-review-production-worker-crash.integration.test.ts'
  const files = [...heavy, extra]
  const durations = Object.fromEntries(files.map((file, index) => [file, 500 - index * 100]))
  const slices = Array.from({ length: 2 }, (_, index) => integrationPartition(files, durations,
    { index, count: 2, weights: [20, 1] }))

  expect(slices.flat().sort()).toEqual([...files].sort())
  expect(slices.map(slice => slice.length).sort()).toEqual([2, 3])
  expect(slices[0]).toContain(heavy[0])
  expect(slices[1]).toContain(heavy[1])
})

it('keeps ordinary duration balancing and deterministic median fallbacks', () => {
  const durations = Object.fromEntries(ordinary.map((file, index) => [file, 400 - index * 100]))
  expect(integrationPartition(ordinary, durations, { index: 0, count: 2 })).toEqual([ordinary[0], ordinary[3]])
  expect(integrationPartition(ordinary, durations, { index: 1, count: 2 })).toEqual([ordinary[1], ordinary[2]])
  const files = [...heavy].reverse()
  const slices = Array.from({ length: 4 }, (_, index) => integrationPartition(files,
    { [heavy[0]!]: 168_000, [heavy[1]!]: Number.NaN, [heavy[2]!]: -1 }, { index, count: 4 }))
  expect(slices.every(slice => slice.length === 1)).toBe(true)
  expect(slices).toEqual(Array.from({ length: 4 }, (_, index) => integrationPartition([...files].reverse(),
    { [heavy[0]!]: 168_000, [heavy[1]!]: Number.NaN, [heavy[2]!]: -1 }, { index, count: 4 })))
  expect(integrationPartition(files, {}, { index: 0, count: 1 })).toEqual(files)
})
