import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'
import {
  beginTransaction, commitTransaction, rollbackTransaction, withTransaction,
} from '../src/infrastructure/transaction.js'
import { PostgresCommandReceiptRetention } from '../src/modules/commands/receiptRetention.js'
import { sourceStorageLimits } from '../src/modules/sources/storageCapacity.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, expect, it, vi } from 'vitest'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { JobDefinitionSchema, JobExecutionSchema, type JobExecution } from '@foreman-code/contracts/jobs'
import { JobVerificationProfileSchema } from '@foreman-code/contracts/job-verification-runtime'
import { ApprovedSourceSchema, SourceApproveResultSchema, SourceListResultSchema,
  SourceRootRecordSchema, SourceRootListResultSchema, type ApprovedSource,
  type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { JobRepository } from '../src/modules/jobs/repository.js'
import { qualifiedGit } from '../src/modules/sources/capture.js'
import type { RegisteredSourceRootPort } from '../src/modules/sources/admissionPorts.js'
import { type SourceReservation } from '../src/modules/sources/reservations.js'
import { PostgresSourceService, type SourceExecutionHostPort } from '../src/modules/sources/service.js'
import { sourceBindingHash } from '../src/modules/sources/bindingHash.js'
import { releaseUnusedSourceSnapshots, SOURCE_RETENTION_SECONDS } from '../src/modules/sources/snapshotRetention.js'
import { reconcileFailedCaptures } from '../src/modules/sources/failedCaptureCleanup.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { WorkspaceManagementService } from '../src/modules/workspaces/management.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { jobExecution, jobSpec } from './helpers/jobFixture.js'
import { verificationCapacityFixture } from './helpers/verificationCapacityFixture.js'
import { ownedTestDatabaseUrl } from './helpers/testResources.js'
import { createTestPool } from './helpers/testPool.mjs'
import { rejectableDeferred } from './helpers/deferred.js'

let fixture: Awaited<ReturnType<typeof setup>> | undefined
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await fixture?.close()
  fixture = undefined
})

async function setup() {
  const database = await migratedDatabase()
  const pool = database.pool
  const project = join(database.directory, 'project')
  const canonical = join(database.directory, 'snapshots')
  const runtime = join(database.directory, 'runtime')
  for (const path of [project, canonical, runtime]) await mkdir(path, { mode: 0o700 })
  const commands = new PostgresCommandCoordinator(pool)
  const access = new PostgresAccessService(pool)
  const owner = await access.issue({ name: 'Snapshot retention fixture', audience: 'operator',
    grants: [{ actions: [...ManagementActionSchema.options], scope: {} }],
    expiresAt: new Date(Date.now() + 3600_000) })
  const locations = new WorkspaceLocationService(pool, commands, runtime, 'runner-local')
  const workspaces = new WorkspaceManagementService(pool, commands, locations)
  const created = await workspaces.create(owner.principal, 'http', { commandId: randomUUID(), name: 'Retention' })
  const workspaceId = created.value.workspace.id
  const located = await locations.set(owner.principal, 'http', { workspaceId, commandId: randomUUID(),
    expectedLocationRevision: created.value.locationRevision, runnerId: locations.runnerId, rootPath: project })
  const mainId = (await pool.query<{ id: string }>(
    'select id from application_installation where singleton=true')).rows[0]!.id
  await qualifiedGit(project, ['init', '--template='])
  await writeFile(join(project, 'source.ts'), 'export const value = 1\n')
  await qualifiedGit(project, ['add', '.'])
  await qualifiedGit(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'Fixture source'])
  const commit = (await qualifiedGit(project, ['rev-parse', 'HEAD'])).toString().trim()
  const notInvoked = async (): Promise<never> => { throw new Error('No native execution in this metadata fixture.') }
  const store = new PrivateSourceSnapshotStore(canonical)
  vi.spyOn(store, 'storageCapacity').mockImplementation(async () =>
    sourceStorageCapacityFixture({ filesystem: await store.storageIdentity() }))
  const executions: SourceExecutionHostPort = {
    storageCapacity: notInvoked, authorize: notInvoked, prepare: notInvoked, verify: notInvoked,
    verifyWorkingDirectory: notInvoked, releaseClaim: notInvoked, authorizeFinal: notInvoked,
  }
  const sources = new PostgresSourceService(pool, commands, locations, store, mainId,
    { authorize: notInvoked, attest: notInvoked, fence: notInvoked } satisfies RegisteredSourceRootPort,
    executions, { confirmedClosed: notInvoked })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access, services: { sources, commands, workspaces, locations } as unknown as OperatorServices } })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })
  const clients: Client[] = []
  async function connect(token: string) {
    const client = new Client({ name: 'snapshot-retention', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { authProvider: { token: async () => token } }))
    return client
  }
  const client = await connect(owner.token)
  const approval = { workspaceId, commandId: randomUUID(), commit,
    executablePolicy: 'strip', expectedLocationRevision: located.value.locationRevision }
  async function approve(ageSeconds = 0) {
    const input = { ...approval, commandId: randomUUID() }
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() - ageSeconds * 1000)
    try {
      const response = await client.callTool({ name: 'source_approve', arguments: input })
      expect(response.isError, JSON.stringify(response)).not.toBe(true)
      return { input, source: SourceApproveResultSchema.parse(decodeMcpToolResult(response)).value }
    } finally { vi.useRealTimers() }
  }
  async function failedCapture() {
    const input = { ...approval, commandId: randomUUID() }
    const write = store.write.bind(store)
    const interrupted = vi.spyOn(store, 'write').mockImplementationOnce(async (...args) => {
      await write(...args)
      throw new Error('Capture interrupted')
    })
    try {
      const response = await client.callTool({ name: 'source_approve', arguments: input })
      expect(response.isError).toBe(true)
    } finally { interrupted.mockRestore() }
    const capture = (await pool.query<{ snapshot_id: string; state: string }>(
      'select snapshot_id,state from source_approvals where command_id=$1', [input.commandId])).rows[0]!
    expect(capture.state).toBe('failed')
    await pool.query(`update source_approvals set created_at=clock_timestamp()-make_interval(secs=>$2)
      where snapshot_id=$1`, [capture.snapshot_id, SOURCE_RETENTION_SECONDS * 2])
    return { snapshotId: capture.snapshot_id, input }
  }
  function sourcePin(source: ApprovedSource) {
    return { approvedSourceId: source.manifest.approvedSourceId,
      snapshotId: source.manifest.snapshotId, manifestDigest: source.manifest.manifestDigest }
  }
  function pin(source: ApprovedSource) {
    return { workspaceId, ...sourcePin(source) }
  }
  async function captureReservation(snapshotId: string) {
    return (await pool.query<{ state: string; reserved_bytes: string; record: SourceReservation }>(
      "select state,reserved_bytes,record from source_storage_reservations where owner_kind='capture' and owner_id=$1",
      [snapshotId])).rows[0]!
  }
  async function reservation(source: ApprovedSource) {
    return captureReservation(source.manifest.snapshotId)
  }
  async function read(source: ApprovedSource) {
    const response = await client.callTool({ name: 'source_get', arguments: pin(source) })
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    return ApprovedSourceSchema.parse(decodeMcpToolResult(response))
  }
  async function seedJob(source: ApprovedSource, retentionSeconds = SOURCE_RETENTION_SECONDS) {
    const now = source.approvedAt
    const spec = jobSpec()
    spec.source = { ...sourcePin(source), commit }
    spec.policy.retentionSeconds = retentionSeconds
    const definition = JobDefinitionSchema.parse({ schemaVersion: 1, id: randomUUID(), versionId: randomUUID(),
      workspaceId, name: 'Snapshot consumer', revision: 1, spec, createdAt: now, updatedAt: now })
    await pool.query(`insert into job_definitions(id,workspace_id,revision,version_id,record,updated_by)
      values($1,$2,1,$3,$4::jsonb,$5)`,
    [definition.id, workspaceId, definition.versionId, JSON.stringify(definition), owner.principal.id])
    await pool.query(`insert into job_definition_versions(id,definition_id,workspace_id,revision,record)
      values($1,$2,$3,1,$4::jsonb)`,
    [definition.versionId, definition.id, workspaceId, JSON.stringify(definition)])
    const base = jobExecution()
    const execution = JobExecutionSchema.parse({ ...base, id: randomUUID(), workspaceId,
      operationId: randomUUID(), attemptId: randomUUID(), createdAt: now, updatedAt: now,
      acceptedSpec: { ...base.acceptedSpec, ...spec,
        source: { ...spec.source, materializationId: randomUUID(), materializationDigest: 'a'.repeat(64) },
        definitionId: definition.id, definitionVersionId: definition.versionId } })
    await pool.query(`insert into job_executions
      (id,workspace_id,definition_version_id,operation_id,attempt_id,record,accepted_spec,accepted_by)
      values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)`,
    [execution.id, workspaceId, definition.versionId, execution.operationId, execution.attemptId,
      JSON.stringify(execution), JSON.stringify(execution.acceptedSpec), owner.principal.id])
    return execution
  }
  async function finishJob(execution: JobExecution, finishedAt = execution.createdAt) {
    await new JobRepository().putExecution(pool, { ...execution, publication: 'complete',
      process: { phase: 'terminal', outcome: 'succeeded', exitCode: 0, signal: null, processStopped: true },
      startedAt: execution.createdAt, finishedAt, updatedAt: finishedAt })
  }
  async function executionRoot(source: ApprovedSource) {
    const base = verificationCapacityFixture('main').root
    const root = SourceRootRecordSchema.parse({ ...base, source: sourcePin(source),
      selection: { ...base.selection, hostRef: { kind: 'main', mainId } },
      binding: { ...base.binding, rootId: randomUUID(), workspaceId, mainId, canonicalPath: project,
        filesystem: await store.storageIdentity(), snapshotId: source.manifest.snapshotId,
        manifestDigest: source.manifest.manifestDigest },
      ownerPrincipalId: owner.principal.id, authorizedByPrincipalId: owner.principal.id,
      boundAt: source.approvedAt })
    await pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
      values($1,$2,$3,1)`, [root.binding.rootId, workspaceId, randomUUID()])
    await pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
      values($1,1,$2,$3,$4::jsonb)`, [root.binding.rootId, workspaceId, source.manifest.snapshotId, JSON.stringify(root)])
    vi.spyOn(executions, 'authorize').mockResolvedValue(undefined)
    vi.spyOn(executions, 'storageCapacity').mockImplementation(async () => sourceStorageCapacityFixture({
      filesystem: root.binding.filesystem, cpuCount: 16, availableMemoryBytes: 32 * 2 ** 30,
    }))
    vi.spyOn(executions, 'prepare').mockImplementation(async (manifest, selected, attempt) => ({
      version: 1, materializationId: randomUUID(), binding: selected.binding, ...attempt,
      verifiedManifestDigest: manifest.manifestDigest, verifiedEntries: manifest.totalEntries,
      verifiedBytes: manifest.totalBytes, verifiedAt: new Date().toISOString(),
      localTreeIdentity: selected.binding.filesystem,
    }))
    return root
  }
  function preparation(root: SourceRootRecord) {
    const operationId = randomUUID()
    const attempt = { executionId: randomUUID(), attemptId: randomUUID(), placementHash: '',
      keyRevision: null, authorizationRevision: null }
    attempt.placementHash = sourceBindingHash(root, attempt, operationId)
    return { principal: owner.principal, workspaceId, rootId: root.binding.rootId,
      bindingRevision: root.binding.bindingRevision, source: root.source, operationId, attempt }
  }
  return { pool, store, sources, executions, client, access, owner, workspaceId, canonical, mainId, app, project,
    approve, failedCapture, approval, sourcePin, pin, reservation, captureReservation, read, seedJob, finishJob, connect,
    executionRoot, preparation,
    async close() {
      await Promise.allSettled(clients.map(value => value.close()))
      await app.close()
      await database.close()
    } }
}

