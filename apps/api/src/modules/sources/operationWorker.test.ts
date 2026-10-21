import { randomUUID } from 'node:crypto'
import { MainClock } from '../devices/workerClock.js'
import { PostgresSourceReservations } from './reservations.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { SourceReservationReclamation } from '@foreman-code/contracts/source-operations'
import { releaseMaterializationClaim } from './materialization.js'
import { mkdtemp, mkdir, rm, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { SourceRootRecord, SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import type { SourceActiveNativeSession, SourceFilesystemOperation, SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import type { SourceInstalledNativeOwner } from './executionHosts.js'
import { captureGitSource } from './capture.js'
import { systemGitWorktreePorts, type GitWorktreePorts } from './gitWorktree.js'
import { gitFixtureEnvironment } from '../../../test/helpers/gitFixture.js'
import { qualifyApprovedRootAllowlist } from './rootAttestation.js'
import { identity, openPrivateRoot } from './privateFilesystem.js'
import { sourceBindingHash } from './bindingHash.js'
import { sourceOperationSelectionHash } from './operationDigests.js'
import { sourceCwdAttestationDigest } from './workingDirectory.js'
import { SourceOperationWorkerService, type SourceOperationWorkerOptions } from './operationWorker.js'
import { installedSourceQuotaPool } from '../jobs/quotaOwnership.js'
import { sourceMaterializationParent } from '@foreman-code/contracts/source-materialization'
import type { SourceQuotaPool } from './materialization.js'
import { verificationCapacityFixture } from '../../../test/helpers/verificationCapacityFixture.js'
import { persistentFixtureRoot } from '../../../test/helpers/fixtureStorage.js'
import { deferred } from '../../../test/helpers/deferred.js'
const directories: string[] = []
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }) })
async function fixture(options: { mainNow?: () => number } = {}) {
  const directory = await mkdtemp(join(persistentFixtureRoot, 'source-rpc-')); directories.push(directory)
  const runtime = join(directory, 'runtime'), base = join(directory, 'projects'); await mkdir(runtime, { mode: 0o700 }); await mkdir(base, { mode: 0o700 })
  const binding: DeviceSessionBinding = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), bootId: randomUUID(), keyRevision: 1, authorizationRevision: 1, connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const roots = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId }, applicationInstallationId: binding.workerInstallationId,
    configurationRevision: '1', bases: [{ baseId: randomUUID(), canonicalPath: base, accessModes: ['read-only', 'read-write'] }], managedRuntimeRoot: runtime })
  const policyId = randomUUID(), parent = join(runtime, 'source-materializations'), namespace = join(parent, policyId); await mkdir(parent, { mode: 0o700 }); await mkdir(namespace, { mode: 0o700 })
  const handle = await openPrivateRoot(namespace); const filesystem = await identity(handle); await handle.close()
  const bytes = Buffer.from('export const actual = true\n')
  // A local origin stands in for GitHub: the Worker fetches the approved commit from it with its own clone.
  const origin = join(directory, 'origin'), environment = gitFixtureEnvironment()
  const run = (...args: string[]) => execFileSync('git', args, { cwd: origin, env: environment, encoding: 'utf8' }).trim()
  await mkdir(join(origin, 'src'), { recursive: true }); run('init', '-q', '-b', 'main')
  await writeFile(join(origin, 'src/source.txt'), bytes); run('add', '.'); run('commit', '-qm', 'source')
  const commit = run('rev-parse', 'HEAD'), approvedSourceId = randomUUID()
  const capture = (snapshotId: string, at = commit) => captureGitSource({ root: origin, approvedSourceId, snapshotId, commit: at,
    repository: 'octo/site', executablePolicy: 'strip',
    sink: { write: async () => {}, writeGitMetadata: async () => {}, commit: async () => {}, abort: async () => {} } })
  const manifest = await capture(randomUUID())
  const system = systemGitWorktreePorts(environment)
  const git = vi.fn<GitWorktreePorts['git']>((args, options) => system.git(args[0] === 'clone'
    ? ['clone', '--no-checkout', '--template=', origin, args.at(-1)!] : args, options))
  const source = { snapshotId: manifest.snapshotId, approvedSourceId: manifest.approvedSourceId, manifestDigest: manifest.manifestDigest }
  const root: SourceRootRecord = { version: 1, source, selection: { hostRef: roots.hostRef, rootPolicyId: policyId, rootPolicyRevision: '1', locationRevision: '1' },
    binding: { version: 1, workspaceId: 'workspace-actual-fixture', mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId, rootId: randomUUID(), bindingRevision: 1,
      locationRevision: 1, canonicalPath: namespace, filesystem, accessMode: 'exclusive-write', snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
    ownerPrincipalId: 'principal-human-fixture', authorizedByPrincipalId: 'principal-preparation-fixture', registration: { workerInstallationId: binding.workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
    attestationId: randomUUID(), attestationDigest: 'b'.repeat(64), boundAt: new Date().toISOString() }
  const operationId = randomUUID(), attempt = { executionId: randomUUID(), attemptId: randomUUID(), placementHash: '', keyRevision: 1, authorizationRevision: 1 }
  attempt.placementHash = sourceBindingHash(root, attempt, operationId)
  expect(sourceOperationSelectionHash(root, attempt, operationId)).toBe(attempt.placementHash)
  const owner: SourceOperationOwner = { identity: { operationId, ownerPrincipalId: root.authorizedByPrincipalId, expiresAt: new Date(Date.now() + 120_000).toISOString() }, root, attempt, source, record: null, physicalClosureConfirmed: false }
  const request: SourceFilesystemOperation = { version: 1, operation: 'sources.prepare', identity: owner.identity, root, attempt, github: { repository: 'octo/site', commit, executablePolicy: 'strip' } }
  const readRoots = vi.fn(async () => roots)
  const currentOwner = vi.fn(async () => structuredClone(owner))
  const nativeOwnerFor = vi.fn(async (): Promise<SourceInstalledNativeOwner | null> => null)
  const preparationNativeClosed = vi.fn(async () => true)
  const preparationTransfersClosed = vi.fn(async () => {})
  const preparationReconciled = vi.fn(async () => {})
  const quotaPoolFor = vi.fn<NonNullable<SourceOperationWorkerOptions['quotaPoolFor']>>(
    async (): Promise<SourceQuotaPool | undefined> => undefined)
  const currentReclamation = vi.fn(async (): Promise<SourceReservationReclamation> => {
    throw new Error('No reservation cleanup in this fixture')
  })
  const reclamationNativeClosed = vi.fn(async () => true)
  const service = new SourceOperationWorkerService({ mainNow: () => Date.now(), ...options, authenticate: async () => {}, approvedRoots: readRoots, currentOwner,
    git: { cloneDirectory: () => join(directory, 'worker-clone'), git },
    nativeOwnerFor, preparationNativeClosed, preparationTransfersClosed, preparationReconciled, quotaPoolFor,
    currentReclamation, reclamationNativeClosed })
  const context = { binding, signal: new AbortController().signal }
  return { directory, runtime, namespace, bytes, manifest, root, owner, request, context, service, currentOwner,
    readRoots, git, capture, origin, run, nativeOwnerFor, preparationNativeClosed, preparationTransfersClosed, preparationReconciled,
    currentReclamation, reclamationNativeClosed, quotaPoolFor }
}

it('measures only the authorized Worker filesystem without source writes or publication', async () => {
  const f = await fixture()
  f.owner.quotaRequired = true
  const request = { version: 1, operation: 'sources.capacity', root: f.root,
    attempt: f.owner.attempt, identity: f.owner.identity }
  const response = await f.service.handle(request, f.context)
  expect(response.operation).toBe('sources.capacity')
  if (response.operation !== 'sources.capacity') throw new Error('Expected capacity measurement')
  expect(response.capacity.filesystem).toEqual(f.root.binding.filesystem)
  expect(response.capacity.totalBytes).toBeGreaterThan(0)
  expect(response.capacity.availableBytes).toBeLessThanOrEqual(response.capacity.totalBytes)
  expect(response.capacity.cpuCount).toBeGreaterThan(0)
  expect(f.git).not.toHaveBeenCalled()
  expect(f.quotaPoolFor).not.toHaveBeenCalled()
  expect(f.currentOwner).toHaveBeenCalledTimes(2)
  expect(f.owner.record).toBeNull()
  await expect(f.service.handle({ ...request, root: { ...f.root,
    binding: { ...f.root.binding, filesystem: { ...f.root.binding.filesystem, device: '999999' } } } },
  f.context)).rejects.toMatchObject({ code: 'SOURCE_OPERATION_AUTHORITY_CONFLICT' })
  f.currentOwner.mockRejectedValueOnce(new Error('Allocation denied'))
  await expect(f.service.handle(request, f.context)).rejects.toThrow('Allocation denied')
})

it.each([-90_000, 5_000, 90_000])(
  'reserves Worker capacity in Main time with a %s ms Worker offset', async offset => {
    const mainTime = Date.now()
    let elapsed = 0
    const mainClock = new MainClock(() => elapsed)
    mainClock.observe(mainTime)
    const f = await fixture({ mainNow: () => mainClock.now() })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(mainTime + offset)
      elapsed = 2_000
      const response = await f.service.handle({ version: 1, operation: 'sources.capacity', root: f.root,
        attempt: f.owner.attempt, identity: f.owner.identity }, f.context)
      if (response.operation !== 'sources.capacity') throw new Error('Expected capacity measurement')
      vi.setSystemTime(mainClock.now())
      const empty = { rows: [], rowCount: 0 }
      const query = vi.fn().mockResolvedValue(empty)
        .mockResolvedValueOnce(empty).mockResolvedValueOnce(empty)
        .mockResolvedValueOnce({ rows: [{ bytes: '0', verification_bytes: '0', pending_bytes: '0',
          retained_bytes: '0', verification_retained_bytes: '0', preparing: '0',
          materializations: '0', verification_materializations: '0' }], rowCount: 1 })
      const sql = { query } as unknown as GraphSqlClient
      const reservation = new PostgresSourceReservations()
      const request = { scopeId: randomUUID(), ownerKind: 'capture' as const,
        ownerId: randomUUID(), reservedBytes: 4096 }
      await expect(reservation.reserve(sql, request, { capacity: response.capacity }))
        .resolves.toMatchObject({ ...request, storageCapacity: response.capacity })
      expect(response.capacity.observedAt).toBe(new Date(mainTime + elapsed).toISOString())
      vi.setSystemTime(mainClock.now() + 10_001)
      await expect(reservation.reserve({ query: vi.fn().mockResolvedValue(empty) } as unknown as GraphSqlClient,
        { ...request, ownerId: randomUUID() }, { capacity: response.capacity }))
        .rejects.toMatchObject({ code: 'SOURCE_CAPACITY_UNAVAILABLE' })
    } finally {
      vi.useRealTimers()
    }
  },
)

