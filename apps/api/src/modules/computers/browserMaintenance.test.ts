import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { MaintenanceTaskStart } from '@foreman-code/contracts/computer-maintenance'
import { fakeComputer } from '../../../test/helpers/fleetSync.js'
import { ComputerMaintenance } from './maintenance.js'

it.each([true, false])('repairs the browser explicitly and preserves verified readiness (%s)', async ready => {
  const computer = fakeComputer()
  let repairs = 0
  const status = { computerId: 'computer', ready: false, phase: 'unavailable', reason: 'runtime_missing' as string | null }
  const ports = { ...computer.ports, browserRuntime: { status: () => status,
    retry: async () => { repairs++; Object.assign(status, { ready, phase: ready ? 'ready' : 'failed', reason: ready ? null : 'runtime_missing' }); return status } } }
  const maintenance = new ComputerMaintenance(ports)
  try {
    expect(await maintenance.status(AbortSignal.timeout(2000))).toMatchObject({ browserRuntime: status })
    expect(repairs).toBe(0)
    const commandId = randomUUID()
    const request = { kind: 'repair-browser' } as MaintenanceTaskStart
    await maintenance.start(request, commandId)
    await maintenance.drain()
    const result = await maintenance.status(AbortSignal.timeout(2000))
    expect(result).toMatchObject({ browserRuntime: status, tasks: [{ state: ready ? 'succeeded' : 'failed' }] })
    await maintenance.start(request, commandId)
    expect(repairs).toBe(1)
  } finally { maintenance.stopAdmission(); await maintenance.drain() }
})
