import { integrationPartition } from '@foreman-code/contracts'
import { expect, it } from 'vitest'
import { ciGroupState, planCiParts } from './parts.js'

it('queues all full suite parts and defaults unit shard counts independently', () => {
  const unit = planCiParts({ suite: 'unit', scope: 'full', commandId: 'unit' }, {})
  expect(unit.filter(part => part.part === 'unit-api').map(part => part.partition)).toEqual(
    Array.from({ length: 5 }, (_, index) => ({ index, count: 5 })))
  expect(unit.filter(part => part.part === 'unit-web').map(part => part.partition)).toEqual(
    Array.from({ length: 3 }, (_, index) => ({ index, count: 3 })))
  expect(unit.filter(part => part.part === 'unit-web-heavy').map(part => part.partition)).toEqual(
    [{ index: 0, count: 2 }, { index: 1, count: 2 }])
  expect(unit.at(-1)?.part).toBe('unit-other')
  for (const suite of ['lint', 'typecheck', 'build'] as const) {
    expect(planCiParts({ suite, commandId: suite }, {}).map(part => part.part))
      .toEqual([`${suite}-api`, `${suite}-other`])
  }
})

it('queues runner-selected affected parts when files are omitted instead of completing an empty caller selection', () => {
  for (const scope of [undefined, 'affected'] as const) {
    const parts = planCiParts({ suite: 'unit', commandId: 'runner', ...(scope ? { scope } : {}) }, {})
    expect(parts.map(part => part.part)).toEqual(planCiParts({ suite: 'unit', scope: 'full', commandId: 'full' }, {})
      .map(part => part.part))
    expect(parts.some(part => part.partition)).toBe(true)
    expect(planCiParts({ suite: 'integration', commandId: 'integration', partitions: 2, ...(scope ? { scope } : {}) }, {}))
      .toEqual([0, 1].map(index => ({ part: null, files: [], partition: { index, count: 2 } })))
  }
})

it('sizes unit shards from measured durations and caps them to the available files', () => {
  const files = ['a', 'b', 'c'].map(name => `apps/api/test/${name}.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 90_000]))
  const parts = planCiParts({ suite: 'unit', commandId: 'measured' }, durations, { files, durations, heavy: [] })
  expect(parts.filter(part => part.part === 'unit-api')).toHaveLength(3)
  expect(parts.filter(part => part.part === 'unit-web')).toHaveLength(0)
})

it('shards only affected unit files, routes heavy files and leaves no empty work', () => {
  const files = ['apps/api/test/a.test.ts', 'apps/api/test/b.test.ts', 'apps/web/src/a.test.tsx',
    'apps/web/src/routes/a.integration.test.tsx', 'packages/contracts/src/a.test.ts']
  const parts = planCiParts({ suite: 'unit', commandId: 'affected', scope: 'affected', files }, {},
    { files, durations: {}, heavy: ['src/**/*.integration.test.tsx'] })
  expect(parts.map(part => part.part)).toEqual(['unit-api', 'unit-api', 'unit-web', 'unit-web-heavy', 'unit-other'])
  expect(parts.flatMap(part => part.files).sort()).toEqual([...files].sort())
  expect(parts.every(part => part.files.length > 0)).toBe(true)
  expect(parts.slice(0, 2).map(part => part.partition)).toEqual([{ index: 0, count: 2 }, { index: 1, count: 2 }])
  expect(planCiParts({ suite: 'lint', commandId: 'lint', scope: 'affected', files: ['apps/web/src/a.ts'] }, {}))
    .toEqual([{ part: 'lint-other', partition: null, files: ['apps/web/src/a.ts'] }])
})

it('preserves integration partitions and represents empty affected selections without queued parts', () => {
  expect(planCiParts({ suite: 'integration', commandId: 'integration', partitions: 2 }, {}))
    .toEqual([0, 1].map(index => ({ part: null, files: [], partition: { index, count: 2 } })))
  expect(planCiParts({ suite: 'unit', commandId: 'empty', scope: 'affected', files: [] }, {}))
    .toEqual([{ part: null, partition: null, files: [] }])
})

it('reports unfinished and failed group members alongside passed parts', () => {
  expect(ciGroupState([{ state: 'passed' }, { state: 'queued' }])).toBe('queued')
  expect(ciGroupState([{ state: 'passed' }, { state: 'running' }])).toBe('running')
  expect(ciGroupState([{ state: 'failed' }, { state: 'running' }])).toBe('failed')
  expect(ciGroupState([{ state: 'passed' }, { state: 'passed' }])).toBe('passed')
})

it.each(['apps/api/test', 'apps/web/src'])('grows %s shards to target 150 seconds of measured work', directory => {
  const files = Array.from({ length: 60 }, (_, index) => `${directory}/feature-${index}.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 30_000]))
  const parts = planCiParts({ suite: 'unit', scope: 'full', commandId: 'growth' }, durations,
    { files, durations, heavy: [] })
  const part = directory.startsWith('apps/api') ? 'unit-api' : 'unit-web'
  expect(parts.filter(item => item.part === part)).toHaveLength(12)
})

it.each(['apps/api/src', 'apps/web/src'])('adds %s parts when measured slices exceed the unit budget', directory => {
  const files = Array.from({ length: 9 }, (_, index) => `${directory}/feature-${index}.test.ts`)
  const durations = Object.fromEntries(files.map(file => [file, 90_000]))
  const part = directory.startsWith('apps/api') ? 'unit-api' : 'unit-web'
  const parts = planCiParts({ suite: 'unit', scope: 'full' }, durations, { files, durations, heavy: [] })
    .filter(item => item.part === part)
  expect(parts).toHaveLength(9)
  const slices = parts.map(item => integrationPartition(files, durations, item.partition!))
  expect(slices.flat().sort()).toEqual([...files].sort())
  for (const [index, item] of parts.entries()) {
    const measuredMs = slices[index]!.reduce((sum, file) => sum + durations[file]!, 0)
    expect(item).toMatchObject({ expectedDurationMs: 90_000 + measuredMs })
    expect(90_000 + measuredMs).toBeLessThanOrEqual(240_000)
  }
})
