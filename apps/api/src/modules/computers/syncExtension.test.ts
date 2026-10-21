import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { createComputerSyncExtension } from './syncExtension.js'
import { SyncthingComputer } from './syncthingComputer.js'
import { fakeSyncthing, mainSyncId } from '../../../test/helpers/syncthing.js'

function binding(): DeviceSessionBinding {
  return { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), bootId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, connectionGeneration: 1, connectionEpoch: randomUUID() }
}
function target(value: DeviceSessionBinding) {
  return { hostRef: { kind: 'device' as const, mainId: value.mainId, deviceId: value.deviceId },
    applicationInstallationId: value.workerInstallationId, keyRevision: value.keyRevision,
    authorizationRevision: value.authorizationRevision }
}

it('refuses a request for an old installation on the replacement Worker channel before setup', async () => {
  const f = await fakeSyncthing()
  try {
    const connection = binding()
    const extension = createComputerSyncExtension(new SyncthingComputer(f.ports), () => connection)
    await expect(extension.handle!({ target: { ...target(connection), applicationInstallationId: randomUUID() },
      request: { operation: 'identity' } }, { binding: connection, signal: new AbortController().signal }))
      .rejects.toMatchObject({ code: 'COMPUTER_SYNC_STALE' })
    expect(await f.ports.available()).toEqual({ installed: false, running: false })
  } finally { await f.close() }
})

it('rechecks the authenticated channel after installation before trusting peers or sharing files', async () => {
  const f = await fakeSyncthing()
  let release!: () => void
  let entered!: () => void
  const waiting = new Promise<void>(resolve => { release = resolve })
  const started = new Promise<void>(resolve => { entered = resolve })
  let connection = binding()
  const original = connection
  const computer = new SyncthingComputer({ ...f.ports, prepare: async () => {
    entered()
    await waiting
    return f.ports.prepare()
  } })
  const extension = createComputerSyncExtension(computer, () => connection)
  const pending = extension.handle!({ target: target(original), request: { operation: 'configure',
    workspaceId: 'workspace', enabled: true, peers: [{ deviceId: mainSyncId, address: '100.64.0.1' }] } },
  { binding: original, signal: new AbortController().signal })
  try {
    await started
    connection = { ...original, connectionEpoch: randomUUID() }
    release()
    await expect(pending).rejects.toMatchObject({ code: 'COMPUTER_SYNC_STALE' })
    expect(await f.rest('GET', '/rest/config/folders')).toEqual([])
    expect(await f.rest('GET', '/rest/config/devices')).toEqual([])
  } finally { release(); await f.close() }
})
