import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { CI_MAX_RUN_TICKETS, CiPartitionSchema, CiRunOutputSchema, integrationPartition,
  userSystemdIntegrationFiles } from '@foreman-code/contracts'
import { planIntegrationParts } from './integrationParts.js'

const files = Array.from({ length: 20 }, (_, index) => `apps/api/test/example-${index}.integration.test.ts`)
const durations = Object.fromEntries(files.map(file => [file, 120_000]))
const input = { suite: 'integration' as const, commandId: 'integration', scope: 'full' as const }

it.each([8, 112])('fills %i slots with balanced full-suite parts accepted by the shared contracts', slots => {
  const selected = Array.from({ length: 800 }, (_, index) => `apps/api/test/example-${index}.integration.test.ts`)
  const measured = Object.fromEntries(selected.map((file, index) => [file, 10_000 + (index % 5) * 10_000]))
  const parts = planIntegrationParts(input, { files: selected, durations: measured }, { host: 0, ordinary: slots })

  expect(parts).toHaveLength(slots)
  const slices = parts.map(part => integrationPartition(selected, measured, part.partition!))
  expect(slices.flat().sort()).toEqual([...selected].sort())
  expect(slices.every(slice => slice.length > 0)).toBe(true)
  const loads = slices.map(slice => slice.reduce((sum, file) => sum + measured[file]!, 0))
  const average = Object.values(measured).reduce((sum, ms) => sum + ms, 0) / slots
  expect(Math.max(...loads)).toBeLessThanOrEqual(average + 50_000)
  expect(parts.map(part => part.expectedDurationMs)).toEqual(loads.map(ms => 90_000 + ms))
  expect(parts.every(part => CiPartitionSchema.safeParse(part.partition).success)).toBe(true)
  const tickets = parts.map(() => ({ ticketId: randomUUID() }))
  expect(CiRunOutputSchema.safeParse({ ticketId: tickets[0]!.ticketId, partitions: tickets }).success).toBe(true)
})

it('shares full-suite slots between measured tiers and leaves a single heavy file whole', () => {
  const quick = Array.from({ length: 800 }, (_, index) => `apps/api/test/quick-${index}.integration.test.ts`)
  const slow = Array.from({ length: 8 }, (_, index) => `apps/api/test/slow-${index}.integration.test.ts`)
  const heavy = 'apps/api/test/heavy.integration.test.ts'
  const selected = [...quick, ...slow, heavy]
  const measured: Record<string, number> = { ...Object.fromEntries(quick.map(file => [file, 20_000])),
    ...Object.fromEntries(slow.map(file => [file, 90_000])), [heavy]: 250_000 }
  const parts = planIntegrationParts(input, { files: selected, durations: measured }, { host: 0, ordinary: 112 })

  expect(parts).toHaveLength(112)
  const slices = parts.map(part => integrationPartition(selected, measured, part.partition!))
  expect(slices.flat().sort()).toEqual([...selected].sort())
  expect(slices.find(slice => slice.includes(heavy))).toEqual([heavy])
  const average = Object.values(measured).reduce((sum, ms) => sum + ms, 0) / parts.length
  const ordinaryLoads = slices.filter(slice => !slice.includes(heavy))
    .map(slice => slice.reduce((sum, file) => sum + measured[file]!, 0))
  expect(Math.max(...ordinaryLoads)).toBeLessThanOrEqual(average * 1.25)
  expect(planIntegrationParts(input, { files: [...selected].reverse(), durations: measured }, { host: 0, ordinary: 112 }))
    .toEqual(parts)
})

it('uses one full-suite part per file when capacity allows and reports setup plus measured duration', () => {
  const parts = planIntegrationParts(input, { files, durations }, { host: 2, ordinary: 44 })
  expect(parts).toHaveLength(20)
  const slices = parts.map(part => integrationPartition(files, durations, part.partition!))
  expect(slices.flat().sort()).toEqual([...files].sort())
  expect(slices.every(slice => slice.length === 1)).toBe(true)
  expect(parts.every(part => part.expectedDurationMs === 210_000)).toBe(true)
  expect(parts.every(part => part.files.length === 0)).toBe(true)
})

it('keeps long files alone while smaller files use the remaining full-suite capacity', () => {
  const selected = files.slice(0, 5)
  const measured = Object.fromEntries(selected.map((file, index) => [file, [600_000, 180_000, 120_000, 60_000, 60_000][index]!]))
  const parts = planIntegrationParts(input, { files: selected, durations: measured }, { host: 0, ordinary: 44 })
  const slices = parts.map(part => integrationPartition(selected, measured, part.partition!))
  expect(parts).toHaveLength(5)
  expect(slices[0]).toEqual([selected[0]])
  expect(slices.slice(1)).toEqual(selected.slice(1).map(file => [file]))
  expect(parts.map(part => part.expectedDurationMs)).toEqual([690_000, 270_000, 210_000, 150_000, 150_000])
})