it('rejects capacity readback when the source owner changes during measurement', async () => {
  const f = await fixture()
  const roots = await f.readRoots()
  f.readRoots.mockImplementation(async () => {
    f.owner.quotaRequired = true
    return roots
  })
  await expect(f.service.handle({ version: 1, operation: 'sources.capacity', root: f.root,
    attempt: f.owner.attempt, identity: f.owner.identity }, f.context))
    .rejects.toMatchObject({ code: 'SOURCE_OPERATION_AUTHORITY_CONFLICT' })
  expect(f.git).not.toHaveBeenCalled()
  expect(f.quotaPoolFor).not.toHaveBeenCalled()
})

it('allows concurrent host probes for several Agents without the former two-request bottleneck', async () => {
  const f = await fixture()
  let entered = 0
  let release!: () => void
  const ready = new Promise<void>(resolve => { release = resolve })
  const roots = await f.readRoots()
  f.readRoots.mockImplementation(async () => { entered++; await ready; return roots })
  const request = { version: 1, operation: 'sources.capacity', root: f.root,
    attempt: f.owner.attempt, identity: f.owner.identity }
  const probes = Array.from({ length: 3 }, () => f.service.handle(request, f.context))
  const settled = Promise.allSettled(probes)
  try {
    await vi.waitFor(() => expect(entered).toBe(3))
  } finally { release() }
  const results = await settled
  expect(results.every(result => result.status === 'fulfilled'
    && result.value.operation === 'sources.capacity')).toBe(true)
  expect(f.git).not.toHaveBeenCalled()
})

