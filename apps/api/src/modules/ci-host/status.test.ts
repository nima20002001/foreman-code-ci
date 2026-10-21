import { describe, expect, it, vi } from 'vitest'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { DeviceApplicationAdmissionError } from '../devices/deviceApplicationError.js'
import { readHostCiStatus } from './status.js'

function fixture(deviceId = 'device') {
  const target: DeviceProvisioningTarget = {
    hostRef: { kind: 'device', mainId: 'main', deviceId },
    applicationInstallationId: 'worker', keyRevision: 1, authorizationRevision: 2,
  }
  let binding = { workerInstallationId: 'worker', keyRevision: 1, authorizationRevision: 2, connectionId: 'first' }
  const status = { operation: 'status' as const, ready: true, reasons: [],
    cpuCount: 8, memoryBytes: 16 * 2 ** 30, runs: [] }
  const request = vi.fn(async () => ({ payload: status }))
  const channel = { binding, request }
  const endpoint = { captureRequest: () => channel, currentBinding: () => binding } as unknown as DeviceEndpoint
  return { target, endpoint, channel, request, status,
    replace: () => { binding = { ...binding, connectionId: 'replacement' } } }
}

describe('Host CI status', () => {
  it('reads readiness through the captured authenticated connection', async () => {
    const f = fixture()
    expect(await readHostCiStatus(f.endpoint, f.target)).toEqual(f.status)
    expect(f.request).toHaveBeenCalledWith({ operation: 'status' }, { timeoutMs: 30_000 })
  })

  it.each(['applicationInstallationId', 'keyRevision', 'authorizationRevision'] as const)(
    'rejects a different %s before sending a request', async field => {
      const f = fixture()
      const target = { ...f.target, [field]: field === 'applicationInstallationId' ? 'another-worker' : 3 }
      await expect(readHostCiStatus(f.endpoint, target)).rejects.toMatchObject({ code: 'CI_ENROLLMENT_OFFLINE' })
      expect(f.request).not.toHaveBeenCalled()
    },
  )

  it('rejects a reply after the authenticated connection is replaced', async () => {
    const f = fixture()
    f.request.mockImplementation(async () => {
      f.replace()
      return { payload: f.status }
    })
    await expect(readHostCiStatus(f.endpoint, f.target)).rejects.toMatchObject({ code: 'CI_ENROLLMENT_OFFLINE' })
  })

  it('reports the last known readiness when a status read yields to foreground work', async () => {
    const f = fixture('busy-device')
    expect(await readHostCiStatus(f.endpoint, f.target)).toEqual(f.status)
    f.request.mockRejectedValueOnce(new DeviceApplicationAdmissionError('background_yield'))
    expect(await readHostCiStatus(f.endpoint, f.target)).toEqual(f.status)
  })

  it('reports an unavailable connection without launching work', async () => {
    const f = fixture()
    f.endpoint.captureRequest = () => undefined
    expect(await readHostCiStatus(f.endpoint, f.target)).toBeNull()
    expect(f.request).not.toHaveBeenCalled()
  })
})
