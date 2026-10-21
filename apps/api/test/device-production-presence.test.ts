import { expect, it } from 'vitest'
import { ProductionDevicePresence } from '../src/modules/devices/productionPresence.js'
import type { DevicePresence } from '../src/modules/devices/deviceEndpoint.js'

const view = (epoch: string, generation: number): DevicePresence => ({
  binding: { mainId: 'main', deviceId: 'device', workerInstallationId: 'worker-installation', keyRevision: 1,
    authorizationRevision: 1, bootId: 'worker-boot', connectionEpoch: epoch, connectionGeneration: generation },
  phase: 'ready', dispatch: false, transfer: false, appVersion: '0.1.0', protocolVersion: 1, lastSeenAt: '2026-10-01T10:25:00.000Z',
})
it('retains the current authenticated epoch against stale offline/readiness and exposes independent snapshots', () => {
  const presence = new ProductionDevicePresence('main')
  presence.publish(view('epoch-A', 1)); presence.publish(view('epoch-B', 2))
  presence.publish({ ...view('epoch-A', 1), phase: 'offline' })
  presence.publish(view('epoch-A', 1))
  const current = presence.get('device')!
  expect(current.binding.connectionEpoch).toBe('epoch-B')
  current.phase = 'offline'
  expect(presence.get('device')!.phase).toBe('ready')
  presence.close()
  presence.publish(view('epoch-C', 3))
  expect(presence.get('device')).toMatchObject({ phase: 'offline', dispatch: false, transfer: false })
  expect(() => presence.publish({ ...view('wrong', 3), binding: { ...view('wrong', 3).binding, mainId: 'another-main' } })).toThrow('another main')
})