it.each([1, 3, 44])('bounds parts to %i available slots without losing work', ordinary => {
  const parts = planIntegrationParts(input, { files, durations }, { host: 0, ordinary })
  expect(parts).toHaveLength(Math.min(files.length, ordinary))
  const slices = parts.map(part => part.partition ? integrationPartition(files, durations, part.partition) : files)
  expect(slices.flat().sort()).toEqual([...files].sort())
})

it('bounds caller-requested partitions to free slots and selected files', () => {
  expect(planIntegrationParts({ ...input, partitions: 64 }, { files, durations }, { host: 0, ordinary: 3 })).toHaveLength(3)
  expect(planIntegrationParts({ ...input, partitions: 2 }, { files, durations }, { host: 0, ordinary: 44 })).toHaveLength(2)
  const affected = { ...input, scope: 'affected' as const, files: [files[0]!, files[0]!, files[1]!] }
  expect(planIntegrationParts(affected, { files, durations }, { host: 0, ordinary: 44 }))
    .toEqual([{ part: null, partition: null, files: [files[0], files[1]].sort(), expectedDurationMs: 330_000, requiresBuildComputer: false }])
  expect(planIntegrationParts({ ...affected, files: [] }, { files, durations }, { host: 0, ordinary: 44 }))
    .toEqual([{ part: null, partition: null, files: [], expectedDurationMs: 0, requiresBuildComputer: false }])
})

it('preserves separate host-only slices when hosts are busy and leaves ordinary work on cloud', () => {
  const hostFiles = [...userSystemdIntegrationFiles]
  // Every file is measured as slow here, so the request has one tier and keeps its host-only slices.
  const inventory = { files: [...files, ...hostFiles], durations: { ...durations,
    ...Object.fromEntries(hostFiles.map(file => [file, 120_000])) } }
  const parts = planIntegrationParts(input, inventory, { host: 0, ordinary: 44 })
  expect(parts).toHaveLength(21)
  expect(parts[0]!.partition!.hostIndexes).toEqual([0])
  const slices = parts.map(part => integrationPartition(inventory.files, durations, part.partition!))
  expect(slices[0]!.sort()).toEqual(hostFiles.sort())
  expect(slices.slice(1).flat().sort()).toEqual([...files].sort())
})

it('uses the measured median for unknown files and sizes runner-derived selections conservatively', () => {
  const parts = planIntegrationParts({ suite: 'integration', commandId: 'derived' },
    { files, durations: { [files[0]!]: 120_000 } }, { host: 0, ordinary: 44 })
  // The one measured slow file forms a separate tier; unmeasured files are estimated at the median.
  const fast = parts.filter(part => part.partition?.tier !== 'slow')
  expect(fast).toHaveLength(10)
  expect(fast.every(part => part.expectedDurationMs <= 330_000)).toBe(true)
  expect(parts.filter(part => part.partition?.tier === 'slow')).toHaveLength(1)
})

it('plans separate slow parts that no fast part contains', () => {
  const quick = files.slice(0, 8)
  const slow = files.slice(8, 11)
  const measured = { ...Object.fromEntries(quick.map(file => [file, 20_000])),
    ...Object.fromEntries(slow.map(file => [file, 90_000])) }
  const parts = planIntegrationParts(input, { files: [...quick, ...slow], durations: measured }, { host: 0, ordinary: 44 })
  const slices = parts.map(part => integrationPartition([...quick, ...slow], measured, part.partition!))
  const fastSlices = slices.filter((_, index) => parts[index]!.partition?.tier === 'fast')
  const slowSlices = slices.filter((_, index) => parts[index]!.partition?.tier === 'slow')
  expect(fastSlices.flat().sort()).toEqual([...quick].sort())
  expect(slowSlices.flat().sort()).toEqual([...slow].sort())
  // Each slow file gets its own part, so the slow tier lasts as long as its slowest file.
  expect(slowSlices.every(slice => slice.length === 1)).toBe(true)
})

it.each([2, 3])('balances measured tier durations across %i parts including the systemd slice', partitions => {
  const hostFiles = [...userSystemdIntegrationFiles]
  const ordinary = Array.from({ length: 707 }, (_, index) => `apps/api/test/ordinary-${index}.integration.test.ts`)
  const slow = Array.from({ length: 12 }, (_, index) => `apps/api/test/slow-${index}.integration.test.ts`)
  const fastFiles = [...hostFiles.slice(0, 3), ...ordinary]
  const slowFiles = [...hostFiles.slice(3), ...slow]
  const selected = [...fastFiles, ...slowFiles]
  const measured = Object.fromEntries([
    ...hostFiles.slice(0, 3).map(file => [file, 1_000]),
    ...ordinary.map((file, index) => [file, 10_000 + (index % 5) * 10_000]),
    ...slowFiles.map((file, index) => [file, 60_000 + (index % 3) * 10_000]),
  ])
  const parts = planIntegrationParts({ ...input, partitions }, { files: selected, durations: measured },
    { host: 1, ordinary: 44 })

  for (const [tier, tierFiles] of [['fast', fastFiles], ['slow', slowFiles]] as const) {
    const tierParts = parts.filter(part => part.partition?.tier === tier)
    expect(tierParts).toHaveLength(partitions)
    const slices = tierParts.map(part => integrationPartition(selected, measured, part.partition!))
    expect(slices.flat().sort()).toEqual([...tierFiles].sort())
    const loads = slices.map(slice => slice.reduce((sum, file) => sum + measured[file]!, 0))
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(
      Math.max(...tierFiles.map(file => measured[file]!)))
    for (const [index, part] of tierParts.entries()) {
      expect(part.partition!.weights).toEqual(Array(partitions).fill(1))
      expect(part.expectedDurationMs).toBe(90_000 + loads[index]!)
      expect(part.requiresBuildComputer).toBe(index === 0)
      expect(slices[index]!.filter(file => hostFiles.includes(file)))
        .toEqual(index === 0 ? tierFiles.filter(file => hostFiles.includes(file)) : [])
    }
  }
})

