import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { expect, it } from 'vitest'
import { runWorktreesMigration } from '../src/infrastructure/runWorktreesMigration.js'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { VerificationJobExecutionSchema } from '@foreman-code/contracts/job-verification'
import { verificationJobLifecycle } from '@foreman-code/contracts/job-verification-policy'
import { jobCleanupOptions, jobLifecycleSignal } from '../src/modules/jobs/lifecycle.js'
import { releaseClosedJobComputers } from '../src/modules/jobs/computerSelection.js'
import { PostgresSourceService, type SourceExecutionHostPort } from '../src/modules/sources/service.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim } from '../src/modules/sources/materialization.js'
import { createSourceManifest, sourceSha256 } from '../src/modules/sources/manifest.js'
import { identity, openPrivateRoot } from '../src/modules/sources/privateFilesystem.js'
import { measureRetainedMaterialization } from '../src/modules/sources/retainedDirectoryUsage.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import type { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import type { RegisteredSourceRootPort } from '../src/modules/sources/admissionPorts.js'
import { createFixtureDatabase, dropFixtureDatabase, removeFixtureDirectory } from './helpers/testResources.js'
import { verificationRuntimeFixture } from './helpers/verificationRuntimeFixture.js'
import { jobExecution } from './helpers/jobFixture.js'

it('reclaims source and releases computer capacity after a disconnect outlasts the cleanup deadline', async () => {
  const name = `job_cleanup_test_${randomUUID().replaceAll('-', '')}`
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL! })
  await createFixtureDatabase(admin, name)
  const url = new URL(process.env.TEST_DATABASE_URL!)
  url.pathname = `/${name}`
  const pool = new pg.Pool({ connectionString: url.toString() })
  const root = await mkdtemp(`${process.env.FOREMAN_CODE_TEST_ROOT}/job-cleanup-`)
  try {
    await pool.query(`create table runs (id text primary key);
      create table source_execution_materializations
      (materialization_id uuid primary key, record jsonb, state text, execution_id text, operation_id text);
      create table source_storage_reservations
      (reservation_id uuid primary key, scope_id text, owner_kind text, owner_id text, state text,
       reserved_bytes bigint, record jsonb);
      create table job_executions
      (id text primary key, operation_id text, accepted_spec jsonb, record jsonb, accepted_by text);
      create table job_computer_selections
      (execution_id text, operation_id text, released_at timestamptz);
      create table job_runtime_qualification_approvals
      (id text, run_principal_id text, record jsonb, run_result jsonb);
      create table source_preparation_reconciliations (operation_id text, status text, closure jsonb)`)
    await pool.query(runWorktreesMigration.sql)
    const bytes = Buffer.from('retained original source')
    const manifest = createSourceManifest({ version: 1, approvedSourceId: randomUUID(), snapshotId: randomUUID(),
      capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip', deletions: [],
      entries: [{ path: 'app.ts', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }] })
    const handle = await openPrivateRoot(root)
    const filesystem = await identity(handle)
    await handle.close()
    const binding = { version: 1 as const, mainId: randomUUID(), deviceId: null, workerInstallationId: null,
      workspaceId: randomUUID(), rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
      canonicalPath: root, filesystem, accessMode: 'exclusive-write' as const,
      snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
    const attempt = { placementHash: 'a'.repeat(64), executionId: randomUUID(), attemptId: randomUUID(),
      keyRevision: null, authorizationRevision: null }
    const receipt = await new PrivateSourceMaterializer({ read: async () => bytes }, async () => {})
      .prepare({ manifest, binding, attempt })
    const reservation = { reservationId: randomUUID(), scopeId: 'cleanup-source', ownerKind: 'materialization',
      ownerId: randomUUID(), reservedBytes: 100_000 }
    const record = SourceMaterializationRecordSchema.parse({ receipt, rootPolicyId: randomUUID(), rootPolicyRevision: '1',
      operationId: reservation.ownerId, reservationId: reservation.reservationId,
      sourceBindingHash: attempt.placementHash, finalDispatchBindingHash: null, state: 'prepared' })
    const runtime = verificationRuntimeFixture()
    const execution = VerificationJobExecutionSchema.parse({ ...jobExecution(), schemaVersion: 2,
      id: receipt.executionId, operationId: record.operationId, attemptId: receipt.attemptId,
      acceptedSpec: { ...runtime.spec,
        lifecycle: verificationJobLifecycle(new Date(0).toISOString(), runtime.spec.policy) },
      publication: 'failed', resultIssue: 'publication_failed',
      process: { phase: 'terminal', outcome: 'build_failed', exitCode: 1, signal: null, processStopped: true } })
    await pool.query(`insert into source_execution_materializations
      (materialization_id,record,state,execution_id,operation_id) values($1,$2,'prepared',$3,$4)`,
      [receipt.materializationId, record, execution.id, execution.operationId])
    await pool.query("insert into source_storage_reservations values($1,$2,$3,$4,'owned',$5,$6)",
      [reservation.reservationId, reservation.scopeId, reservation.ownerKind, reservation.ownerId,
        reservation.reservedBytes, reservation])
    await pool.query('insert into job_executions values($1,$2,$3,$4,$5)',
      [execution.id, execution.operationId, execution.acceptedSpec, execution, 'operator'])
    await pool.query('insert into job_computer_selections values($1,$2,null)', [execution.id, execution.operationId])
    let closed = false
    const sources = new PostgresSourceService(pool, {} as PostgresCommandCoordinator, {} as WorkspaceLocationService,
      {} as PrivateSourceSnapshotStore, binding.mainId, {} as RegisteredSourceRootPort,
      { releaseClaim: async (original, options) => {
        await releaseMaterializationClaim(original.receipt, async () => 'released', undefined, options?.signal)
        return { retainedBytes: await measureRetainedMaterialization(original.receipt) }
      } } as SourceExecutionHostPort,
      { confirmedClosed: async original => closed && original.receipt.executionId === execution.id })
    expect(jobLifecycleSignal(execution, 'cleanup').aborted).toBe(true)
    await expect(sources.confirmClosed(record, jobCleanupOptions(execution)))
      .rejects.toMatchObject({ code: 'SOURCE_EXECUTION_UNCERTAIN' })
    await releaseClosedJobComputers(pool)
    expect((await pool.query('select released_at from job_computer_selections')).rows[0].released_at).toBeNull()
    closed = true
    await sources.confirmClosed(record, jobCleanupOptions(execution))
    await releaseClosedJobComputers(pool)
    expect((await pool.query('select state from source_execution_materializations')).rows[0].state).toBe('closed')
    const retained = (await pool.query('select state,reserved_bytes from source_storage_reservations')).rows[0]
    expect(retained.state).toBe('retained')
    expect(Number(retained.reserved_bytes)).toBeLessThan(reservation.reservedBytes)
    expect((await pool.query('select released_at from job_computer_selections')).rows[0].released_at).not.toBeNull()
    expect((await pool.query('select record from job_executions')).rows[0].record).toEqual(execution)
    expect(await readFile(join(root, receipt.materializationId, 'tree/app.ts'))).toEqual(bytes)
    expect(jobLifecycleSignal(execution, 'publication').aborted).toBe(true)
  } finally {
    await pool.end()
    await dropFixtureDatabase(admin, name)
    await admin.end()
    await removeFixtureDirectory(root)
  }
}, 30_000)