it('reuses prepared migration history with an independent installation and authenticated source storage', async () => {
  const prepared = createTestPool({ connectionString: ownedTestDatabaseUrl(), max: 1 })
  let migrationHistory: unknown[]
  let installationId: string
  try {
    migrationHistory = (await prepared.query(
      'select version,applied_at from application_migrations order by version')).rows
    installationId = (await prepared.query<{ id: string }>(
      'select id from application_installation where singleton=true')).rows[0]!.id
  } finally {
    await prepared.end()
  }
  fixture = await setup()
  const f = fixture
  expect(migrationHistory.length).toBeGreaterThan(0)
  expect((await f.pool.query(
    'select version,applied_at from application_migrations order by version')).rows).toEqual(migrationHistory)
  expect(f.mainId).not.toBe(installationId)
  const source = (await f.approve()).source
  expect((await f.read(source)).manifest).toEqual(source.manifest)
  expect((await f.reservation(source)).state).toBe('retained')
}, 60_000)

it.each(['approved', 'failed'] as const)(
  'reserves capacity within a short database timeout while %s capture removal is paused', async kind => {
    fixture = await setup()
    const f = fixture
    const snapshotId = kind === 'approved'
      ? (await f.approve(SOURCE_RETENTION_SECONDS * 3)).source.manifest.snapshotId
      : (await f.failedCapture()).snapshotId
    const held = await f.captureReservation(snapshotId)
    const entered = rejectableDeferred()
    const resume = rejectableDeferred()
    const remove = f.store.remove.bind(f.store)
    vi.spyOn(f.store, 'remove').mockImplementation(async id => {
      if (id === snapshotId) {
        entered.resolve()
        await resume.promise
      }
      await remove(id)
    })
    const cleanup = kind === 'approved' ? f.sources.releaseUnusedSnapshots() : f.sources.reconcileCaptures()
    const started = cleanup.then(() => entered.reject(new Error('Cleanup did not reach removal')), entered.reject)
    try {
      await entered.promise
      const capacity = sourceStorageCapacityFixture({ filesystem: await f.store.storageIdentity() })
      const reservation = await withTransaction(f.pool, async sql => {
        await sql.query("set local statement_timeout='250ms'")
        const heldRow = await sql.query<{ state: string }>(`select state from source_storage_reservations
          where reservation_id=$1 for update`, [held.record.reservationId])
        expect(heldRow.rows[0]?.state).toBe('retained')
        return f.sources.reservations.reserve(sql, { scopeId: held.record.scopeId,
          ownerKind: 'capture', ownerId: randomUUID(), reservedBytes: 1 }, { capacity })
      })
      expect((await f.captureReservation(reservation.ownerId)).state).toBe('preparing')
      const approved = await f.approve()
      expect((await f.read(approved.source)).manifest).toEqual(approved.source.manifest)
    } finally {
      resume.resolve()
      await Promise.allSettled([cleanup, started])
    }
    await cleanup
    expect((await f.captureReservation(snapshotId)).state).toBe('reclaimed')
  }, 60_000)