async function installQuota(f: Awaited<ReturnType<typeof fixture>>) {
  const namespace = randomUUID()
  await mkdir(join(f.namespace, namespace), { mode: 0o700 })
  const directory = await openPrivateRoot(join(f.namespace, namespace))
  const filesystem = await identity(directory)
  await directory.close()
  const declared = verificationCapacityFixture('device').measurement!.fingerprint.quotaPool!
  const slot = { ...declared.slots[0]!, namespace, filesystem }
  const pool = { ...declared, slots: [slot] }
  const configuration = { schemaVersion: 2, root: structuredClone(f.root), descriptor: { quotaPool: pool } }
  const path = join(f.directory, 'job-runtime.json')
  await writeFile(path, JSON.stringify(configuration), { mode: 0o600 })
  const location = { path, ownerUid: process.getuid!() }
  // Only kernel readback is doubled; configuration selection, claims and source copying run normally.
  const read: NonNullable<SourceQuotaPool['read']> = async (_pool, path, signal) => {
    signal.throwIfAborted()
    const directory = await openPrivateRoot(path)
    const filesystem = await identity(directory)
    await directory.close()
    return { volumeCapacityBytes: 64 * 2 ** 30, volumeCapacityInodes: pool.volumeCapacityInodes,
      projectId: slot.projectId, inheritance: true, hardLimitBytes: slot.hardLimitBytes,
      hardInodes: slot.hardInodes, usedBytes: 0, usedInodes: 0, accountingEnabled: true, filesystem }
  }
  f.owner.quotaRequired = true
  f.quotaPoolFor.mockImplementation(async binding => {
    const selected = await installedSourceQuotaPool(location, binding)
    return selected ? { pool: selected, read } : undefined
  })
  return { configuration, location, slot }
}

it.each(['repository', 'branch'] as const)('rejects a substituted Agent %s before root or transfer I/O', async field => {
  const f = await fixture()
  if (f.request.operation !== 'sources.prepare') throw new Error('Expected preparation fixture')
  f.owner.preparationKind = 'workflow'
  f.owner.worktree = { repository: 'octo/site', branch: 'foreman/site/reviewer' }
  const request = { ...f.request, worktree: { ...f.owner.worktree,
    [field]: field === 'repository' ? 'another/site' : 'foreman/site/substituted' } }
  await expect(f.service.handle(request, f.context))
    .rejects.toMatchObject({ code: 'SOURCE_OPERATION_AUTHORITY_CONFLICT' })
  expect(f.readRoots).not.toHaveBeenCalled()
  expect(f.git).not.toHaveBeenCalled()
})

it('does not let an accepted branch request acquire writable authority from a read-only root', async () => {
  const f = await fixture()
  if (f.request.operation !== 'sources.prepare') throw new Error('Expected preparation fixture')
  f.owner.preparationKind = 'workflow'
  f.owner.worktree = { repository: 'octo/site', branch: 'foreman/site/reviewer' }
  f.root.binding.accessMode = 'read-only'
  f.owner.attempt.placementHash = sourceBindingHash(f.root, f.owner.attempt, f.owner.identity.operationId)
  await expect(f.service.handle({ ...f.request, worktree: f.owner.worktree }, f.context))
    .rejects.toMatchObject({ code: 'SOURCE_READ_ONLY' })
  expect(f.readRoots).not.toHaveBeenCalled()
  expect(f.git).not.toHaveBeenCalled()
})

