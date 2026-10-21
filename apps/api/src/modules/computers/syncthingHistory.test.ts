import { afterEach, expect, it } from 'vitest'
import { SyncComputerStateSchema } from '@foreman-code/contracts/computer-accounts'
import { fakeSyncthing, workerSyncId } from '../../../test/helpers/syncthing.js'
import { SyncthingComputer, sharedFolderId } from './syncthingComputer.js'

let close: (() => Promise<void>) | undefined
afterEach(async () => { await close?.() })

it('pauses sharing without removing the folder database and resumes the same folder', async () => {
  const f = await fakeSyncthing()
  close = f.close
  const computer = new SyncthingComputer(f.ports)
  const enabled = { operation: 'configure', workspaceId: 'workspace', enabled: true,
    peers: [{ deviceId: workerSyncId, address: '100.64.0.20' }] }
  await computer.handle(enabled)
  const folders = await f.rest('GET', '/rest/config/folders') as Record<string, unknown>[]
  await f.rest('POST', '/rest/config/folders', { ...folders[0], rescanIntervalS: 7200 })
  await computer.handle({ ...enabled, enabled: false, peers: [] })
  expect(await f.rest('GET', '/rest/config/folders')).toEqual([expect.objectContaining({
    id: sharedFolderId('workspace'), paused: true, rescanIntervalS: 7200,
    devices: [{ deviceID: f.identity.deviceId }],
  })])
  expect(SyncComputerStateSchema.parse(await computer.handle({ operation: 'status' })).folders).toEqual([])
  await computer.handle(enabled)
  expect(await f.rest('GET', '/rest/config/folders')).toEqual([expect.objectContaining({
    id: sharedFolderId('workspace'), paused: false, rescanIntervalS: 7200,
    devices: [{ deviceID: f.identity.deviceId }, { deviceID: workerSyncId }],
  })])
})
