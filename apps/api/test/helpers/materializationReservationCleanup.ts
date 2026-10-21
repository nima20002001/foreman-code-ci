import { sourceStorageCapacityFixture } from './sourceStorageCapacityFixture.js'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import { PrivateSourceMaterializer } from '../../src/modules/sources/materialization.js'
import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { expect, vi } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { SourceReservationReclamationResponseSchema, type SourceReservationReclamation,
  type SourceStorageCapacity } from '@foreman-code/contracts/source-operations'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { buildApp } from '../../src/app.js'
import type { OperatorServices } from '../../src/mcp/operator/types.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { DomainError } from '../../src/modules/errors.js'
import { PostgresSourceReservations } from '../../src/modules/sources/reservations.js'
import { MaterializationReservationCleanup } from '../../src/modules/sources/materializationReservationCleanup.js'
import { SourceOperationWorkerService } from '../../src/modules/sources/operationWorker.js'
import { sourceBindingHash } from '../../src/modules/sources/bindingHash.js'
import { createSourceManifest, sourceSha256 } from '../../src/modules/sources/manifest.js'
import { identity, openPrivateRoot } from '../../src/modules/sources/privateFilesystem.js'
import { qualifyApprovedRootAllowlist } from '../../src/modules/sources/rootAttestation.js'
import { buildQueueFixture } from './buildComputerFixture.js'
import { agent3Database } from './wave25Agent3.js'