it('prepares a quota-required Job after the approved root is rebound to a new snapshot', async () => {
  const f = await fixture()
  const installed = await installQuota(f)
  const manifest = await f.capture(randomUUID())
  f.root.source = { ...f.root.source, snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  f.root.binding = { ...f.root.binding, bindingRevision: f.root.binding.bindingRevision + 1,
    snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
  f.owner.source = f.root.source
  f.owner.attempt.placementHash = sourceBindingHash(f.root, f.owner.attempt, f.owner.identity.operationId)

  const prepared = await f.service.handle(f.request, f.context)
  if (prepared.operation !== 'sources.prepare') throw new Error('Expected source preparation')
  expect(prepared.receipt).toMatchObject({ binding: f.root.binding, quota: installed.slot,
    verifiedManifestDigest: manifest.manifestDigest })
  expect(await readFile(join(sourceMaterializationParent(prepared.receipt), 'tree/src/source.txt'))).toEqual(f.bytes)
  expect(JSON.parse(await readFile(installed.location.path, 'utf8'))).toEqual(installed.configuration)
  expect(await f.service.handle(f.request, f.context)).toEqual(prepared)
})

it.each(['rootId', 'workerInstallationId', 'canonicalPath'] as const)(
  'denies quota-required preparation when the installed quota belongs to another %s', async field => {
    const f = await fixture()
    const installed = await installQuota(f)
    installed.configuration.root.binding[field] = field === 'canonicalPath' ? '/another/approved/root' : randomUUID()
    await writeFile(installed.location.path, JSON.stringify(installed.configuration))
    await expect(f.service.handle(f.request, f.context)).rejects.toMatchObject({ code: 'SOURCE_QUOTA_MISSING' })
    expect(f.git).not.toHaveBeenCalled()
  })

it('finds and removes an abandoned Worker materialization without Main preparation metadata', async () => {
  const f = await fixture()
  const prepared = await f.service.handle(f.request, f.context)
  if (prepared.operation !== 'sources.prepare') throw new Error('Expected source preparation')
  const grant: SourceReservationReclamation = { reservationId: randomUUID(), reclamationId: randomUUID(),
    operationId: f.owner.identity.operationId, expiresAt: f.owner.identity.expiresAt,
    roots: [f.root], owner: null, scopeId: 'original-device-filesystem' }
  f.currentReclamation.mockResolvedValue(grant)
  const request = { version: 1, operation: 'sources.reclaim-reservation',
    reservationId: grant.reservationId, reclamationId: grant.reclamationId }
  f.reclamationNativeClosed.mockResolvedValue(false)
  await expect(f.service.handle(request, f.context)).rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
  expect(await readFile(join(f.namespace, prepared.receipt.materializationId, 'tree', 'src/source.txt'))).toEqual(f.bytes)
  f.reclamationNativeClosed.mockResolvedValue(true)
  expect(await f.service.handle(request, f.context)).toMatchObject({ reclaimed: true, operationId: grant.operationId })
  await expect(readFile(join(f.namespace, prepared.receipt.materializationId, 'tree', 'src/source.txt')))
    .rejects.toMatchObject({ code: 'ENOENT' })
  expect(await f.service.handle(request, f.context)).toMatchObject({ reclaimed: true })
})

it('removes a closed retained copy through the authenticated Worker reclamation operation', async () => {
  const f = await fixture()
  const prepared = await f.service.handle(f.request, f.context)
  if (prepared.operation !== 'sources.prepare') throw new Error('Expected source preparation')
  await releaseMaterializationClaim(prepared.receipt, async () => 'released')
  const record = SourceMaterializationRecordSchema.parse({ receipt: prepared.receipt,
    operationId: f.owner.identity.operationId, reservationId: randomUUID(),
    rootPolicyId: f.root.selection.rootPolicyId, rootPolicyRevision: f.root.selection.rootPolicyRevision,
    sourceBindingHash: prepared.receipt.placementHash, finalDispatchBindingHash: null, state: 'closed' })
  const grant: SourceReservationReclamation = { reservationId: record.reservationId, reclamationId: randomUUID(),
    operationId: record.operationId, expiresAt: f.owner.identity.expiresAt, roots: [f.root],
    owner: { ...f.owner, record, preparationClosed: true }, scopeId: 'worker-filesystem', removeRetained: true }
  f.currentReclamation.mockResolvedValue(grant)
  expect(await f.service.handle({ version: 1, operation: 'sources.reclaim-reservation',
    reservationId: grant.reservationId, reclamationId: grant.reclamationId }, f.context))
    .toMatchObject({ reclaimed: true, operationId: grant.operationId })
  await expect(readFile(join(f.namespace, prepared.receipt.materializationId, 'receipt.json')))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not release a Worker reservation when Main cleanup authority is unavailable or changes', async () => {
  const f = await fixture()
  const request = { version: 1, operation: 'sources.reclaim-reservation',
    reservationId: randomUUID(), reclamationId: randomUUID() }
  await expect(f.service.handle(request, f.context)).rejects.toThrow('No reservation cleanup in this fixture')
  f.currentReclamation.mockResolvedValue({ reservationId: request.reservationId, reclamationId: randomUUID(),
    operationId: f.owner.identity.operationId, expiresAt: f.owner.identity.expiresAt,
    roots: [f.root], owner: null, scopeId: 'original-device-filesystem' })
  await expect(f.service.handle(request, f.context)).rejects.toMatchObject({ code: 'SOURCE_OPERATION_AUTHORITY_CONFLICT' })
  expect(f.reclamationNativeClosed).not.toHaveBeenCalled()
})

it.each(['missing', 'saved'] as const)('removes a released copy with %s Main preparation metadata', async metadata => {
  const f = await fixture()
  const prepared = await f.service.handle(f.request, f.context)
  if (prepared.operation !== 'sources.prepare') throw new Error('Expected source preparation')
  await releaseMaterializationClaim(prepared.receipt, async () => 'released')
  const grant: SourceReservationReclamation = { reservationId: randomUUID(), reclamationId: randomUUID(),
    operationId: f.owner.identity.operationId, expiresAt: f.owner.identity.expiresAt,
    roots: [f.root], owner: metadata === 'saved' ? f.owner : null, scopeId: 'original-device-filesystem' }
  f.currentReclamation.mockResolvedValue(grant)
  expect(await f.service.handle({ version: 1, operation: 'sources.reclaim-reservation',
    reservationId: grant.reservationId, reclamationId: grant.reclamationId }, f.context))
    .toMatchObject({ reclaimed: true, closures: [{ materializationId: prepared.receipt.materializationId }] })
  await expect(readFile(join(f.namespace, prepared.receipt.materializationId, 'tree', 'src/source.txt')))
    .rejects.toMatchObject({ code: 'ENOENT' })
})

it('leaves an in-flight Worker preparation alone', async () => {
  const f = await fixture()
  let entered!: () => void
  let resume!: () => void
  const opened = new Promise<void>(resolve => { entered = resolve })
  const paused = new Promise<void>(resolve => { resume = resolve })
  const fetch = f.git.getMockImplementation()!
  f.git.mockImplementationOnce(async (args, options) => {
    entered()
    await paused
    return fetch(args, options)
  })
  const preparation = f.service.handle(f.request, f.context)
  await opened
  const grant: SourceReservationReclamation = { reservationId: randomUUID(), reclamationId: randomUUID(),
    operationId: f.owner.identity.operationId, expiresAt: f.owner.identity.expiresAt,
    roots: [f.root], owner: f.owner, scopeId: 'original-device-filesystem' }
  f.currentReclamation.mockResolvedValue(grant)
  try {
    await expect(f.service.handle({ version: 1, operation: 'sources.reclaim-reservation',
      reservationId: grant.reservationId, reclamationId: grant.reclamationId }, f.context))
      .rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
    expect(f.reclamationNativeClosed).not.toHaveBeenCalled()
  } finally {
    resume()
    await preparation
  }
})

it('confirms preparation cleanup only after native closure and transfer reservations are released', async () => {
  const f = await fixture()
  f.owner.preparationClosed = true
  const request = { version: 1, operation: 'sources.reconcile-preparation', reconciliationId: randomUUID() }
  f.preparationNativeClosed.mockResolvedValue(false)
  await expect(f.service.handle(request, f.context)).rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
  expect(f.preparationTransfersClosed).not.toHaveBeenCalled()
  expect(f.preparationReconciled).not.toHaveBeenCalled()
  f.preparationNativeClosed.mockResolvedValue(true)
  const transferCleanup = deferred()
  const releaseTransfers = deferred()
  f.preparationTransfersClosed.mockImplementationOnce(async () => {
    transferCleanup.resolve()
    await releaseTransfers.promise
    throw new Error('Transfer cleanup incomplete')
  })
  const rejected = expect(f.service.handle(request, f.context)).rejects.toThrow('Transfer cleanup incomplete')
  try {
    await transferCleanup.promise
    expect(f.preparationReconciled).not.toHaveBeenCalled()
  } finally {
    releaseTransfers.resolve()
    await rejected
  }
  expect(f.preparationReconciled).not.toHaveBeenCalled()
  const response = await f.service.handle(request, f.context)
  expect(response).toMatchObject({ operation: request.operation, closure: {
    operationId: f.owner.identity.operationId, executionId: f.owner.attempt.executionId,
    claimReleased: true, childrenClosed: true, evidencePreserved: true,
  } })
  expect(f.preparationTransfersClosed).toHaveBeenCalledTimes(2)
  if (response.operation !== 'sources.reconcile-preparation') throw new Error('Wrong cleanup response')
  expect(f.preparationReconciled).toHaveBeenCalledWith(response.closure)
})

it('closes an unmaterialized verification attempt using its installed quota after a source rebind', async () => {
  const f = await fixture()
  f.owner.preparationClosed = true
  f.owner.quotaRequired = true
  const profile = verificationCapacityFixture('main')
  const pool = profile.measurement!.fingerprint.quotaPool!
  const path = join(f.directory, 'job-runtime.json')
  await writeFile(path, JSON.stringify({ schemaVersion: 2,
    root: { binding: { ...f.root.binding, bindingRevision: 2, snapshotId: randomUUID(), manifestDigest: 'c'.repeat(64) } },
    descriptor: { quotaPool: pool } }), { mode: 0o600 })
  f.quotaPoolFor.mockImplementation(async binding => {
    const selected = await installedSourceQuotaPool({ path, ownerUid: process.getuid!() }, binding)
    return selected ? { pool: selected } : undefined
  })
  const response = await f.service.handle({ version: 1, operation: 'sources.reconcile-preparation',
    reconciliationId: randomUUID() }, f.context)
  expect(response).toMatchObject({ operation: 'sources.reconcile-preparation', closure: {
    materializationId: null, operationId: f.owner.identity.operationId,
    admissionClosed: true, childrenClosed: true, claimReleased: true,
  } })
  expect(f.preparationTransfersClosed).toHaveBeenCalledTimes(1)
  expect(f.preparationReconciled).toHaveBeenCalledTimes(1)
})

async function continuationFixture() {
  const f = await fixture(), prepared = await f.service.handle(f.request, f.context)
  if (prepared.operation !== 'sources.prepare') throw new Error('wrong fixture operation')
  const record: SourceMaterializationRecord = { receipt: prepared.receipt, operationId: f.owner.identity.operationId, reservationId: randomUUID(), rootPolicyId: f.root.selection.rootPolicyId,
    rootPolicyRevision: '1', sourceBindingHash: f.owner.attempt.placementHash, finalDispatchBindingHash: 'c'.repeat(64), state: 'prepared' }
  f.owner.record = record
  const cwd = await f.service.handle({ version: 1, operation: 'sources.verify', record, relativeCwd: 'src' }, f.context)
  if (cwd.operation !== 'sources.verify') throw new Error('wrong fixture operation')
  const proof: SourceActiveNativeSession = { version: 1, executionId: record.receipt.executionId, runId: randomUUID(), technicalAttempt: 3,
    attemptId: record.receipt.attemptId, operationId: record.operationId, materializationId: record.receipt.materializationId,
    sourceBindingHash: record.sourceBindingHash, finalDispatchBindingHash: record.finalDispatchBindingHash!,
    nativeSession: { harness: 'codex', nativeSessionId: randomUUID(), providerVersion: 'test-current-version' }, generation: 2,
    cwdAttestation: cwd.cwdAttestation,
    entry: { sourceId: randomUUID(), sourceDigest: `sha256:${'d'.repeat(64)}`, launchDigest: `sha256:${'e'.repeat(64)}` },
    owner: { grantId: randomUUID(), epoch: '1' }, lane: { id: randomUUID(), revision: 3, tokenHash: 'f'.repeat(64), expiresAt: f.owner.identity.expiresAt } }
  const lifetime = new AbortController(), assertCurrent = vi.fn(async () => {})
  const installed: SourceInstalledNativeOwner = { executionId: proof.executionId, runId: proof.runId, technicalAttempt: proof.technicalAttempt,
    attemptId: proof.attemptId, operationId: proof.operationId, materializationId: proof.materializationId, sourceBindingHash: proof.sourceBindingHash,
    finalDispatchBindingHash: proof.finalDispatchBindingHash, session: structuredClone(proof.nativeSession), owner: structuredClone(proof.owner), signal: lifetime.signal, assertCurrent }
  f.nativeOwnerFor.mockResolvedValue(installed)
  const tree = join(f.namespace, record.receipt.materializationId, 'tree')
  return { ...f, record, proof, installed, lifetime, assertCurrent, tree }
}
it('preserves strict pre-entry bytes and permits edits only on the same current entered installed native owner', async () => {
  const f = await continuationFixture()
  const request = { version: 1, operation: 'sources.verify', record: f.record, relativeCwd: 'src' }
  await f.service.handle(request, f.context)
  const edited = Buffer.from('export const editedByActualOwner = true\n')
  await writeFile(join(f.tree, 'src/source.txt'), edited)
  await writeFile(join(f.tree, 'src/new-output.ts'), 'actual owner output\n')
  await expect(f.service.handle(request, f.context)).rejects.toThrow()
  expect(f.nativeOwnerFor).not.toHaveBeenCalled()
  f.owner.activeNativeSession = f.proof
  const result = await f.service.handle(request, f.context)
  expect(result.operation).toBe('sources.verify')
  expect(await readFile(join(f.tree, 'src/source.txt'))).toEqual(edited)
  expect(f.assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(4)
  expect(f.git.mock.calls.filter(([args]) => args[0] === 'clone')).toHaveLength(1)
})
it('keeps source verification valid while the same native writer renews its lease', async () => {
  const f = await continuationFixture()
  f.owner.activeNativeSession = f.proof
  f.currentOwner.mockImplementation(async () => {
    f.proof.lane.revision++
    f.proof.lane.expiresAt = new Date(Date.parse(f.proof.lane.expiresAt) + 1000).toISOString()
    return structuredClone(f.owner)
  })
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record: f.record, relativeCwd: 'src' }, f.context))
    .resolves.toMatchObject({ operation: 'sources.verify' })
})