it('keeps a request with only fast or only slow files in one tier', () => {
  const quick = Object.fromEntries(files.map(file => [file, 20_000]))
  expect(planIntegrationParts(input, { files, durations: quick }, { host: 0, ordinary: 44 })
    .some(part => part.partition?.tier)).toBe(false)
  expect(planIntegrationParts(input, { files, durations }, { host: 0, ordinary: 44 })
    .some(part => part.partition?.tier)).toBe(false)
})


it('allows a single ordinary full slice to run on cloud without changing host-only placement', () => {
  const single = planIntegrationParts(input, { files: [files[0]!], durations }, { host: 0, ordinary: 44 })
  expect(single[0]).toMatchObject({ partition: null, requiresBuildComputer: false, expectedDurationMs: 210_000 })
  const hostFile = [...userSystemdIntegrationFiles][0]!
  const host = planIntegrationParts(input, { files: [hostFile], durations: { [hostFile]: 120_000 } },
    { host: 1, ordinary: 44 })
  expect(host[0]).toMatchObject({ partition: null, requiresBuildComputer: true })
})

it.each([[44, 24], [64, 64]])('keeps %i fast and %i slow requested parts within the response ticket limit',
  (fastCount, slowCount) => {
    const quick = Array.from({ length: fastCount * 8 }, (_, index) => `apps/api/test/quick-${index}.integration.test.ts`)
    const slow = Array.from({ length: slowCount }, (_, index) => `apps/api/test/slow-${index}.integration.test.ts`)
    const selected = [...quick, ...slow]
    const measured = Object.fromEntries([
      ...quick.map(file => [file, 30_000]),
      ...slow.map(file => [file, 90_000]),
    ])
    const parts = planIntegrationParts(input, { files: selected, durations: measured }, { host: 0, ordinary: fastCount })
    const tickets = parts.map(() => ({ ticketId: randomUUID() }))
    expect(CiRunOutputSchema.safeParse({ ticketId: tickets[0]!.ticketId, partitions: tickets }).success).toBe(true)
    expect(parts.length).toBeLessThanOrEqual(CI_MAX_RUN_TICKETS)
    for (const tier of ['fast', 'slow']) {
      const tierParts = parts.filter(part => part.partition?.tier === tier)
      expect(tierParts.length).toBeGreaterThan(0)
      expect(tierParts.length).toBeLessThanOrEqual(64)
    }
    const slices = parts.map(part => integrationPartition(selected, measured, part.partition!))
    expect(slices.flat().sort()).toEqual([...selected].sort())
  })

it('reserves host-only parts before sharing local capacity with ordinary files', () => {
  const hostFiles = [...userSystemdIntegrationFiles].slice(0, 2)
  const selected = [...hostFiles, ...files]
  const measured = { ...durations, ...Object.fromEntries(hostFiles.map(file => [file, 120_000])) }
  const parts = planIntegrationParts(input, { files: selected, durations: measured }, { host: 3, ordinary: 4 })
  expect(parts).toHaveLength(4)
  expect(parts[0]!.partition!.hostIndexes).toEqual([0, 1])
  const slices = parts.map(part => integrationPartition(selected, measured, part.partition!))
  expect(slices.flat().sort()).toEqual([...selected].sort())
  for (const [index, slice] of slices.entries()) {
    expect(slice.some(file => hostFiles.includes(file))).toBe(index < 2)
  }
})

it('splits a small selection across idle executors when parallel work outweighs the setup cost', () => {
  const selected = files.slice(0, 4)
  const measured = Object.fromEntries(selected.map(file => [file, 50_000]))
  const affected = { ...input, scope: 'affected' as const, files: selected }
  const busy = planIntegrationParts(affected, { files: selected, durations: measured }, { host: 0, ordinary: 8 }, 0)
  expect(busy).toHaveLength(1)
  const idle = planIntegrationParts(affected, { files: selected, durations: measured }, { host: 0, ordinary: 8 }, 4)
  expect(idle).toHaveLength(2)
  const slices = idle.map(part => integrationPartition(selected, measured, part.partition!))
  expect(slices.flat().sort()).toEqual([...selected].sort())
  expect(idle.every(part => part.expectedDurationMs! < busy[0]!.expectedDurationMs!)).toBe(true)
  const single = planIntegrationParts(affected, { files: selected, durations: measured }, { host: 0, ordinary: 8 }, 1)
  expect(single).toHaveLength(1)
})
