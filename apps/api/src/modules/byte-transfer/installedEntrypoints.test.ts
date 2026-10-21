import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { loadWorkerRsyncEntrypoint, readMainRsyncEntrypoint } from './installedEntrypoints.js'
import { InstalledRsyncSelectionSchema } from './installedRsyncSelection.js'
import { transferContextForBinding } from './carrier.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(join(persistentFixtureRoot, 'rsync-entrypoint-')); roots.push(root)
  const mainId = randomUUID(), deviceId = randomUUID(), workerInstallationId = randomUUID()
  const binding: DeviceSessionBinding = { mainId, deviceId, workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const pairing = { ...binding } as unknown as WorkerPairingConfiguration
  const registration = { mainId, deviceId, workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    publicKeyFingerprint: 'a'.repeat(64), status: 'paired', scopes: ['connect', 'heartbeat'] }
  const binary = join(root, '.local/share/graphql-tools/rsync/3.5.1/bin/rsync'), node = join(root, 'node'), entryPoint = join(root, 'rsync-writer.mjs')
  await mkdir(dirname(binary), { recursive: true, mode: 0o700 })
  for (const path of [binary, node, entryPoint]) await writeFile(path, 'protected fixture', { mode: 0o500 })
  const hash = createHash('sha256').update('protected fixture').digest('hex')
  const selected = InstalledRsyncSelectionSchema.parse({ formatVersion: 1, backend: 'rsync', registration, consentRevision: 1,
    endpoint: { user: 'worker', host: '100.64.1.1', localRoot: join(root, 'main-stage'), remoteRoot: join(root, 'worker-stage') },
    localBinary: { path: binary, sha256: hash, version: '3.5.1' }, remoteBinary: { path: binary, sha256: hash, version: '3.5.1' },
    nodeBinary: { path: node, sha256: hash }, entryPoint: { path: entryPoint, sha256: hash },
    sourceProvenance: { sourceSha256: hash, releaseSignerFingerprint: 'A'.repeat(40) } })
  const path = join(root, 'rsync-selection.json'); await writeFile(path, JSON.stringify(selected), { mode: 0o600 })
  const intent = { version: 1 as const, ...transferContextForBinding(binding), transferId: randomUUID(), operationId: randomUUID(),
    executionId: randomUUID(), attemptId: randomUUID(), placementHash: hash, rootId: randomUUID(), rootBindingRevision: 1,
    direction: 'to-worker' as const, byteClass: 'source' as const, sha256: hash, byteSize: 0, manifestDigest: hash,
    expiresAt: new Date(Date.now() + 120_000).toISOString(), chunkBytes: 8192 }
  return { root, binding, pairing, entryPoint, selected, path, intent }
}
it('reports an unprovisioned Main/worker selection as unavailable with its reason', async () => {
  const f = await fixture(), absent = join(f.root, 'absent.json')
  expect(await readMainRsyncEntrypoint(absent)).toMatchObject({ kind: 'unavailable', reason: expect.stringContaining('No protected') })
  expect(await loadWorkerRsyncEntrypoint({ path: absent, pairing: f.pairing, entryPoint: f.entryPoint,
    current: () => f.binding, ownership: () => undefined, request: vi.fn() })).toMatchObject({ kind: 'unavailable', reason: expect.any(String) })
})
it('loads the protected packaged writer and resolves only the original Main-issued intent', async () => {
  const f = await fixture(), request = vi.fn(async () => ({ payload: f.intent }))
  const loaded = await loadWorkerRsyncEntrypoint({ ...f, current: () => f.binding, ownership: () => undefined, request })
  expect(loaded.kind).toBe('configured')
  if (loaded.kind !== 'configured') throw new Error('not mounted')
  try {
    expect(await loaded.providers.accepted.intent(f.intent.transferId, f.binding)).toEqual(f.intent)
    expect(request).toHaveBeenCalledWith({ kind: 'rsync-stage-v1', method: 'transfer-authorize', transferId: f.intent.transferId }, expect.any(AbortSignal))
    await loaded.providers.accepted.authorize(f.intent, transferContextForBinding(f.binding), 'read')
    request.mockResolvedValue({ payload: { ...f.intent, transferId: randomUUID() } })
    await expect(loaded.providers.accepted.authorize(f.intent, transferContextForBinding(f.binding), 'read')).rejects.toThrow('another original transfer')
    await expect(loaded.providers.quiescent(f.intent, AbortSignal.timeout(1000))).rejects.toThrow('physical writer registry')
  } finally { await loaded.close() }
})
it('refuses a different packaged writer path and changed protected bytes', async () => {
  const f = await fixture(), input = { ...f, current: () => f.binding, ownership: () => undefined, request: vi.fn() }
  await expect(loadWorkerRsyncEntrypoint({ ...input, entryPoint: join(f.root, 'other.mjs') })).rejects.toThrow('packaged rsync-writer')
  await chmod(f.entryPoint, 0o700)
  await writeFile(f.entryPoint, 'changed fixture')
  await chmod(f.entryPoint, 0o500)
  await expect(loadWorkerRsyncEntrypoint(input)).rejects.toThrow('changed before verification')
})

it('reauthorizes an original admission after reconnect without replacing its epoch or expiry', async () => {
  const f = await fixture()
  const binding = { ...f.binding, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 2 }
  const request = vi.fn(async () => ({ payload: f.intent }))
  const loaded = await loadWorkerRsyncEntrypoint({ ...f, current: () => binding, ownership: () => undefined, request })
  if (loaded.kind !== 'configured') throw new Error('not mounted')
  try {
    expect(await loaded.providers.accepted.intent(f.intent.transferId, binding)).toEqual(f.intent)
    await loaded.providers.accepted.authorize(f.intent, transferContextForBinding(binding), 'read')
    request.mockRejectedValueOnce(new Error('Original transfer expired'))
    await expect(loaded.providers.accepted.authorize(f.intent, transferContextForBinding(binding), 'read'))
      .rejects.toThrow('Original transfer expired')
  } finally {
    await loaded.close()
  }
})

it.each(['mainId', 'deviceId', 'workerInstallationId', 'keyRevision', 'authorizationRevision'] as const)(
  'rejects a reconnect that changes the admitted %s', async key => {
    const f = await fixture()
    const changed = typeof f.intent[key] === 'number' ? 2 : randomUUID()
    const request = vi.fn(async () => ({ payload: { ...f.intent, [key]: changed } }))
    const loaded = await loadWorkerRsyncEntrypoint({ ...f, current: () => f.binding, ownership: () => undefined, request })
    if (loaded.kind !== 'configured') throw new Error('not mounted')
    try {
      await expect(loaded.providers.accepted.intent(f.intent.transferId, f.binding)).rejects.toThrow('another original transfer')
    } finally {
      await loaded.close()
    }
  },
)

it('rejects a connection change while Main authorizes the transfer', async () => {
  const f = await fixture()
  let binding = f.binding
  const request = vi.fn(async () => {
    binding = { ...binding, connectionEpoch: randomUUID(), connectionGeneration: 2 }
    return { payload: f.intent }
  })
  const loaded = await loadWorkerRsyncEntrypoint({ ...f, current: () => binding, ownership: () => undefined, request })
  if (loaded.kind !== 'configured') throw new Error('not mounted')
  try {
    await expect(loaded.providers.accepted.intent(f.intent.transferId, f.binding)).rejects.toThrow('another original transfer')
  } finally {
    await loaded.close()
  }
})