it.each(['token', 'generation', 'revision', 'expiry'] as const)('rejects a changed native %s while refreshing source authority', async change => {
  const f = await continuationFixture()
  f.owner.activeNativeSession = f.proof
  let reads = 0
  f.currentOwner.mockImplementation(async () => {
    if (++reads === 2) {
      if (change === 'token') f.proof.lane.tokenHash = 'a'.repeat(64)
      if (change === 'generation') f.proof.generation++
      if (change === 'revision') f.proof.lane.revision--
      if (change === 'expiry') f.proof.lane.expiresAt = new Date(Date.parse(f.proof.lane.expiresAt) - 1000).toISOString()
    }
    return structuredClone(f.owner)
  })
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record: f.record, relativeCwd: 'src' }, f.context))
    .rejects.toMatchObject({ code: 'SOURCE_OPERATION_AUTHORITY_CONFLICT' })
})
it.each(['attempt', 'technical-attempt', 'session', 'owner', 'expiry', 'missing-installed', 'aborted'] as const)('denies mutable continuation with %s evidence', async defect => {
  const f = await continuationFixture(); f.owner.activeNativeSession = f.proof
  await writeFile(join(f.tree, 'src/source.txt'), 'edited\n')
  if (defect === 'attempt') f.installed.attemptId = randomUUID()
  if (defect === 'technical-attempt') f.installed.technicalAttempt++
  if (defect === 'session') f.installed.session.nativeSessionId = randomUUID()
  if (defect === 'owner') f.installed.owner.epoch = '2'
  if (defect === 'expiry') f.proof.lane.expiresAt = new Date(Date.now() - 1).toISOString()
  if (defect === 'missing-installed') f.nativeOwnerFor.mockResolvedValue(null)
  if (defect === 'aborted') f.lifetime.abort(new Error('original owner closed'))
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record: f.record }, f.context)).rejects.toThrow()
})
it('rejects current proof revocation during FD verification and symlink/root/tree replacement', async () => {
  const f = await continuationFixture(); f.owner.activeNativeSession = f.proof
  f.assertCurrent.mockImplementation(async () => { if (f.assertCurrent.mock.calls.length === 4) f.lifetime.abort(new Error('revoked during FD verification')) })
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record: f.record }, f.context)).rejects.toThrow('revoked during')
  const child = await continuationFixture(); child.owner.activeNativeSession = child.proof
  await rename(join(child.tree, 'src'), join(child.tree, 'original-src')); await symlink('original-src', join(child.tree, 'src'))
  await expect(child.service.handle({ version: 1, operation: 'sources.verify', record: child.record, relativeCwd: 'src' }, child.context)).rejects.toThrow()
  const tree = await continuationFixture(); tree.owner.activeNativeSession = tree.proof
  await rename(tree.tree, `${tree.tree}-original`); await mkdir(tree.tree, { mode: 0o700 })
  await expect(tree.service.handle({ version: 1, operation: 'sources.verify', record: tree.record }, tree.context)).rejects.toThrow('identity changed')
  const root = await continuationFixture(); root.owner.activeNativeSession = root.proof
  await rename(root.namespace, `${root.namespace}-original`); await mkdir(root.namespace, { mode: 0o700 })
  await expect(root.service.handle({ version: 1, operation: 'sources.verify', record: root.record }, root.context)).rejects.toThrow('root changed')
})
it('retains opened CWD identity and rejects replacement while reauthorizing the original native owner', async () => {
  const f = await continuationFixture(); f.owner.activeNativeSession = f.proof
  f.assertCurrent.mockImplementation(async () => {
    if (f.assertCurrent.mock.calls.length === 4) {
      await rename(join(f.tree, 'src'), join(f.tree, 'original-src'))
      await mkdir(join(f.tree, 'src'), { mode: 0o700 })
    }
  })
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record: f.record, relativeCwd: 'src' }, f.context)).rejects.toThrow('Working directory changed during')
})
it('rejects a replaced child CWD between continuation requests using its original native entry attestation', async () => {
  const f = await continuationFixture(); f.owner.activeNativeSession = f.proof
  await rename(join(f.tree, 'src'), join(f.tree, 'original-src'))
  await mkdir(join(f.tree, 'src'), { mode: 0o700 })
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record: f.record, relativeCwd: 'src' }, f.context)).rejects.toThrow('original entered native directory')
})
it('prepares actual accepted bytes, rechecks owner before activation, and recovers lost ACK without new transfer', async () => {
  const f = await fixture(), response = await f.service.handle(f.request, f.context)
  expect(response.operation).toBe('sources.prepare'); if (response.operation !== 'sources.prepare') throw new Error('wrong fixture operation')
  expect(await readFile(join(f.namespace, response.receipt.materializationId, 'tree/src/source.txt'))).toEqual(f.bytes)
  expect(f.currentOwner.mock.calls.length).toBeGreaterThan(3)
  const fetched = f.git.mock.calls.length
  expect(await f.service.handle(f.request, f.context)).toEqual(response); expect(f.git.mock.calls.length).toBe(fetched)
})
it('verifies and creates genuine detached private Git, replays repository receipt, and requires positive Main closure', async () => {
  const f = await fixture(), result = await f.service.handle(f.request, f.context)
  if (result.operation !== 'sources.prepare') throw new Error('wrong fixture operation')
  const record: SourceMaterializationRecord = { receipt: result.receipt, operationId: f.owner.identity.operationId, reservationId: randomUUID(), rootPolicyId: f.root.selection.rootPolicyId,
    rootPolicyRevision: '1', sourceBindingHash: f.owner.attempt.placementHash, finalDispatchBindingHash: 'c'.repeat(64), state: 'prepared' }
  f.owner.record = record
  const verified = await f.service.handle({ version: 1, operation: 'sources.verify', record }, f.context); expect(verified.operation).toBe('sources.verify')
  const repository = await f.service.handle({ version: 1, operation: 'sources.private-repository', record }, f.context)
  expect(repository.operation).toBe('sources.private-repository')
  if (repository.operation !== 'sources.private-repository') throw new Error('wrong fixture operation')
  expect(repository.repository.generatedCommit).toMatch(/^[a-f0-9]{40}$/)
  expect(await f.service.handle({ version: 1, operation: 'sources.private-repository', record }, f.context)).toEqual(repository)
  await expect(f.service.handle({ version: 1, operation: 'sources.release', record }, f.context)).rejects.toThrow('positively confirmed')
  f.owner.physicalClosureConfirmed = true
  const released = await f.service.handle({ version: 1, operation: 'sources.release', record }, f.context)
  expect(released.operation).toBe('sources.release')
  if (released.operation !== 'sources.release') throw new Error('wrong fixture operation')
  expect(released.retainedBytes).toBeGreaterThan(0)
  expect(released.retainedBytes).toBeLessThan(1024 * 1024)
  expect(await f.service.handle({ version: 1, operation: 'sources.release', record }, f.context)).toEqual(released)
})
it('reports bounded repository deadline and incomplete-owner codes without publishing or rebuilding', async () => {
  const f = await fixture(), prepared = await f.service.handle(f.request, f.context)
  if (prepared.operation !== 'sources.prepare') throw new Error('wrong fixture operation')
  const record: SourceMaterializationRecord = { receipt: prepared.receipt, operationId: f.owner.identity.operationId, reservationId: randomUUID(), rootPolicyId: f.root.selection.rootPolicyId,
    rootPolicyRevision: '1', sourceBindingHash: f.owner.attempt.placementHash, finalDispatchBindingHash: null, state: 'prepared' }
  f.owner.record = record
  const request = { version: 1 as const, operation: 'sources.private-repository' as const, record }
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(AbortSignal.abort(new DOMException('private /source/path', 'TimeoutError')))
  try { await expect(f.service.handle(request, f.context)).rejects.toMatchObject({ code: 'source-repository-timeout', message: 'Private source preparation timed out.' }) }
  finally { timeout.mockRestore() }
  await mkdir(join(f.namespace, record.receipt.materializationId, 'repository'), { mode: 0o700 })
  await expect(f.service.handle(request, f.context)).rejects.toMatchObject({ code: 'source-repository-uncertain' })
  await expect(readFile(join(f.namespace, record.receipt.materializationId, 'repository-receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('denies stale auth/expired ownership before local config or source package IO', async () => {
  const f = await fixture(); f.owner.identity.expiresAt = new Date(Date.now() - 1).toISOString()
  await expect(f.service.handle(f.request, f.context)).rejects.toThrow('current exact')
  expect(f.readRoots).not.toHaveBeenCalled(); expect(f.git).not.toHaveBeenCalled()
})
it('rejects corruption before activating a ready tree and rejects root replacement', async () => {
  // GitHub serving other bytes than the approved snapshot is refused before any tree exists.
  const f = await fixture()
  await writeFile(join(f.origin, 'src/source.txt'), 'export const substituted = true\n'); f.run('commit', '-qam', 'substituted')
  if (f.request.operation !== 'sources.prepare') throw new Error('wrong fixture operation')
  await expect(f.service.handle({ ...f.request, github: { ...f.request.github, commit: f.run('rev-parse', 'HEAD') } }, f.context))
    .rejects.toMatchObject({ code: 'SOURCE_PIN_CONFLICT' })
  const other = await fixture(); await rename(other.namespace, `${other.namespace}-original`); await mkdir(other.namespace, { mode: 0o700 })
  await expect(other.service.handle(other.request, other.context)).rejects.toThrow('changed')
})
it('rejects another actual operation/owner/root and caller binary/source-path shortcuts', async () => {
  const f = await fixture()
  if (f.request.operation !== 'sources.prepare') throw new Error('wrong fixture operation')
  await expect(f.service.handle({ ...f.request, identity: { ...f.request.identity, operationId: randomUUID() } }, f.context)).rejects.toThrow('original source')
  await expect(f.service.handle({ ...f.request, path: '/home/other' }, f.context)).rejects.toThrow()
  await expect(f.service.handle(f.request, { ...f.context, bytes: Buffer.from('shortcut') })).rejects.toThrow('inline binary')
  expect(f.git).not.toHaveBeenCalled()
})

it('attests a real opened child separately from the tree and rejects traversal and symlink replacement', async () => {
  const f = await fixture(), prepared = await f.service.handle(f.request, f.context)
  if (prepared.operation !== 'sources.prepare') throw new Error('wrong fixture operation')
  const record: SourceMaterializationRecord = { receipt: prepared.receipt, operationId: f.owner.identity.operationId, reservationId: randomUUID(), rootPolicyId: f.root.selection.rootPolicyId,
    rootPolicyRevision: '1', sourceBindingHash: f.owner.attempt.placementHash, finalDispatchBindingHash: null, state: 'prepared' }
  f.owner.record = record
  const response = await f.service.handle({ version: 1, operation: 'sources.verify', record, relativeCwd: 'src' }, f.context)
  if (response.operation !== 'sources.verify') throw new Error('wrong fixture operation')
  expect(response.canonicalCwd).toBe(join(response.workTree, 'src'))
  expect(response.filesystem.inode).not.toBe(record.receipt.localTreeIdentity.inode)
  expect(response.cwdAttestation.filesystem).toEqual(response.filesystem)
  expect(response.cwdAttestation.attestationDigest).toBe(sourceCwdAttestationDigest(response.cwdAttestation))
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record, relativeCwd: '../src' }, f.context)).rejects.toThrow()
  await rename(join(response.workTree, 'src'), join(response.workTree, 'old-src'))
  await symlink('old-src', join(response.workTree, 'src'))
  await expect(f.service.handle({ version: 1, operation: 'sources.verify', record, relativeCwd: 'src' }, f.context)).rejects.toThrow()
})
