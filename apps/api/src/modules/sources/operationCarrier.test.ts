import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { TransferIntentSchema } from '@foreman-code/contracts/byte-transfer'
import type { DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import { SourceMaterializationRecordSchema, type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { CarrierRemoteSourceMaterializationHost, createMainSourceOperationExtension } from './operationCarrier.js'
import { DeviceApplicationError } from '../devices/deviceApplicationChannel.js'
import { sourceStorageCapacityFixture } from '../../../test/helpers/sourceStorageCapacityFixture.js'

function fixture() {
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
    keyRevision: 1, authorizationRevision: 1, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const intent = TransferIntentSchema.parse({ version: 1, mainId: binding.mainId, deviceId: binding.deviceId,
    workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1, bootId: binding.bootId,
    connectionEpoch: binding.connectionEpoch, transferId: randomUUID(), operationId: randomUUID(), executionId: randomUUID(),
    attemptId: randomUUID(), rootId: randomUUID(), rootBindingRevision: 1, placementHash: 'a'.repeat(64), direction: 'to-worker',
    byteClass: 'source', sha256: 'b'.repeat(64), byteSize: 4, manifestDigest: 'c'.repeat(64), chunkBytes: 8192,
    expiresAt: new Date(Date.now() + 60_000).toISOString() })
  const filesystem = { device: '1', inode: '2', mountId: '3' }
  const record = SourceMaterializationRecordSchema.parse({ receipt: { version: 1, materializationId: randomUUID(),
    binding: { version: 1, mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId,
      workspaceId: 'workspace', rootId: intent.rootId, bindingRevision: 1, locationRevision: 1, canonicalPath: '/original/namespace',
      filesystem, accessMode: 'exclusive-write', snapshotId: randomUUID(), manifestDigest: intent.manifestDigest },
    placementHash: intent.placementHash, executionId: intent.executionId, attemptId: intent.attemptId, keyRevision: 1, authorizationRevision: 1,
    verifiedManifestDigest: intent.manifestDigest, verifiedEntries: 1, verifiedBytes: 4, verifiedAt: new Date().toISOString(), localTreeIdentity: filesystem },
    rootPolicyId: randomUUID(), rootPolicyRevision: '1', operationId: intent.operationId, reservationId: randomUUID(),
    sourceBindingHash: intent.placementHash, finalDispatchBindingHash: null, state: 'prepared' })
  const root: SourceRootRecord = { version: 1, binding: record.receipt.binding,
    source: { approvedSourceId: randomUUID(), snapshotId: record.receipt.binding.snapshotId,
      manifestDigest: record.receipt.verifiedManifestDigest },
    selection: { hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
      rootPolicyId: record.rootPolicyId, rootPolicyRevision: '1', locationRevision: '1' },
    registration: { workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner', attestationId: randomUUID(),
    attestationDigest: 'd'.repeat(64), boundAt: new Date().toISOString() }
  // Original SQL authority is a contract double, not a persisted/physical claim.
  const lifecycle = { status: vi.fn(async () => ({ intent, record })) }
  const owners = { resolve: vi.fn(async () => { throw new Error('No filesystem owner lookup in status fixture') }) }
  const transfers = { intent: vi.fn(async () => intent) }
  const extension = createMainSourceOperationExtension(owners, transfers, lifecycle)
  const context = { binding, signal: new AbortController().signal }
  return { binding, intent, record, root, lifecycle, owners, transfers, extension, context }
}

describe('original Main committed source-status carrier', () => {
  it('reads only the original lifecycle using the actual authenticated frame and preserves exact facts', async () => {
    const f = fixture()
    const reply = await f.extension.handle!({ version: 1, operation: 'sources.transfer-status', transferId: f.intent.transferId }, f.context)
    expect(f.lifecycle.status).toHaveBeenCalledWith(f.intent.transferId, f.binding)
    expect(reply.payload).toEqual({ version: 1, operation: 'sources.transfer-status', intent: f.intent, record: f.record })
    expect(f.owners.resolve).not.toHaveBeenCalled(); expect(f.transfers.intent).not.toHaveBeenCalled()
  })
  it('propagates denied authority and rejects peer bytes, missing providers and caller ACK flags', async () => {
    const f = fixture(), request = { version: 1, operation: 'sources.transfer-status', transferId: f.intent.transferId }
    f.lifecycle.status.mockRejectedValueOnce(new Error('Original caller denied'))
    await expect(f.extension.handle!(request, f.context)).rejects.toThrow('Original caller denied')
    await expect(f.extension.handle!(request, { ...f.context, bytes: Buffer.from('peer ACK') })).rejects.toThrow()
    expect(f.lifecycle.status).toHaveBeenCalledTimes(1)
    await expect(f.extension.handle!({ ...request, published: true }, f.context)).rejects.toThrow()
    const missing = createMainSourceOperationExtension(f.owners, f.transfers)
    await expect(missing.handle!(request, f.context)).rejects.toMatchObject({ code: 'SOURCE_TRANSFER_STATUS_UNAVAILABLE' })
  })
})

it('uses the accepted remote allocation for capacity and rejects another filesystem measurement', async () => {
  const f = fixture()
  const identity: DeviceConnectionIdentity & { connectionEpoch?: string } = { ...f.binding }
  delete identity.connectionEpoch
  const capacity = sourceStorageCapacityFixture({ filesystem: f.root.binding.filesystem })
  const request = vi.fn(async () => ({ payload: { version: 1, operation: 'sources.capacity', capacity } }))
  const owner = { operationId: f.intent.operationId, ownerPrincipalId: 'owner',
    expiresAt: new Date(Date.now() + 60_000).toISOString() }
  const publish = vi.fn(async (): Promise<never> => { throw new Error('No capacity publication') })
  const host = new CarrierRemoteSourceMaterializationHost({ capture: () => ({ identity, request }) },
    { prepareIdentity: async () => owner, resolve: async () => { throw new Error('No materialization lookup') } },
    { publish })
  const attempt = { placementHash: f.intent.placementHash, executionId: f.intent.executionId,
    attemptId: f.intent.attemptId, keyRevision: 1, authorizationRevision: 1 }
  expect(await host.storageCapacity(f.root, attempt)).toEqual(capacity)
  expect(publish).not.toHaveBeenCalled()
  request.mockResolvedValueOnce({ payload: { version: 1, operation: 'sources.capacity',
    capacity: { ...capacity, filesystem: { ...capacity.filesystem, inode: '99' } } } })
  await expect(host.storageCapacity(f.root, attempt)).rejects.toMatchObject({ code: 'SOURCE_RESPONSE_INVALID' })
})

it.each(['SOURCE_CAPACITY', 'SOURCE_DISK_CAPACITY'])('preserves %s from the Worker for bounded admission backoff',
  async code => {
    const f = fixture()
    const identity: DeviceConnectionIdentity & { connectionEpoch?: string } = { ...f.binding }
    delete identity.connectionEpoch
    const host = new CarrierRemoteSourceMaterializationHost({ capture: () => ({ identity,
      request: async () => { throw new DeviceApplicationError(code) } }) },
    { prepareIdentity: async () => ({ operationId: f.intent.operationId, ownerPrincipalId: 'owner',
      expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      resolve: async () => { throw new Error('No materialization lookup') } },
    { publish: async () => { throw new Error('No publication') } })
    const attempt = { placementHash: f.intent.placementHash, executionId: f.intent.executionId,
      attemptId: f.intent.attemptId, keyRevision: 1, authorizationRevision: 1 }
    await expect(host.storageCapacity(f.root, attempt)).rejects.toMatchObject({ code, status: 409 })
  })

it.each(['timeout', 'source-repository-timeout'])('maps %s from the exact repository request to a sanitized retryable domain error', async code => {
  const f = fixture(), request = vi.fn(async () => { throw new DeviceApplicationError(code) })
  const root = f.root
  const { connectionEpoch: _epoch, ...identity } = f.binding
  void _epoch
  const host = new CarrierRemoteSourceMaterializationHost({ capture: () => ({ identity, request }) },
    { prepareIdentity: async () => { throw new Error('No new owner') }, resolve: async () => ({ root }) as never },
    { publish: async () => { throw new Error('No new publication') } })
  await expect(host.privateRepository(f.record, {} as never)).rejects.toMatchObject({ code: 'SOURCE_REPOSITORY_TIMEOUT', status: 503, details: { retryable: true } })
  expect(request).toHaveBeenCalledOnce()
})

it('waits out the Worker preparation budget instead of cancelling an activation midway', async () => {
  const f = fixture()
  const root = f.root
  const { connectionEpoch: _epoch, ...identity } = f.binding
  void _epoch
  const request = vi.fn<(namespace: string, payload: unknown, options?: { timeoutMs?: number }) => Promise<{ payload: unknown }>>(
    async () => ({ payload: { version: 1, operation: 'sources.prepare', receipt: f.record.receipt } }))
  const host = new CarrierRemoteSourceMaterializationHost({ capture: () => ({ identity, request }) },
    { prepareIdentity: async () => ({ operationId: f.intent.operationId, expiresAt: new Date(Date.now() + 600_000).toISOString() }) as never, resolve: async () => ({ root }) as never },
    { publish: async () => ({ repository: 'octo/site', commit: 'e'.repeat(40), executablePolicy: 'preserve-approved' as const }) })
  const manifest = { manifestDigest: f.intent.manifestDigest, totalEntries: 1, totalBytes: 4 } as never
  const attempt = { placementHash: f.intent.placementHash, executionId: f.intent.executionId, attemptId: f.intent.attemptId,
    keyRevision: 1, authorizationRevision: 1 }
  await expect(host.prepare(manifest, root, attempt)).resolves.toEqual(f.record.receipt)
  // The Worker's own preparation budget is five minutes; a shorter Main deadline would cancel a slow activation.
  expect(request.mock.calls[0]![2]!.timeoutMs).toBeGreaterThan(300_000)
})

it('carries a selected remote root and accepted prefix and rejects a substituted branch receipt', async () => {
  const f = fixture()
  const worktree = { repository: 'octo/site', branch: 'foreman/site/reviewer' }
  const commit = 'e'.repeat(40)
  const receipt = { ...f.record.receipt, claimScope: 'execution' as const,
    sharedTree: { id: randomUUID(), referenceIdentity: f.record.receipt.binding.filesystem },
    worktree: { ...worktree, branch: `${worktree.branch}-${randomUUID()}`, commit } }
  const identity: DeviceConnectionIdentity & { connectionEpoch?: string } = { ...f.binding }
  delete identity.connectionEpoch
  const request = vi.fn<(namespace: string, payload: unknown,
    options?: { timeoutMs?: number }) => Promise<{ payload: unknown }>>(
    async () => ({ payload: { version: 1, operation: 'sources.prepare', receipt } }))
  const capture = vi.fn(() => ({ identity, request }))
  const host = new CarrierRemoteSourceMaterializationHost({ capture },
    { prepareIdentity: async () => ({ operationId: f.intent.operationId, expiresAt: new Date(Date.now() + 600_000).toISOString() }) as never,
      resolve: async () => ({ root: f.root }) as never },
    { publish: async () => ({ repository: worktree.repository, commit, executablePolicy: 'preserve-approved' as const }) })
  const manifest = { manifestDigest: f.intent.manifestDigest, totalEntries: 1, totalBytes: 4,
    git: { commit, repository: worktree.repository } } as never
  const attempt = { placementHash: f.intent.placementHash, executionId: f.intent.executionId,
    attemptId: f.intent.attemptId, keyRevision: 1, authorizationRevision: 1 }
  expect(await host.prepare(manifest, f.root, attempt, { worktree })).toEqual(receipt)
  expect(capture).toHaveBeenCalledWith(f.binding.deviceId)
  // The Worker fetches the approved commit from GitHub; Main sends only the reference.
  expect(request.mock.calls[0]?.[1]).toMatchObject({ operation: 'sources.prepare', root: f.root, worktree,
    github: { repository: worktree.repository, commit } })
  receipt.worktree.branch = `foreman/substituted-${randomUUID()}`
  await expect(host.prepare(manifest, f.root, attempt, { worktree }))
    .rejects.toMatchObject({ code: 'SOURCE_WORKTREE_CONFLICT' })
})


it('keeps a Worker retained-tree measurement bound to the original materialization', async () => {
  const f = fixture()
  const treeId = randomUUID()
  const record = SourceMaterializationRecordSchema.parse({ ...f.record,
    receipt: { ...f.record.receipt, claimScope: 'execution',
      sharedTree: { id: treeId, referenceIdentity: f.record.receipt.binding.filesystem } } })
  const payload = { version: 1, operation: 'sources.release', materializationId: record.receipt.materializationId,
    operationId: record.operationId, released: true, retainedBytes: 2 * 1024 * 1024 * 1024,
    sharedTree: { id: treeId, bytes: 4096 }, worktree: { state: 'retained' as const,
      removalAttempted: true as const, message: 'Uncommitted changes remain.' } }
  const identity: DeviceConnectionIdentity & { connectionEpoch?: string } = { ...f.binding }
  delete identity.connectionEpoch
  const host = new CarrierRemoteSourceMaterializationHost({ capture: () => ({ identity,
    request: async () => ({ payload }) }) },
  { prepareIdentity: async () => { throw new Error('No preparation') }, resolve: async () => ({ root: f.root }) as never },
  { publish: async () => { throw new Error('No publication') } })
  expect(await host.releaseClaim(record)).toEqual({ retainedBytes: payload.retainedBytes, sharedTree: payload.sharedTree, worktree: payload.worktree })
  payload.sharedTree.id = randomUUID()
  await expect(host.releaseClaim(record)).rejects.toMatchObject({ code: 'SOURCE_RESPONSE_INVALID' })
})