export async function setupMaterializationReservationCleanup(storageCapacity: Partial<SourceStorageCapacity> = {}) {
  const database = await agent3Database()
  const pool = database.pool
  const access = new PostgresAccessService(pool)
  const writer = await access.issue({ name: 'Reservation cleanup fixture', audience: 'operator',
    expiresAt: new Date(Date.now() + 3600_000), grants: [{ actions: [...ManagementActionSchema.options], scope: {} }] })
  const f = await buildQueueFixture(pool, writer.principal)
  const computer = f.computers[0]!
  const runtime = join(database.directory, 'runtime')
  const project = join(database.directory, 'project')
  const namespace = join(runtime, 'source-materializations', computer.candidate.profile.root.selection.rootPolicyId)
  await mkdir(namespace, { recursive: true, mode: 0o700 })
  await mkdir(project, { mode: 0o700 })
  const directory = await openPrivateRoot(namespace)
  const filesystem = await identity(directory)
  await directory.close()
  const bytes = Buffer.from('original source\n')
  const original = computer.candidate.profile.root
  const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(),
    approvedSourceId: randomUUID(), capturePolicy: 'git-tree-v1',
    git: { commit: '2'.repeat(40), tree: '3'.repeat(40), objectFormat: 'sha1' }, executablePolicy: 'strip', deletions: [],
    entries: [{ path: 'source.txt', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }] })
  const source = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
    manifestDigest: manifest.manifestDigest }
  const root = SourceRootRecordSchema.parse({ ...original, source, attestationId: randomUUID(),
    ownerPrincipalId: writer.principal.id, authorizedByPrincipalId: writer.principal.id,
    binding: { ...original.binding, rootId: randomUUID(), snapshotId: manifest.snapshotId,
      filesystem, canonicalPath: namespace, manifestDigest: manifest.manifestDigest } })
  computer.candidate.spec.source = { ...computer.candidate.spec.source, ...source }
  computer.candidate.spec.target.destination.attestationId = root.attestationId
  computer.candidate.spec.target.destination.canonicalProjectRoot = namespace
  computer.auto.source = computer.candidate.spec.source
  computer.candidate.profile.root = root
  const scopeId = `${root.binding.mainId}:${root.binding.deviceId}:${root.binding.workerInstallationId}:${filesystem.device}:${filesystem.mountId}`
  computer.candidate.sourceReservation.scopeId = scopeId
  await pool.query(`insert into source_approvals
    (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
    values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`,
  [manifest.approvedSourceId, manifest.snapshotId, f.workspaceId, writer.principal.id, randomUUID(), 'f'.repeat(64)])
  await pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
    values($1,$2,$3,$4,$5::jsonb)`,
    [manifest.snapshotId, manifest.approvedSourceId, f.workspaceId, manifest.manifestDigest,
      JSON.stringify({ version: 1, workspaceId: f.workspaceId,
      ownerPrincipalId: writer.principal.id, approvedByPrincipalId: writer.principal.id, locationRevision: 1,
      mainId: root.binding.mainId, originIdentityHash: `sha256:${'f'.repeat(64)}`, manifest,
      approvedAt: new Date().toISOString(), availability: 'retained' })])
  await pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
    values($1,$2,$3,1)`, [root.binding.rootId, f.workspaceId, randomUUID()])
  await pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
    values($1,1,$2,$3,$4::jsonb)`, [root.binding.rootId, f.workspaceId, manifest.snapshotId, JSON.stringify(root)])
  const allowlist = await qualifyApprovedRootAllowlist({ schemaVersion: 1, hostRef: root.selection.hostRef,
    applicationInstallationId: root.binding.workerInstallationId!, configurationRevision: '1',
    bases: [{ baseId: randomUUID(), canonicalPath: project, accessModes: ['read-only', 'read-write'] }], managedRuntimeRoot: runtime })
  const binding: DeviceSessionBinding = { ...computer.registration, bootId: randomUUID(),
    connectionEpoch: randomUUID(), connectionGeneration: 1 }
  const unused = async (): Promise<never> => { throw new Error('No native execution or byte transfer in this fixture') }
  let reachable = true
  let nativeClosed = true
  const worker = new SourceOperationWorkerService({ mainNow: () => Date.now(), authenticate: async () => {}, approvedRoots: async () => allowlist,
    currentOwner: unused,
    currentReclamation: (reservationId, reclamationId) => withTransaction(pool,
      sql => cleanup.authorize(sql, reservationId, reclamationId)),
    reclamationNativeClosed: async () => nativeClosed })
  const reclaim = vi.fn(async (grant: SourceReservationReclamation) => {
    if (!reachable) throw new DomainError('SOURCE_REMOTE_UNAVAILABLE', 'Worker is offline.', 409)
    const response = SourceReservationReclamationResponseSchema.parse(await worker.handle({ version: 1,
      operation: 'sources.reclaim-reservation', reservationId: grant.reservationId, reclamationId: grant.reclamationId },
    { binding, signal: AbortSignal.timeout(60_000) }))
    expect(response.operationId).toBe(grant.operationId)
    return { closures: response.closures, ...(response.retained ? { retained: response.retained } : {}) }
  })
  const cleanup = new MaterializationReservationCleanup(pool, reclaim)
  const reservations = new PostgresSourceReservations(async () => sourceStorageCapacityFixture({
    totalBytes: 256 * 2 ** 30, availableBytes: 256 * 2 ** 30, ...storageCapacity,
  }))
  const materializer = new PrivateSourceMaterializer({ read: async () => bytes }, async () => {})
  function attempt(operationId: string) {
    const value = { executionId: randomUUID(), attemptId: randomUUID(), placementHash: '',
      keyRevision: 1, authorizationRevision: 1 }
    value.placementHash = sourceBindingHash(root, value, operationId)
    return value
  }
  async function orphan(state: 'owned' | 'preparing', options?: { sharedWritableTree?: true }) {
    const operationId = randomUUID()
    const ownerAttempt = attempt(operationId)
    const receipt = await materializer.prepare({ binding: root.binding, manifest, attempt: ownerAttempt, ...options })
    return withTransaction(pool, async sql => {
      const reservation = await reservations.reserve(sql, { scopeId, ownerKind: 'materialization',
        ownerId: operationId, reservedBytes: computer.candidate.sourceReservation.reservedBytes,
        preparation: { identity: { operationId, ownerPrincipalId: writer.principal.id,
          expiresAt: writer.principal.expiresAt }, root, source: root.source, attempt: ownerAttempt,
          record: null, physicalClosureConfirmed: false } })
      if (state === 'owned') await reservations.retain(sql, reservation, 'owned')
      return { reservation, receipt, attempt: ownerAttempt }
    })
  }
  let app: ReturnType<typeof buildApp> | undefined
  let address: string | undefined
  const clients: Client[] = []
  async function connect(token: string) {
    if (!app) {
      app = buildApp({ logger: false,
        readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
        operator: { access, services: { jobs: f.jobs, commands: f.commands } as unknown as OperatorServices } })
      address = await app.listen({ host: '127.0.0.1', port: 0 })
    }
    const client = new Client({ name: 'reservation-cleanup', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address!),
      { authProvider: { token: async () => token } }))
    return client
  }
  return { ...f, pool, root, scopeId, namespace, manifest, attempt, cleanup, reclaim, orphan, materializer,
    writer, access, runtime, unused, connect, offline: () => { reachable = false }, onlineWorker: () => { reachable = true },
    nativeActive: () => { nativeClosed = false }, nativeStopped: () => { nativeClosed = true },
    async close() {
      await f.jobs.closeQueue()
      await Promise.all(clients.map(client => client.close()))
      await app?.close()
      await database.close()
    } }
}

