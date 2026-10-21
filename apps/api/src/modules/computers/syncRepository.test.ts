import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { SyncRepository } from './syncRepository.js'

it('keeps the original computer participating while a historical chat continues', async () => {
  const mainId = randomUUID()
  const registration = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 2,
    authorizationRevision: 3, status: 'paired', publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'] }
  let continuing = true
  const host = { kind: 'device', mainId, deviceId: registration.deviceId }
  const query = async (text: string) => {
    if (text.includes('from workspaces')) return { rows: [{ id: 'workspace', name: 'Project', active: true }] }
    if (text.includes('from device_registrations')) return { rows: [{ record: registration }] }
    if (text.includes('from operator_conversations')) {
      return { rows: continuing ? [{ workspace_id: 'workspace', host,
        installation_id: registration.workerInstallationId,
        key_revision: String(registration.keyRevision), authorization_revision: String(registration.authorizationRevision) }] : [] }
    }
    // The Agent's current configuration and unfinished Runs no longer select this computer.
    return { rows: [] }
  }
  const repository = new SyncRepository({ query } as unknown as pg.Pool, mainId)
  expect((await repository.workspaces())[0]!.targets).toContainEqual({ hostRef: host,
    applicationInstallationId: registration.workerInstallationId, keyRevision: 2, authorizationRevision: 3 })
  continuing = false
  expect((await repository.workspaces())[0]!.targets).toEqual([repository.mainTarget])
  continuing = true
  registration.workerInstallationId = randomUUID()
  // A historical row still bound to the former installation must not select its replacement.
  const originalQuery = query
  const stale = new SyncRepository({ query: async (text: string) => {
    const result = await originalQuery(text)
    if (text.includes('from operator_conversations')) {
      return { rows: [{ ...result.rows[0], installation_id: 'retired-installation' }] }
    }
    return result
  } } as unknown as pg.Pool, mainId)
  expect((await stale.workspaces())[0]!.targets).toEqual([stale.mainTarget])
})
