import { expect, it } from 'vitest'
import { pairedWorkerApplication } from './helpers/pairedWorkerApplication.js'
import { selectedNativeHarnesses } from './helpers/selectedNativeHarnesses.js'

it.each(selectedNativeHarnesses())('%s connects the committed installed Worker to Main through normal pairing', async harness => {
  const fixture = await pairedWorkerApplication({ harnesses: [harness] })
  try {
    expect(fixture.inventory.hostMetadata?.hostRef).toEqual(fixture.hostRef)
    expect(fixture.inventory.hostMetadata?.connection?.binding.workerInstallationId)
      .toBe(fixture.roots.applicationInstallationId)
    expect(fixture.inventory.installations.filter(value => value.installed).map(value => value.driverId))
      .toContain(harness)
    const devices = await fixture.tool('devices_list', {}) as { devices: Array<{ deviceId: string; status: string }> }
    expect(devices.devices.find(value => value.deviceId === fixture.hostRef.deviceId)?.status).toBe('paired')
  } finally { await fixture.close() }
}, 300000)
