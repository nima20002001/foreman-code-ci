import { expect, it } from 'vitest'
import { ComputerMaintenance } from '../../src/modules/computers/maintenance.js'
import { fakeComputer, fakeFleet, settle } from './fleetSync.js'

it('observes a known sudo denial while preserving harness versions and fleet task readback', async () => {
  const computer = fakeComputer()
  const { fleet } = fakeFleet(computer)
  await fleet.syncChangedSources()
  const status = await settle(computer)
  expect(status.system).toMatchObject({ sudo: false, packageUpdates: null })
  expect(status.harnesses).toContainEqual({ harness: 'claude', installed: true, version: '1.2.3', latest: '1.2.4' })
  expect(status.tasks).toContainEqual(expect.objectContaining({ kind: 'sync-mcp', state: 'succeeded' }))
  expect([...computer.codexMcp]).toEqual(['docs'])
  const restored = await new ComputerMaintenance(computer.ports).status(AbortSignal.timeout(1000))
  expect(restored.tasks).toEqual(status.tasks)
})
