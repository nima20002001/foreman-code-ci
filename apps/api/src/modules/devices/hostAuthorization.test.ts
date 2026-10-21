import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { assertDeviceHostInstallation } from './hostAuthorization.js'

const mainId = randomUUID()
const registration: DeviceRegistration = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(),
  keyRevision: 2, authorizationRevision: 4, status: 'paired', scopes: ['connect'], publicKeyFingerprint: 'a'.repeat(64) }
function sql(record: DeviceRegistration | undefined = registration, actualMainId = mainId) {
  const query = vi.fn(async (text: string) => text.includes('application_installation')
    ? { rows: [{ id: actualMainId }] } : { rows: record ? [{ record }] : [] })
  return { query } as unknown as Pick<pg.ClientBase, 'query'>
}
const host = { kind: 'device' as const, mainId, deviceId: registration.deviceId }
describe('domain-neutral actual host installation authority', () => {
  it('returns null only for the selected original main and exact installation', async () => {
    const client = sql()
    expect(await assertDeviceHostInstallation(client, { kind: 'main', mainId }, mainId)).toBeNull()
    expect(client.query).toHaveBeenCalledTimes(1)
    await expect(assertDeviceHostInstallation(client, { kind: 'main', mainId }, randomUUID())).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(assertDeviceHostInstallation(sql(undefined, randomUUID()), { kind: 'main', mainId }, mainId)).rejects.toMatchObject({ code: 'wrong_main' })
  })
  it('returns paired registration and current revision pins without querying management grants', async () => {
    const client = sql()
    expect(await assertDeviceHostInstallation(client, host, registration.workerInstallationId)).toEqual(registration)
    expect(client.query).toHaveBeenCalledTimes(2)
    expect(client.query).toHaveBeenLastCalledWith(expect.stringContaining('for share'), [registration.deviceId, mainId])
  })
  it('rejects revoked/pending and mismatched actual installation or registration identity', async () => {
    await expect(assertDeviceHostInstallation(sql({ ...registration, status: 'revoked' }), host, registration.workerInstallationId)).rejects.toMatchObject({ code: 'revoked' })
    await expect(assertDeviceHostInstallation(sql({ ...registration, status: 'pending' }), host, registration.workerInstallationId)).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(assertDeviceHostInstallation(sql(), host, randomUUID())).rejects.toMatchObject({ code: 'unauthorized' })
    await expect(assertDeviceHostInstallation(sql({ ...registration, deviceId: randomUUID() }), host, registration.workerInstallationId)).rejects.toMatchObject({ code: 'unauthorized' })
  })
})