it.each(['approved', 'failed'] as const)(
  'reconciles %s capture removal interrupted before reservation reclaim after restart', async kind => {
    fixture = await setup()
    const f = fixture
    const approved = kind === 'approved' ? await f.approve(SOURCE_RETENTION_SECONDS * 3) : undefined
    const failed = kind === 'failed' ? await f.failedCapture() : undefined
    const snapshotId = approved?.source.manifest.snapshotId ?? failed!.snapshotId
    const held = await f.captureReservation(snapshotId)
    const action = kind === 'approved' ? 'source.snapshot.release' : 'source.capture.release'
    const audit = async () => (await f.pool.query<{ count: string }>(`select count(*) from management_audit
      where action=$1 and details->>'snapshotId'=$2`, [action, snapshotId])).rows[0]!.count
    let chargedBytes = ''
    const remove = f.store.remove.bind(f.store)
    const interrupted = vi.spyOn(f.store, 'remove').mockImplementationOnce(async id => {
      chargedBytes = (await f.captureReservation(id)).reserved_bytes
      await remove(id)
      throw new Error('Interrupted after physical removal')
    })
    const cleanup = () => kind === 'approved' ? f.sources.releaseUnusedSnapshots() : f.sources.reconcileCaptures()
    await expect(cleanup()).rejects.toThrow('Interrupted after physical removal')
    interrupted.mockRestore()
    await expect(stat(join(f.canonical, snapshotId))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(Number(chargedBytes)).toBeGreaterThan(0)
    expect(await f.captureReservation(snapshotId)).toMatchObject({ state: 'retained', reserved_bytes: chargedBytes })
    expect(await audit()).toBe('0')
    const restarted = new PrivateSourceSnapshotStore(f.canonical)
    const maintain = () => kind === 'approved'
      ? releaseUnusedSourceSnapshots(f.pool, restarted, held.record.scopeId)
      : reconcileFailedCaptures(f.pool, restarted, error => { throw error }, held.record.scopeId)
    await maintain()
    await maintain()
    expect((await f.captureReservation(snapshotId)).state).toBe('reclaimed')
    expect(await restarted.retainedCaptureBytes(snapshotId)).toBe(0)
    expect(await audit()).toBe('1')
    const retry = await f.client.callTool({ name: 'source_approve', arguments: approved?.input ?? failed!.input })
    expect(retry.isError).toBe(true)
    expect(JSON.stringify(retry.content)).toContain(kind === 'approved' ? 'SOURCE_UNAVAILABLE' : 'SOURCE_CAPTURE_FAILED')
  }, 60_000)

it('prepares sixteen executions concurrently without releasing unused snapshots', async () => {
  fixture = await setup()
  const f = fixture
  const unused = (await f.approve(SOURCE_RETENTION_SECONDS * 3)).source
  const source = (await f.approve()).source
  const root = await f.executionRoot(source)
  const entered = rejectableDeferred()
  const resume = rejectableDeferred()
  const prepare = vi.mocked(f.executions.prepare).getMockImplementation()!
  let preparing = 0
  vi.mocked(f.executions.prepare).mockImplementation(async (...args) => {
    preparing++
    if (preparing === 16) entered.resolve()
    await resume.promise
    return prepare(...args)
  })
  const remove = vi.spyOn(f.store, 'remove').mockRejectedValue(new Error('Unexpected preparation cleanup'))
  const preparations = Array.from({ length: 16 }, () => f.sources.prepareExecution(f.preparation(root)))
  const completed = Promise.all(preparations)
  try {
    await Promise.race([entered.promise, completed])
    expect(preparing).toBe(16)
  } finally {
    resume.resolve()
    await Promise.allSettled(preparations)
  }
  const records = await completed
  expect(records).toHaveLength(16)
  expect(records.every(record => record.state === 'prepared')).toBe(true)
  expect(remove).not.toHaveBeenCalled()
  expect((await f.read(unused)).availability).toBe('retained')
  const persisted = await f.pool.query<{ state: string }>(
    'select state from source_execution_materializations where materialization_id=any($1::uuid[])',
    [records.map(record => record.receipt.materializationId)])
  expect(persisted.rows).toHaveLength(16)
  expect(persisted.rows.every(row => row.state === 'prepared')).toBe(true)
}, 60_000)

it('retries preparation under capacity pressure while keeping current roots and active Jobs', async () => {
  fixture = await setup()
  const f = fixture
  const unused = (await f.approve()).source
  const active = (await f.approve()).source
  await f.seedJob(active)
  const source = (await f.approve()).source
  const root = await f.executionRoot(source)
  const held = await f.reservation(unused)
  await f.sources.reservations.retain(f.pool, held.record, 'retained',
    sourceStorageLimits(sourceStorageCapacityFixture()).bytes)

  const record = await f.sources.prepareExecution(f.preparation(root))

  expect(record.state).toBe('prepared')
  expect((await f.reservation(unused)).state).toBe('reclaimed')
  expect(await f.store.retainedCaptureBytes(unused.manifest.snapshotId)).toBe(0)
  for (const protectedSource of [active, source]) {
    expect((await f.read(protectedSource)).availability).toBe('retained')
    expect((await f.reservation(protectedSource)).state).toBe('retained')
  }
  const unavailable = await f.client.callTool({ name: 'source_get', arguments: f.pin(unused) })
  expect(unavailable.isError).toBe(true)
  expect(JSON.stringify(unavailable.content)).toContain('SOURCE_UNAVAILABLE')
}, 60_000)

it('waits for an in-flight pressure release and refreshes capacity before retrying preparation', async () => {
  fixture = await setup()
  const f = fixture
  const unused = (await f.approve()).source
  const source = (await f.approve()).source
  const root = await f.executionRoot(source)
  const held = await f.reservation(unused)
  await f.sources.reservations.retain(f.pool, held.record, 'retained',
    sourceStorageLimits(sourceStorageCapacityFixture()).bytes)
  const entered = rejectableDeferred()
  const resume = rejectableDeferred()
  const remove = f.store.remove.bind(f.store)
  vi.spyOn(f.store, 'remove').mockImplementation(async snapshotId => {
    if (snapshotId === unused.manifest.snapshotId) {
      entered.resolve()
      await resume.promise
    }
    await remove(snapshotId)
  })
  const maintenance = f.sources.releaseUnusedSnapshots(undefined, true)
  const started = maintenance.then(() => entered.reject(new Error('Release did not reach removal')), entered.reject)
  let preparation: ReturnType<PostgresSourceService['prepareExecution']> | undefined
  let joined: Promise<void> | undefined
  try {
    await entered.promise
    const waiting = rejectableDeferred()
    const release = f.sources.releaseUnusedSnapshots.bind(f.sources)
    vi.spyOn(f.sources, 'releaseUnusedSnapshots').mockImplementation(async (...args) => {
      waiting.resolve()
      return release(...args)
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = Date.now()
    preparation = f.sources.prepareExecution(f.preparation(root))
    joined = preparation.then(() => waiting.reject(new Error('Preparation did not wait for release')), waiting.reject)
    await waiting.promise
    expect(f.executions.storageCapacity).toHaveBeenCalledTimes(1)
    expect((await f.reservation(unused)).state).toBe('retained')
    vi.setSystemTime(now + 14_000)
  } finally {
    resume.resolve()
    await Promise.allSettled([maintenance, started, ...(preparation ? [preparation] : []), ...(joined ? [joined] : [])])
  }
  await maintenance
  const record = await preparation!
  expect(record.state).toBe('prepared')
  expect(f.executions.storageCapacity).toHaveBeenCalledTimes(2)
  expect((await f.reservation(unused)).state).toBe('reclaimed')
  expect((await f.read(source)).availability).toBe('retained')
  const persisted = await f.pool.query<{ state: string }>(
    'select state from source_execution_materializations where materialization_id=$1', [record.receipt.materializationId])
  expect(persisted.rows[0]?.state).toBe('prepared')
}, 60_000)

it('scans protected snapshots without waiting for the storage lock', async () => {
  fixture = await setup()
  const f = fixture
  const protectedSources: ApprovedSource[] = []
  for (let index = 0; index < 8; index++) {
    const source = (await f.approve(SOURCE_RETENTION_SECONDS * 3)).source
    await f.seedJob(source)
    protectedSources.push(source)
  }
  const held = await f.reservation(protectedSources[0]!)
  const sql = await f.pool.connect()
  try {
    await beginTransaction(sql)
    await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`source-storage:${held.record.scopeId}`])
    await f.sources.releaseUnusedSnapshots(undefined, true)
    for (const source of protectedSources) {
      expect((await f.read(source)).availability).toBe('retained')
      expect((await f.reservation(source)).state).toBe('retained')
    }
  } finally {
    await rollbackTransaction(sql)
    sql.release()
  }
}, 60_000)

it('coalesces concurrent pressure scans and allows retry after a deletion failure', async () => {
  fixture = await setup()
  const f = fixture
  const source = (await f.approve()).source
  const scopeId = (await f.reservation(source)).record.scopeId
  const entered = rejectableDeferred()
  const resume = rejectableDeferred()
  const failure = new Error('Interrupted shared release')
  const remove = vi.spyOn(f.store, 'remove').mockImplementation(async () => {
    entered.resolve()
    await resume.promise
    throw failure
  })
  const first = releaseUnusedSourceSnapshots(f.pool, f.store, scopeId, undefined, true)
  const started = first.then(() => entered.reject(new Error('Release did not remove its candidate')), entered.reject)
  const report = vi.fn()
  const callers: Promise<void>[] = [first]
  try {
    await entered.promise
    callers.push(...Array.from({ length: 15 }, () =>
      releaseUnusedSourceSnapshots(f.pool, f.store, scopeId, undefined, true)))
    callers.push(releaseUnusedSourceSnapshots(f.pool, f.store, scopeId, report, true))
  } finally {
    resume.resolve()
  }
  const results = await Promise.allSettled(callers)
  await started
  expect(results.slice(0, 16).every(result => result.status === 'rejected' && result.reason === failure)).toBe(true)
  expect(results[16]?.status).toBe('fulfilled')
  expect(report).toHaveBeenCalledExactlyOnceWith(failure)
  expect(remove).toHaveBeenCalledTimes(1)
  expect((await f.reservation(source)).state).toBe('retained')
  remove.mockRestore()

  await f.sources.releaseUnusedSnapshots(undefined, true)

  expect((await f.reservation(source)).state).toBe('reclaimed')
  const audit = await f.pool.query<{ count: string }>(`select count(*) from management_audit
    where action='source.snapshot.release' and details->>'snapshotId'=$1`, [source.manifest.snapshotId])
  expect(audit.rows[0]?.count).toBe('1')
}, 60_000)

it('honors pressure callers that join a periodic release scan', async () => {
  fixture = await setup()
  const f = fixture
  const expired = (await f.approve(SOURCE_RETENTION_SECONDS * 3)).source
  const recent = (await f.approve()).source
  const scopeId = (await f.reservation(expired)).record.scopeId
  const entered = rejectableDeferred()
  const resume = rejectableDeferred()
  const remove = f.store.remove.bind(f.store)
  vi.spyOn(f.store, 'remove').mockImplementation(async snapshotId => {
    if (snapshotId === expired.manifest.snapshotId) {
      entered.resolve()
      await resume.promise
    }
    return remove(snapshotId)
  })
  const maintenance = releaseUnusedSourceSnapshots(f.pool, f.store, scopeId)
  const started = maintenance.then(() => entered.reject(new Error('Maintenance did not reach deletion')), entered.reject)
  let pressure: Promise<void> | undefined
  try {
    await entered.promise
    pressure = releaseUnusedSourceSnapshots(f.pool, f.store, scopeId, undefined, true)
  } finally {
    resume.resolve()
    await Promise.allSettled([maintenance, ...(pressure ? [pressure] : [])])
    await started
  }
  await maintenance
  await pressure
  for (const source of [expired, recent]) {
    expect((await f.reservation(source)).state).toBe('reclaimed')
    expect(await f.store.retainedCaptureBytes(source.manifest.snapshotId)).toBe(0)
  }
}, 60_000)

it('rechecks a candidate that acquires an active consumer after the batch scan', async () => {
  fixture = await setup()
  const f = fixture
  const first = (await f.approve(SOURCE_RETENTION_SECONDS * 3)).source
  const protectedSource = (await f.approve(SOURCE_RETENTION_SECONDS * 3)).source
  const entered = rejectableDeferred()
  const resume = rejectableDeferred()
  const remove = f.store.remove.bind(f.store)
  vi.spyOn(f.store, 'remove').mockImplementation(async snapshotId => {
    if (snapshotId === first.manifest.snapshotId) {
      entered.resolve()
      await resume.promise
    }
    return remove(snapshotId)
  })
  const release = f.sources.releaseUnusedSnapshots()
  const started = release.then(() => entered.reject(new Error('Release did not reach deletion')), entered.reject)
  try {
    await entered.promise
    await f.seedJob(protectedSource)
  } finally {
    resume.resolve()
    await Promise.allSettled([release, started])
  }
  await release
  expect((await f.reservation(first)).state).toBe('reclaimed')
  expect((await f.read(protectedSource)).availability).toBe('retained')
  expect((await f.reservation(protectedSource)).state).toBe('retained')
  expect(await f.store.retainedCaptureBytes(protectedSource.manifest.snapshotId)).toBeGreaterThan(0)
}, 60_000)

it('reclaims older terminal snapshots before capture capacity fails and exposes unavailability through authenticated MCP',
  async () => {
    fixture = await setup()
    const f = fixture
    const approvals = []
    let chargedBytes = 0
    while (chargedBytes <= sourceStorageLimits(sourceStorageCapacityFixture()).bytes) {
      const approved = await f.approve(SOURCE_RETENTION_SECONDS * 3)
      approvals.push(approved)
      await f.finishJob(await f.seedJob(approved.source))
      const reservation = await f.reservation(approved.source)
      // Exercise the conservative full capture charge without writing a GiB of fixture files.
      await f.sources.reservations.retain(f.pool, reservation.record, 'retained')
      chargedBytes += reservation.record.reservedBytes
    }
    expect(approvals.length).toBeGreaterThan(1)
    const first = approvals[0]!
    const listed = await f.client.callTool({ name: 'source_list', arguments: { workspaceId: f.workspaceId, detail: 'full' } })
    expect(listed.isError).not.toBe(true)
    const items = SourceListResultSchema.parse(decodeMcpToolResult(listed)).items
    expect(items.find(item => item.manifest.snapshotId === first.source.manifest.snapshotId)?.availability)
      .toBe('unavailable')
    const get = await f.client.callTool({ name: 'source_get', arguments: f.pin(first.source) })
    expect(get.isError).toBe(true)
    expect(JSON.stringify(get.content)).toContain('SOURCE_UNAVAILABLE')
    const retry = await f.client.callTool({ name: 'source_approve', arguments: first.input })
    expect(retry.isError).toBe(true)
    expect(JSON.stringify(retry.content)).toContain('SOURCE_UNAVAILABLE')
    expect((await f.reservation(first.source)).state).toBe('reclaimed')
    expect(await f.store.retainedCaptureBytes(first.source.manifest.snapshotId)).toBe(0)
    await expect(stat(join(f.canonical, first.source.manifest.snapshotId))).rejects.toMatchObject({ code: 'ENOENT' })
    await f.read(approvals.at(-1)!.source)
    const denied = await f.access.issue({ name: 'Other workspace', audience: 'operator',
      grants: [{ actions: ['sources:read', 'source_roots:bind', 'workspace_locations:read'],
        scope: { workspaceIds: ['other-workspace'] } }], expiresAt: new Date(Date.now() + 120_000) })
    const deniedClient = await f.connect(denied.token)
    for (const name of ['source_get', 'source_list']) {
      const response = await deniedClient.callTool({ name, arguments: name === 'source_get'
        ? f.pin(first.source) : { workspaceId: f.workspaceId } })
      expect(response.isError).toBe(true)
      expect(JSON.stringify(response.content)).toContain('ACCESS_DENIED')
    }
    const deniedApproval = await deniedClient.callTool({ name: 'source_approve',
      arguments: { ...first.input, commandId: randomUUID() } })
    expect(deniedApproval.isError).toBe(true)
    expect(JSON.stringify(deniedApproval.content)).toContain('ACCESS_DENIED')
  }, 120_000)

it('releases recently finished snapshots when a new capture would exceed capacity, never an active Job source', async () => {
  fixture = await setup()
  const f = fixture
  const active = (await f.approve(SOURCE_RETENTION_SECONDS * 3)).source
  await f.seedJob(active)
  const held = await f.reservation(active)
  await f.sources.reservations.retain(f.pool, held.record, 'retained')
  let chargedBytes = held.record.reservedBytes
  const recent = []
  // Every finished Job is inside its retention window; before pressure release the next capture failed.
  while (chargedBytes <= sourceStorageLimits(sourceStorageCapacityFixture()).bytes) {
    const approved = await f.approve(SOURCE_RETENTION_SECONDS * 3)
    recent.push(approved.source)
    await f.finishJob(await f.seedJob(approved.source), new Date().toISOString())
    const reservation = await f.reservation(approved.source)
    await f.sources.reservations.retain(f.pool, reservation.record, 'retained')
    chargedBytes += reservation.record.reservedBytes
  }
  expect(recent.length).toBeGreaterThan(1)
  expect((await f.reservation(recent[0]!)).state).toBe('reclaimed')
  expect((await f.reservation(active)).state).toBe('retained')
  expect((await f.read(active)).availability).toBe('retained')
  expect((await f.read(recent.at(-1)!)).availability).toBe('retained')
}, 120_000)

it('keeps active Jobs, recent terminal use, longer Job retention and a qualified verification profile retained', async () => {
  fixture = await setup()
  const f = fixture
  const old = SOURCE_RETENTION_SECONDS * 3
  const active = (await f.approve(old)).source
  const execution = await f.seedJob(active)
  const recent = (await f.approve(old)).source
  await f.finishJob(await f.seedJob(recent), new Date().toISOString())
  const longer = (await f.approve(old)).source
  await f.finishJob(await f.seedJob(longer, old * 2))
  const pinned = (await f.approve(old)).source
  // Qualified metadata exercises retention; this fixture does not launch or qualify a runtime.
  const base = verificationCapacityFixture('main')
  const hostRef = { kind: 'main', mainId: f.mainId }
  const root = SourceRootRecordSchema.parse({ ...base.root, source: f.sourcePin(pinned),
    selection: { ...base.root.selection, hostRef },
    binding: { ...base.root.binding, snapshotId: pinned.manifest.snapshotId,
      manifestDigest: pinned.manifest.manifestDigest, workspaceId: f.workspaceId, mainId: f.mainId } })
  const profile = JobVerificationProfileSchema.parse({ ...base, workspaceId: f.workspaceId, root,
    sourceCommit: pinned.manifest.git!.commit, measurement: { ...base.measurement!,
      fingerprint: { ...base.measurement!.fingerprint, root, hostRef,
        sourceCommit: pinned.manifest.git!.commit } } })
  await f.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
    values($1,$2,$3,1)`, [root.binding.rootId, f.workspaceId, randomUUID()])
  await f.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
    values($1,1,$2,$3,$4::jsonb)`, [root.binding.rootId, f.workspaceId, pinned.manifest.snapshotId, JSON.stringify(root)])
  await f.pool.query(`insert into job_runtime_profiles(id,workspace_id,revision,root_id,binding_revision,record)
    values($1,$2,1,$3,1,$4::jsonb)`, [profile.id, f.workspaceId, root.binding.rootId, JSON.stringify(profile)])
  await f.sources.releaseUnusedSnapshots()
  for (const source of [active, recent, longer, pinned]) {
    expect((await f.read(source)).availability).toBe('retained')
    expect((await f.reservation(source)).state).toBe('retained')
    expect(await f.store.retainedCaptureBytes(source.manifest.snapshotId)).toBeGreaterThan(0)
  }
  await f.finishJob(execution)
  await f.sources.releaseUnusedSnapshots()
  expect((await f.reservation(active)).state).toBe('reclaimed')
  expect((await f.read(pinned)).availability).toBe('retained')
}, 60_000)

it.each(['age', 'pressure'] as const)(
  'retains current Main and Worker bindings without a workflow while releasing superseded bindings by %s', async mode => {
    fixture = await setup()
    const f = fixture
    const age = mode === 'age' ? SOURCE_RETENTION_SECONDS * 3 : 0
    const superseded = (await f.approve(age)).source
    const current = (await f.approve(age)).source
    const roots: SourceRootRecord[] = []
    let workerRootId = ''
    for (const host of ['main', 'device'] as const) {
      const base = verificationCapacityFixture(host).root
      const rootId = randomUUID()
      if (host === 'device') workerRootId = rootId
      const hostRef = { ...base.selection.hostRef, mainId: f.mainId }
      await f.pool.query(`insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision)
        values($1,$2,$3,$4)`, [rootId, f.workspaceId, randomUUID(), host === 'main' ? 2 : 1])
      for (const [index, source] of [superseded, current].entries()) {
        const root = SourceRootRecordSchema.parse({ ...base, source: f.sourcePin(source),
          selection: { ...base.selection, hostRef },
          binding: { ...base.binding, rootId, bindingRevision: index + 1, mainId: f.mainId,
            workspaceId: f.workspaceId, snapshotId: source.manifest.snapshotId,
            manifestDigest: source.manifest.manifestDigest },
          ownerPrincipalId: f.owner.principal.id, authorizedByPrincipalId: f.owner.principal.id,
          boundAt: source.approvedAt })
        await f.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
          values($1,$2,$3,$4,$5::jsonb)`,
        [rootId, index + 1, f.workspaceId, source.manifest.snapshotId, JSON.stringify(root)])
        if (index === 1) roots.push(root)
      }
    }

    await f.sources.releaseUnusedSnapshots(undefined, mode === 'pressure')

    expect((await f.read(superseded)).availability).toBe('retained')
    expect((await f.reservation(superseded)).state).toBe('retained')
    expect((await f.read(current)).availability).toBe('retained')
    await f.pool.query('update source_root_catalog set current_binding_revision=2 where root_id=$1', [workerRootId])
    await f.sources.releaseUnusedSnapshots(undefined, mode === 'pressure')

    expect((await f.read(current)).manifest).toEqual(current.manifest)
    expect((await f.reservation(current)).state).toBe('retained')
    expect(await f.store.retainedCaptureBytes(current.manifest.snapshotId)).toBeGreaterThan(0)
    expect((await f.reservation(superseded)).state).toBe('reclaimed')
    expect(await f.store.retainedCaptureBytes(superseded.manifest.snapshotId)).toBe(0)
    const listed = await f.client.callTool({ name: 'source_list',
      arguments: { workspaceId: f.workspaceId, detail: 'full' } })
    expect(listed.isError).not.toBe(true)
    expect(SourceListResultSchema.parse(decodeMcpToolResult(listed)).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ manifest: superseded.manifest, availability: 'unavailable' }),
      expect.objectContaining({ manifest: current.manifest, availability: 'retained' }),
    ]))
    const bound = await f.client.callTool({ name: 'source_root_list',
      arguments: { workspaceId: f.workspaceId } })
    expect(bound.isError).not.toBe(true)
    expect(SourceRootListResultSchema.parse(decodeMcpToolResult(bound)).items)
      .toEqual(expect.arrayContaining(roots))
    const denied = await f.access.issue({ name: 'Other workspace reader', audience: 'operator',
      grants: [{ actions: ['sources:read', 'source_roots:read', 'workspace_locations:read'],
        scope: { workspaceIds: ['other-workspace'] } }], expiresAt: new Date(Date.now() + 120_000) })
    const deniedClient = await f.connect(denied.token)
    const deniedRead = await deniedClient.callTool({ name: 'source_root_list',
      arguments: { workspaceId: f.workspaceId } })
    expect(deniedRead.isError).toBe(true)
    expect(JSON.stringify(deniedRead.content)).toContain('ACCESS_DENIED')
  }, 60_000)

it.each(['startup', 'admission'] as const)('reconciles an interrupted partial capture on %s without touching a live writer',
  async mode => {
    fixture = await setup()
    const f = fixture
    const input = { ...f.approval, commandId: randomUUID() }
    const connect = vi.spyOn(f.pool, 'connect')
    const write = f.store.write.bind(f.store)
    const interrupted = vi.spyOn(f.store, 'write').mockImplementationOnce(async (...args) => {
      await write(...args)
      connect.mockImplementation(() => { throw new Error('API interrupted during capture') })
      throw new Error('Capture interrupted')
    })
    try {
      expect((await f.client.callTool({ name: 'source_approve', arguments: input })).isError).toBe(true)
    } finally {
      connect.mockRestore()
      interrupted.mockRestore()
    }
    const approval = (await f.pool.query<{ snapshot_id: string; state: string }>(
      'select snapshot_id,state from source_approvals where command_id=$1', [input.commandId])).rows[0]!
    expect(approval.state).toBe('capturing')
    const snapshotId = approval.snapshot_id
    const state = async () => (await f.pool.query<{ state: string; reserved_bytes: string }>(
      'select state,reserved_bytes from source_storage_reservations where owner_id=$1', [snapshotId])).rows[0]!
    expect((await state()).state).toBe('preparing')
    let entered!: () => void
    let release!: () => void
    const locked = new Promise<void>(resolve => { entered = resolve })
    const resume = new Promise<void>(resolve => { release = resolve })
    const writer = f.store.withCaptureLock(snapshotId, async () => { entered(); await resume })
    await locked
    try {
      await f.sources.reconcileCaptures()
      expect((await state()).state).toBe('preparing')
    } finally {
      release()
      await writer
    }
    if (mode === 'startup') await f.sources.reconcileCaptures()
    const approved = await f.approve()
    expect(await state()).toEqual({ state: 'retained',
      reserved_bytes: String(await f.store.retainedCaptureBytes(snapshotId) + 16 * 1024) })
    expect((await f.read(approved.source)).manifest).toEqual(approved.source.manifest)
    const http = await f.app.inject({ method: 'POST',
      url: `/api/management/workspaces/${f.workspaceId}/sources/approve`,
      headers: { authorization: `Bearer ${f.owner.token}` },
      payload: { ...f.approval, commandId: randomUUID() } })
    expect(http.statusCode).toBe(200)
    const httpSource = SourceApproveResultSchema.parse(http.json()).value
    expect((await f.read(httpSource)).manifest).toEqual(httpSource.manifest)
    const reader = await f.access.issue({ name: 'Capture reader', audience: 'operator',
      grants: [{ actions: ['sources:read'], scope: { workspaceIds: [f.workspaceId] } }],
      expiresAt: new Date(Date.now() + 120_000) })
    const denied = await f.connect(reader.token)
    const denial = await denied.callTool({ name: 'source_approve',
      arguments: { ...f.approval, commandId: randomUUID() } })
    expect(denial.isError).toBe(true)
    expect(JSON.stringify(denial.content)).toContain('ACCESS_DENIED')
    const retry = await f.client.callTool({ name: 'source_approve', arguments: input })
    expect(retry.isError).toBe(true)
    expect(JSON.stringify(retry.content)).toContain('SOURCE_CAPTURE_FAILED')
    await f.pool.query("update source_approvals set created_at=clock_timestamp()-interval '2 hours' where snapshot_id=$1",
      [snapshotId])
    const remove = vi.spyOn(f.store, 'remove').mockRejectedValueOnce(new Error('Removal interrupted'))
    await expect(f.sources.reconcileCaptures()).rejects.toThrow('Removal interrupted')
    expect((await state()).state).toBe('retained')
    expect(await f.store.retainedCaptureBytes(snapshotId)).toBeGreaterThan(0)
    remove.mockRestore()
    await f.sources.reconcileCaptures()
    expect((await state()).state).toBe('reclaimed')
    expect(await f.store.retainedCaptureBytes(snapshotId)).toBe(0)
    expect((await f.read(approved.source)).availability).toBe('retained')
  }, 60_000)

it.each(['measurement', 'deletion'] as const)(
  'allows concurrent reconciliation and approval during failed capture %s', async phase => {
    fixture = await setup()
    const f = fixture
    const snapshotIds: string[] = []
    const write = f.store.write.bind(f.store)
    for (let index = 0; index < 2; index += 1) {
      const input = { ...f.approval, commandId: randomUUID() }
      const interrupted = vi.spyOn(f.store, 'write').mockImplementationOnce(async (...args) => {
        await write(...args)
        throw new Error('Capture interrupted')
      })
      try {
        const response = await f.client.callTool({ name: 'source_approve', arguments: input })
        expect(response.isError).toBe(true)
      } finally {
        interrupted.mockRestore()
      }
      const approval = (await f.pool.query<{ snapshot_id: string; state: string }>(
        'select snapshot_id,state from source_approvals where command_id=$1', [input.commandId])).rows[0]!
      expect(approval.state).toBe('failed')
      snapshotIds.push(approval.snapshot_id)
    }
    await f.pool.query(`update source_approvals
      set created_at=clock_timestamp()-make_interval(secs=>$2)
      where snapshot_id=any($1::uuid[])`, [snapshotIds, SOURCE_RETENTION_SECONDS * 2])
    const reader = await f.access.issue({ name: 'Capture reader', audience: 'operator',
      grants: [{ actions: ['sources:read'], scope: { workspaceIds: [f.workspaceId] } }],
      expiresAt: new Date(Date.now() + 120_000) })
    const deniedClient = await f.connect(reader.token)
    const restartedStore = new PrivateSourceSnapshotStore(f.canonical)
    const entered = rejectableDeferred()
    const resume = rejectableDeferred()
    const removals = new Map<string, number>()
    const measured = restartedStore.retainedCaptureBytes.bind(restartedStore)
    if (phase === 'measurement') {
      vi.spyOn(restartedStore, 'retainedCaptureBytes').mockImplementation(async snapshotId => {
        if (snapshotId === snapshotIds[0]) {
          entered.resolve()
          await resume.promise
        }
        return measured(snapshotId)
      })
    }
    for (const store of [f.store, restartedStore]) {
      const remove = store.remove.bind(store)
      vi.spyOn(store, 'remove').mockImplementation(async snapshotId => {
        removals.set(snapshotId, (removals.get(snapshotId) ?? 0) + 1)
        if (store === restartedStore && phase === 'deletion' && snapshotId === snapshotIds[0]) {
          entered.resolve()
          await resume.promise
        }
        await remove(snapshotId)
      })
    }
    const startup = reconcileFailedCaptures(f.pool, restartedStore, error => { throw error })
    await entered.promise
    try {
      // Both database row sets remain available while filesystem work is paused.
      const sql = await f.pool.connect()
      try {
        await beginTransaction(sql)
        const approvals = await sql.query(`select snapshot_id from source_approvals
          where snapshot_id=any($1::uuid[]) for update skip locked`, [snapshotIds])
        const reservations = await sql.query(`select owner_id from source_storage_reservations
          where owner_kind='capture' and owner_id=any($1::text[]) for update skip locked`, [snapshotIds])
        expect(approvals.rowCount).toBe(snapshotIds.length)
        expect(reservations.rowCount).toBe(snapshotIds.length)
      } finally {
        await rollbackTransaction(sql)
        sql.release()
      }
      const input = { ...f.approval, commandId: randomUUID() }
      const [, response, denied] = await Promise.all([
        f.sources.reconcileCaptures(),
        f.client.callTool({ name: 'source_approve', arguments: input }),
        deniedClient.callTool({ name: 'source_approve',
          arguments: { ...f.approval, commandId: randomUUID() } }),
      ])
      expect(response.isError, JSON.stringify(response.content)).not.toBe(true)
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      const source = SourceApproveResultSchema.parse(decodeMcpToolResult(response)).value
      expect((await f.read(source)).manifest).toEqual(source.manifest)
      expect((await f.reservation(source)).state).toBe('retained')
    } finally {
      resume.resolve()
      await startup
    }
    const reclaimed = await f.pool.query<{ owner_id: string; state: string }>(
      `select owner_id,state from source_storage_reservations
        where owner_kind='capture' and owner_id=any($1::text[])`, [snapshotIds])
    expect(reclaimed.rows).toHaveLength(snapshotIds.length)
    expect(reclaimed.rows.every(row => row.state === 'reclaimed')).toBe(true)
    await f.sources.reconcileCaptures()
    const audit = await f.pool.query<{ snapshot_id: string; count: string }>(
      `select details->>'snapshotId' as snapshot_id,count(*)::text as count from management_audit
        where action='source.capture.release' and details->>'snapshotId'=any($1::text[])
        group by details->>'snapshotId'`, [snapshotIds])
    expect(audit.rows).toHaveLength(snapshotIds.length)
    for (const snapshotId of snapshotIds) {
      expect(removals.get(snapshotId)).toBe(1)
      expect(audit.rows.find(row => row.snapshot_id === snapshotId)?.count).toBe('1')
      expect(await f.store.retainedCaptureBytes(snapshotId)).toBe(0)
    }
  }, 60_000)

it('skips a snapshot while admission holds its shared lock, then releases it after admission ends', async () => {
  fixture = await setup()
  const f = fixture
  const source = (await f.approve(SOURCE_RETENTION_SECONDS * 3)).source
  const sql = await f.pool.connect()
  try {
    await beginTransaction(sql)
    await f.sources.resolveApprovedSource(sql, f.owner.principal, f.workspaceId, f.pin(source))
    await f.sources.releaseUnusedSnapshots()
    expect((await f.read(source)).availability).toBe('retained')
    await commitTransaction(sql)
    await f.sources.releaseUnusedSnapshots()
    expect((await f.reservation(source)).state).toBe('reclaimed')
  } finally {
    await rollbackTransaction(sql)
    sql.release()
  }
}, 60_000)

it.each(['deletion', 'accounting'] as const)('retries interrupted %s without resurrecting the unavailable snapshot',
  async failure => {
    fixture = await setup()
    const f = fixture
    const approved = await f.approve(SOURCE_RETENTION_SECONDS * 3)
    if (failure === 'deletion') {
      vi.spyOn(f.store, 'remove').mockRejectedValueOnce(new Error('Injected deletion failure'))
    } else {
      await f.pool.query(`create function fail_snapshot_accounting() returns trigger language plpgsql as $$
        begin if new.state='reclaimed' then raise exception 'Injected accounting failure'; end if; return new; end $$;
        create trigger fail_snapshot_accounting before update on source_storage_reservations
          for each row execute function fail_snapshot_accounting()`)
    }
    await expect(f.sources.releaseUnusedSnapshots()).rejects.toThrow('Injected')
    const listed = SourceListResultSchema.parse(decodeMcpToolResult((await f.client.callTool({ name: 'source_list',
      arguments: { workspaceId: f.workspaceId, detail: 'full' } }))))
    expect(listed.items[0]!.availability).toBe('unavailable')
    expect((await f.reservation(approved.source)).state).toBe('retained')
    const retry = await f.client.callTool({ name: 'source_approve', arguments: approved.input })
    expect(retry.isError).toBe(true)
    expect(JSON.stringify(retry.content)).toContain('SOURCE_UNAVAILABLE')
    if (failure === 'accounting') {
      expect(await f.store.retainedCaptureBytes(approved.source.manifest.snapshotId)).toBe(0)
      await f.pool.query('drop trigger fail_snapshot_accounting on source_storage_reservations')
    }
    await f.sources.releaseUnusedSnapshots()
    expect((await f.reservation(approved.source)).state).toBe('reclaimed')
    expect(await f.store.retainedCaptureBytes(approved.source.manifest.snapshotId)).toBe(0)
  }, 60_000)


it('retains a completed capture and frees its preparing slot after adoption loses authorization', async () => {
  fixture = await setup()
  const f = fixture
  const commit = f.store.commit.bind(f.store)
  let captured!: () => void
  let release!: () => void
  const finalized = new Promise<void>(resolve => { captured = resolve })
  const resume = new Promise<void>(resolve => { release = resolve })
  const barrier = vi.spyOn(f.store, 'commit').mockImplementationOnce(async manifest => {
    await commit(manifest)
    await f.pool.query('update management_principals set expires_at=clock_timestamp() where id=$1',
      [f.owner.principal.id])
    captured()
    await resume
  })
  const input = { ...f.approval, commandId: randomUUID() }
  const request = f.client.callTool({ name: 'source_approve', arguments: input })
  await finalized
  let preparing: { state: string; reserved_bytes: string; record: SourceReservation } | undefined
  try {
    await reconcileFailedCaptures(f.pool, new PrivateSourceSnapshotStore(f.canonical), error => { throw error })
    preparing = (await f.pool.query<{ state: string; reserved_bytes: string; record: SourceReservation }>(
      `select r.state,r.reserved_bytes,r.record from source_storage_reservations r
        join source_approvals a on a.snapshot_id::text=r.owner_id where a.command_id=$1`, [input.commandId])).rows[0]
  } finally { release() }
  const response = await request
  expect(preparing).toMatchObject({ state: 'preparing', reserved_bytes: String(preparing!.record.reservedBytes) })
  expect(response.isError).toBe(true)
  barrier.mockRestore()
  const row = (await f.pool.query<{ snapshot_id: string; state: string }>(
    'select snapshot_id,state from source_approvals where command_id=$1', [input.commandId])).rows[0]!
  expect(row.state).toBe('failed')
  const restartedStore = new PrivateSourceSnapshotStore(f.canonical)
  const report = (error: unknown): never => { throw error }
  await reconcileFailedCaptures(f.pool, restartedStore, report)
  await reconcileFailedCaptures(f.pool, restartedStore, report)
  const retained = (await f.pool.query<{ state: string; reserved_bytes: string }>(
    'select state,reserved_bytes from source_storage_reservations where owner_id=$1', [row.snapshot_id])).rows[0]!
  expect(retained).toEqual({ state: 'retained',
    reserved_bytes: String(await restartedStore.retainedCaptureBytes(row.snapshot_id) + 16 * 1024) })
  const manifest = await restartedStore.manifest(row.snapshot_id)
  expect(await restartedStore.read(manifest, manifest.entries[0]!, AbortSignal.timeout(5000))).toEqual(Buffer.from('export const value = 1\n'))
  const reader = await f.access.issue({ name: 'Capture observer', audience: 'operator',
    grants: [{ actions: ['sources:read'], scope: { workspaceIds: [f.workspaceId] } }],
    expiresAt: new Date(Date.now() + 120_000) })
  const client = await f.connect(reader.token)
  expect((await client.callTool({ name: 'source_approve', arguments: { ...input, commandId: randomUUID() } })).isError)
    .toBe(true)
  const read = await client.callTool({ name: 'source_list', arguments: { workspaceId: f.workspaceId, detail: 'full' } })
  expect(read.isError).not.toBe(true)
  expect(SourceListResultSchema.parse(decodeMcpToolResult(read)).items).toEqual([])
}, 60_000)

it.each([false, true])('recovers an unadopted capture after restart (expired caller: %s)', async expired => {
  fixture = await setup()
  const f = fixture
  const input = { ...f.approval, commandId: randomUUID() }
  const connect = vi.spyOn(f.pool, 'connect')
  const commit = f.store.commit.bind(f.store)
  const capture = vi.spyOn(f.store, 'commit').mockImplementationOnce(async manifest => {
    await commit(manifest)
    // Lose database access after filesystem commit, including failure bookkeeping.
    connect.mockImplementation(() => {
      throw new Error('Database unavailable after capture commit')
    })
  })
  try {
    const response = await f.client.callTool({ name: 'source_approve', arguments: input })
    expect(response.isError).toBe(true)
  } finally {
    connect.mockRestore()
    capture.mockRestore()
  }
  const approval = (await f.pool.query<{ snapshot_id: string; state: string }>(
    'select snapshot_id,state from source_approvals where command_id=$1', [input.commandId])).rows[0]!
  const snapshotId = approval.snapshot_id
  expect(approval.state).toBe('capturing')
  expect((await f.pool.query('select 1 from source_snapshots where snapshot_id=$1', [snapshotId])).rows).toEqual([])
  expect((await f.pool.query('select 1 from management_command_receipts where principal_id=$1 and command_id=$2',
    [f.owner.principal.id, input.commandId])).rows).toEqual([])
  const manifest = await f.store.manifest(snapshotId)
  if (expired) await f.pool.query('update management_principals set expires_at=clock_timestamp() where id=$1',
    [f.owner.principal.id])
  const report = (error: unknown): never => { throw error }
  await reconcileFailedCaptures(f.pool, new PrivateSourceSnapshotStore(f.canonical), report)
  const reservation = (await f.pool.query<{ state: string }>(
    "select state from source_storage_reservations where owner_kind='capture' and owner_id=$1", [snapshotId])).rows[0]!
  expect(reservation.state).toBe('retained')
  expect(await f.store.manifest(snapshotId)).toEqual(manifest)
  if (!expired) {
    const writing = vi.spyOn(f.store, 'write')
    const replay = await f.client.callTool({ name: 'source_approve', arguments: input })
    expect(replay.isError, JSON.stringify(replay.content)).not.toBe(true)
    const source = SourceApproveResultSchema.parse(decodeMcpToolResult(replay)).value
    expect(source.manifest).toEqual(manifest)
    expect(writing).not.toHaveBeenCalled()
    expect((await f.read(source)).manifest).toEqual(manifest)
  }
}, 60_000)

it('keeps maintenance backoff while allowing a direct cleanup retry to reclaim unavailable bytes', async () => {
  fixture = await setup()
  const f = fixture
  const approved = await f.approve(SOURCE_RETENTION_SECONDS * 3)
  const error = new Error('Injected snapshot deletion failure')
  const remove = vi.spyOn(f.store, 'remove').mockRejectedValueOnce(error)
  const report = vi.fn()
  await f.sources.releaseUnusedSnapshots(report)
  expect(report).toHaveBeenCalledExactlyOnceWith(error)
  expect((await f.reservation(approved.source)).state).toBe('retained')
  await f.sources.releaseUnusedSnapshots(report)
  expect(remove).toHaveBeenCalledTimes(1)
  expect(report).toHaveBeenCalledTimes(1)
  await f.sources.releaseUnusedSnapshots()
  expect(remove).toHaveBeenCalledTimes(2)
  expect((await f.reservation(approved.source)).state).toBe('reclaimed')
  expect(await f.store.retainedCaptureBytes(approved.source.manifest.snapshotId)).toBe(0)
  const retry = await f.client.callTool({ name: 'source_approve', arguments: approved.input })
  expect(retry.isError).toBe(true)
  expect(JSON.stringify(retry.content)).toContain('SOURCE_UNAVAILABLE')
}, 60_000)


it('expires old unavailable source responses while preserving retained source retries and audit identities', async () => {
  fixture = await setup()
  const f = fixture
  const expired = await f.approve(SOURCE_RETENTION_SECONDS * 3)
  await f.sources.releaseUnusedSnapshots()
  expect((await f.pool.query('select availability from source_snapshots where snapshot_id=$1',
    [expired.source.manifest.snapshotId])).rows).toEqual([{ availability: 'unavailable' }])
  const retained = await f.approve()
  const commands = new PostgresCommandCoordinator(f.pool)
  for (const { input } of [expired, retained]) {
    await commands.execute({ principal: f.owner.principal, source: 'mcp', operation: 'source.project.capture',
      commandId: input.commandId, targetKey: f.workspaceId, payload: input, perform: async () => input })
  }
  const old = new Date(Date.now() - 31 * 86_400_000)
  await f.pool.query(`update management_command_receipts set created_at=$2
    where operation in ('source.approve','source.project.capture') and command_id=any($1::text[])`,
  [[expired.input.commandId, retained.input.commandId], old])
  await f.pool.query(`update management_audit set occurred_at=$2
    where action in ('source.approve','source.project.capture') and details->>'commandId'=any($1::text[])`,
  [[expired.input.commandId, retained.input.commandId], old])
  const retention = new PostgresCommandReceiptRetention(f.pool)
  expect(await retention.prune()).toBe(2)
  const rows = (await f.pool.query<{ command_id: string }>(
    "select command_id from management_command_receipts where operation='source.approve'", [])).rows
  expect(rows.map(row => row.command_id)).toEqual([retained.input.commandId])
  expect((await f.pool.query(`select 1 from management_audit
    where action='source.approve' and details->>'commandId'=$1 and outcome='succeeded'`,
  [expired.input.commandId])).rowCount).toBe(1)
  await expect(commands.execute({ principal: f.owner.principal, source: 'mcp', operation: 'source.project.capture',
    commandId: expired.input.commandId, targetKey: f.workspaceId, payload: expired.input,
    perform: async () => { throw new Error('Expired capture must not execute again') },
  })).rejects.toMatchObject({ code: 'COMMAND_RESULT_EXPIRED' })
  const reader = await f.access.issue({ name: 'Source reader', audience: 'operator',
    grants: [{ actions: ['sources:read'], scope: { workspaceIds: [f.workspaceId] } }],
    expiresAt: new Date(Date.now() + 60_000) })
  const denied = await (await f.connect(reader.token)).callTool({ name: 'source_approve', arguments: retained.input })
  expect(denied.isError).toBe(true)
  const retry = await f.client.callTool({ name: 'source_approve', arguments: expired.input })
  expect(retry.isError).toBe(true)
  expect(JSON.stringify(retry.content)).toContain('SOURCE_UNAVAILABLE')
  const replay = await f.client.callTool({ name: 'source_approve', arguments: retained.input })
  expect(replay.isError, JSON.stringify(replay.content)).not.toBe(true)
  expect(SourceApproveResultSchema.parse(decodeMcpToolResult(replay)).replayed).toBe(true)
}, 60_000)


it('expires both response kinds for reused repository snapshots without losing retry fences across sweeps', async () => {
  fixture = await setup()
  const f = fixture
  await f.pool.query(`update workspaces set record=record||$2::jsonb where id=$1`,
    [f.workspaceId, JSON.stringify({ repository: { provider: 'github', owner: 'fixture', name: 'site', defaultBranch: 'main' } })])
  const options = { preparedRepository: { repository: 'fixture/site', clone: f.project,
    commit: f.approval.commit, locationRevision: f.approval.expectedLocationRevision } }
  const first = { workspaceId: f.workspaceId, commit: f.approval.commit, commandId: randomUUID(), executablePolicy: 'strip' as const }
  const reused = { ...first, commandId: randomUUID() }
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.now() - SOURCE_RETENTION_SECONDS * 3_000)
  let original: ApprovedSource
  let shared: ApprovedSource
  try {
    original = await f.sources.approveProject(f.owner.principal, first, options)
    shared = await f.sources.approveProject(f.owner.principal, reused, options)
  } finally { vi.useRealTimers() }
  expect(shared.manifest.snapshotId).toBe(original.manifest.snapshotId)
  expect((await f.pool.query('select 1 from source_approvals where command_id=$1', [reused.commandId])).rows).toEqual([])
  await f.sources.releaseUnusedSnapshots()
  const listed = await f.client.callTool({ name: 'source_list', arguments: { workspaceId: f.workspaceId, detail: 'full' } })
  expect(listed.isError).not.toBe(true)
  expect(SourceListResultSchema.parse(decodeMcpToolResult(listed)).items)
    .toEqual([expect.objectContaining({ availability: 'unavailable' })])
  await expect(f.sources.approveProject(f.owner.principal, reused, options))
    .rejects.toMatchObject({ code: 'SOURCE_UNAVAILABLE' })
  const old = new Date(Date.now() - 31 * 86_400_000)
  await f.pool.query(`update management_command_receipts set created_at=$2
    where command_id=any($1::text[]) and operation in ('source.approve','source.project.capture')`,
  [[first.commandId, reused.commandId], old])
  await f.pool.query(`update management_audit set occurred_at=$2 where details->>'commandId'=any($1::text[])
    and action in ('source.approve','source.project.capture') and outcome='succeeded'`,
  [[first.commandId, reused.commandId], old])
  const retention = new PostgresCommandReceiptRetention(f.pool)
  let removed = 0
  for (let sweep = 0; sweep < 5; sweep++) removed += await retention.prune()
  expect(removed).toBe(4)
  expect((await f.pool.query('select 1 from management_command_receipts where command_id=any($1::text[])',
    [[first.commandId, reused.commandId]])).rows).toEqual([])
  expect((await f.pool.query(`select 1 from management_audit where details->>'commandId'=any($1::text[])
    and action in ('source.approve','source.project.capture') and outcome='succeeded'`,
  [[first.commandId, reused.commandId]])).rowCount).toBe(4)
  await expect(f.sources.approveProject(f.owner.principal, reused, options))
    .rejects.toMatchObject({ code: 'COMMAND_RESULT_EXPIRED' })
}, 60_000)
