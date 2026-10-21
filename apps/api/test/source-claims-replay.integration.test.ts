import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'
import { createFixtureDatabase, dropFixtureDatabase, removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { link, lstat, mkdir, mkdtemp, open, readFile, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import pg from 'pg'
import { expect, it } from 'vitest'
import { runWorktreesMigration } from '../src/infrastructure/runWorktreesMigration.js'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { PrivateSourceMaterializer, archiveMaterializationClaim, releaseMaterializationClaim }
  from '../src/modules/sources/materialization.js'
import { PostgresSourceService, type SourceExecutionHostPort } from '../src/modules/sources/service.js'
import { createSourceManifest, sourceSha256 } from '../src/modules/sources/manifest.js'
import { identity, openPrivateRoot } from '../src/modules/sources/privateFilesystem.js'
import type { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import type { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import type { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import type { RegisteredSourceRootPort } from '../src/modules/sources/admissionPorts.js'
import { measureRetainedSourceDirectory, measureRetainedMaterializationFootprint }
  from '../src/modules/sources/retainedDirectoryUsage.js'
import { PostgresSourceReservations } from '../src/modules/sources/reservations.js'
import { closeCompletedWorkflowSources } from '../src/modules/sources/workflowCleanup.js'

// Owned closure-only SQL fixture. This exercises the unchanged confirmClosed
// transaction and retention accounting; it does not qualify native closure proof.
const closureCases = ['lost-acknowledgement', 'database-failure'].flatMap(failure =>
  [0, 8 * 1024 * 1024].map(outputBytes => ({ failure, outputBytes })))
it.each(closureCases)('closes linked worktrees after $failure with $outputBytes output bytes', async ({ failure, outputBytes }) => {
  const database = `source_claims_test_${randomUUID().replaceAll('-', '')}`
  const adminUrl = process.env.TEST_DATABASE_URL!
  const admin = new pg.Pool({ connectionString: adminUrl })
  await createFixtureDatabase(admin, database)
  const url = new URL(adminUrl); url.pathname = `/${database}`
  const pool = new pg.Pool({ connectionString: url.toString() }), root = await mkdtemp(`${process.env.FOREMAN_CODE_TEST_ROOT}/source-claims-db-`)
  try {
    await pool.query(`create table source_execution_materializations (materialization_id uuid primary key, record jsonb not null,
      state text not null, execution_id text not null, reservation_id uuid not null);
      create table runs (id text primary key, execution_state text not null, stop_requested_at timestamptz);
      create table harness_executions (id text primary key, run_id text not null, record jsonb not null);
      create table run_cleanup_intents (run_id text primary key, pending boolean not null);
      create table execution_native_sessions (execution_id text primary key, workflow_finalized_at timestamptz, reference jsonb);
      create table execution_native_closures (execution_id text not null, generation bigint not null,
        closed_at timestamptz, detached_at timestamptz, expected_reference jsonb);
      create table source_preparation_reconciliations (operation_id text primary key, status text not null);
      create table job_computer_selections (operation_id text, workspace_id text, spec jsonb, released_at timestamptz);
      create table source_storage_reservations (reservation_id uuid primary key, scope_id text not null, owner_kind text not null,
      owner_id text not null, state text not null, reserved_bytes bigint not null, record jsonb not null)`)
    await pool.query(runWorktreesMigration.sql)
    const bytes = Buffer.from('retained original bytes\n')
    const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
      capturePolicy: 'exclusive-explicit-bytes-v1', executablePolicy: 'strip',
      entries: [{ path: 'app.txt', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }], deletions: [] })
    const handle = await openPrivateRoot(root), filesystem = await identity(handle); await handle.close()
    const binding = { version: 1 as const, mainId: randomUUID(), deviceId: null, workerInstallationId: null, workspaceId: randomUUID(), rootId: randomUUID(),
      bindingRevision: 1, locationRevision: 1, canonicalPath: root, filesystem, accessMode: 'exclusive-write' as const,
      snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
    const attempt = { placementHash: 'a'.repeat(64), executionId: randomUUID(), attemptId: randomUUID(), keyRevision: null, authorizationRevision: null }
    const receipt = await new PrivateSourceMaterializer({ async read() { return bytes } }, async () => {}).prepare({ manifest, binding, attempt })
    const tree = join(root, receipt.materializationId, 'tree')
    if (outputBytes) {
      // Delayed allocation and extent-tree blocks change a file's st_blocks when writeback runs; settle it before the baseline is measured.
      const output = await open(join(tree, 'output.bin'), 'w')
      try { await output.writeFile(Buffer.alloc(outputBytes, 7)); await output.sync() } finally { await output.close() }
    }
    const dependencies = join(root, 'dependency-cache')
    await mkdir(dependencies)
    const dependency = join(dependencies, 'package.js')
    await writeFile(dependency, Buffer.alloc(128 * 1024, 1))
    const beforeLinks = await measureRetainedSourceDirectory(root, receipt.materializationId, filesystem)
    const beforeTree = await lstat(tree)
    const beforeParent = await lstat(join(root, receipt.materializationId))
    await symlink(dependencies, join(tree, 'node_modules'))
    await symlink('missing-package', join(tree, 'missing-link'))
    await link(join(tree, 'app.txt'), join(tree, 'app-copy.txt'))
    const afterTree = await lstat(tree)
    const links = await Promise.all(['node_modules', 'missing-link'].map(name => lstat(join(tree, name))))
    const linkBytes = links.reduce((sum, stat) => sum + Math.max(4096, stat.size, stat.blocks * 512), 0)
    const expectedBytes = beforeLinks + linkBytes
      + Math.max(4096, afterTree.blocks * 512) - Math.max(4096, beforeTree.blocks * 512)
    const reservation = { reservationId: randomUUID(), scopeId: `main:${filesystem.device}:${filesystem.mountId}`, ownerKind: 'materialization' as const, ownerId: randomUUID(), reservedBytes: 100_000 }
    const record = SourceMaterializationRecordSchema.parse({ receipt, rootPolicyId: randomUUID(), rootPolicyRevision: '1', operationId: reservation.ownerId,
      reservationId: reservation.reservationId, sourceBindingHash: attempt.placementHash, finalDispatchBindingHash: null, state: 'prepared' })
    await pool.query(`insert into source_execution_materializations
      (materialization_id,record,state,execution_id,reservation_id) values ($1,$2,'prepared',$3,$4)`,
      [receipt.materializationId, record, receipt.executionId, record.reservationId])
    await pool.query(`insert into runs(id,execution_state) values ('ongoing-workflow','running')`)
    const execution = HarnessExecutionSchema.parse({
      id: receipt.executionId,
      runId: 'ongoing-workflow',
      workflowNodeId: 'source-node',
      agentId: 'source-agent',
      agentConfigurationVersionId: 'source-configuration',
      attempt: 1,
      workingDirectory: tree,
      input: {},
      state: 'running',
      createdAt: new Date().toISOString(),
    })
    await pool.query(`insert into harness_executions values ($1,'ongoing-workflow',$2)`,
      [receipt.executionId, execution])
    await pool.query(`insert into source_storage_reservations values ($1,$2,$3,$4,'owned',$5,$6)`, [reservation.reservationId, reservation.scopeId, reservation.ownerKind, reservation.ownerId, reservation.reservedBytes, reservation])
    const makeService = (releaseClaim: SourceExecutionHostPort['releaseClaim'], expectedRecord = record) => new PostgresSourceService(pool,
      {} as PostgresCommandCoordinator, {} as WorkspaceLocationService, {} as PrivateSourceSnapshotStore,
      binding.mainId, {} as RegisteredSourceRootPort, { releaseClaim } as SourceExecutionHostPort,
      { async confirmedClosed(original) { expect(original).toEqual(expectedRecord); return true } })
    if (failure === 'database-failure') await pool.query(`create function fail_source_close() returns trigger language plpgsql as $$ begin raise exception 'injected Main DB failure'; end $$;
      create trigger fail_source_close before update on source_execution_materializations for each row execute function fail_source_close()`)
    const initial = makeService(async original => {
      await releaseMaterializationClaim(original.receipt, async () => 'released')
      if (failure === 'lost-acknowledgement') throw new Error('injected lost remote acknowledgement')
      return { retainedBytes: await measureRetainedSourceDirectory(root, receipt.materializationId, filesystem) }
    })
    await expect(initial.confirmClosed(record)).rejects.toThrow('injected')
    expect((await pool.query('select state from source_execution_materializations')).rows[0].state).toBe('prepared')
    expect((await pool.query('select state,reserved_bytes from source_storage_reservations')).rows[0]).toEqual({ state: 'owned', reserved_bytes: String(reservation.reservedBytes) })
    await expect(readFile(join(root, `binding-${binding.rootId}.lock`))).rejects.toMatchObject({ code: 'ENOENT' })
    if (failure === 'database-failure') await pool.query('drop trigger fail_source_close on source_execution_materializations')
    // A new host process has no in-memory release history.
    const recovered = makeService(async original => {
      await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
        "import { releaseMaterializationClaim } from './src/modules/sources/materialization.ts'; await releaseMaterializationClaim(JSON.parse(process.argv[1]), async () => 'released');",
        JSON.stringify(original.receipt)])
      return { retainedBytes: await measureRetainedSourceDirectory(root, receipt.materializationId, filesystem) }
    })
    const report = (error: unknown): never => { throw error }
    await closeCompletedWorkflowSources(pool, recovered, report)
    expect((await pool.query('select state from source_execution_materializations')).rows[0].state).toBe('prepared')
    const session = { harness: 'codex', nativeSessionId: 'source-session', providerVersion: '1.0.0' }
    await pool.query(`update harness_executions set record=$1`, [HarnessExecutionSchema.parse({
      ...execution,
      state: 'completed', nativeSessionId: session.nativeSessionId, result: { outcome: 'succeeded' },
      finishedAt: new Date().toISOString(),
    })])
    await pool.query('insert into execution_native_sessions values($1,null,$2)', [receipt.executionId, session])
    await pool.query(`insert into execution_native_closures(execution_id,generation,expected_reference)
      values($1,1,$2)`, [receipt.executionId, session])
    // Cleanup and Stop still need the original finalizer to commit physical closure.
    for (const pending of [false, true]) {
      await pool.query(`insert into run_cleanup_intents values('ongoing-workflow',$1)
        on conflict(run_id) do update set pending=excluded.pending`, [pending])
      await closeCompletedWorkflowSources(pool, recovered, report)
      expect((await pool.query('select state from source_execution_materializations')).rows[0].state).toBe('prepared')
    }
    await pool.query('update runs set stop_requested_at=clock_timestamp()')
    await closeCompletedWorkflowSources(pool, recovered, report)
    expect((await pool.query('select state from source_execution_materializations')).rows[0].state).toBe('prepared')
    await pool.query('update execution_native_closures set closed_at=clock_timestamp()')
    await closeCompletedWorkflowSources(pool, recovered, report)
    expect((await pool.query('select execution_state from runs')).rows[0].execution_state).toBe('running')
    await recovered.confirmClosed(record)
    expect((await pool.query('select state from source_execution_materializations')).rows[0].state).toBe('closed')
    const retainedBytes = await measureRetainedSourceDirectory(root, receipt.materializationId, filesystem) + 16 * 1024
    const [releasedClaim, afterParent] = await Promise.all([
      lstat(join(root, receipt.materializationId, 'released-claim.json')),
      lstat(join(root, receipt.materializationId)),
    ])
    const claimBytes = Math.max(4096, releasedClaim.size, releasedClaim.blocks * 512)
    const parentGrowth = Math.max(4096, afterParent.blocks * 512) - Math.max(4096, beforeParent.blocks * 512)
    expect(retainedBytes).toBe(expectedBytes + claimBytes + parentGrowth + 16 * 1024)
    if (outputBytes) expect(retainedBytes).toBeGreaterThan(reservation.reservedBytes)
    else expect(retainedBytes).toBeLessThan(reservation.reservedBytes)
    expect((await pool.query('select state,reserved_bytes from source_storage_reservations')).rows[0]).toEqual({ state: 'retained', reserved_bytes: String(retainedBytes) })
    expect(Number((await pool.query("select sum(reserved_bytes) as charged from source_storage_reservations where state<>'reclaimed'")).rows[0].charged)).toBe(retainedBytes)
    expect(await readFile(join(root, receipt.materializationId, 'tree/app.txt'))).toEqual(bytes)
    expect(await readFile(dependency)).toEqual(Buffer.alloc(128 * 1024, 1))
    await pool.query(`insert into source_preparation_reconciliations values ($1,'closed')`, [record.operationId])
    await pool.query('update source_storage_reservations set reserved_bytes=$1', [reservation.reservedBytes])
    await closeCompletedWorkflowSources(pool, recovered, report)
    expect((await pool.query('select reserved_bytes from source_storage_reservations')).rows[0].reserved_bytes)
      .toBe(String(retainedBytes))
    await closeCompletedWorkflowSources(pool, recovered, report)
    expect((await pool.query('select state,reserved_bytes from source_storage_reservations')).rows[0])
      .toEqual({ state: 'retained', reserved_bytes: String(retainedBytes) })
    expect(await readFile(join(tree, 'app.txt'))).toEqual(bytes)
    expect(await readFile(dependency)).toEqual(Buffer.alloc(128 * 1024, 1))
    await expect(new PostgresSourceReservations(async () => sourceStorageCapacityFixture()).reserve(pool, { scopeId: reservation.scopeId,
      ownerKind: 'materialization', ownerId: randomUUID(), reservedBytes: 100_000 }))
      .resolves.toHaveProperty('reservationId')

    const sharedAttempt = { ...attempt, executionId: randomUUID(), attemptId: randomUUID() }
    const shared = await new PrivateSourceMaterializer({ async read() { return bytes } }, async () => {})
      .prepare({ manifest, binding, attempt: sharedAttempt, sharedWritableTree: true })
    const sharedReservation = { ...reservation, reservationId: randomUUID(), ownerId: randomUUID() }
    const sharedRecord = SourceMaterializationRecordSchema.parse({ ...record, receipt: shared,
      operationId: sharedReservation.ownerId, reservationId: sharedReservation.reservationId })
    await pool.query('update runs set execution_state=$1', ['completed'])
    await pool.query('insert into harness_executions values($1,$2,$3)', [shared.executionId, execution.runId,
      HarnessExecutionSchema.parse({ ...execution, id: shared.executionId, state: 'completed',
        nativeSessionId: 'shared-session', result: { outcome: 'succeeded' }, finishedAt: new Date().toISOString() })])
    await pool.query(`insert into source_execution_materializations
      (materialization_id,record,state,execution_id,reservation_id) values($1,$2,'closed',$3,$4)`,
    [shared.materializationId, sharedRecord, shared.executionId, sharedReservation.reservationId])
    await pool.query('insert into source_storage_reservations values($1,$2,$3,$4,\'owned\',$5,$6)',
      [sharedReservation.reservationId, sharedReservation.scopeId, sharedReservation.ownerKind,
        sharedReservation.ownerId, sharedReservation.reservedBytes, sharedReservation])
    // Reproduce a previous close that archived the claim but left its reference copy accounted as retained.
    await archiveMaterializationClaim(shared, { filesystem }, async () => 'released')
    const oldFootprint = await measureRetainedMaterializationFootprint(shared)
    await new PostgresSourceReservations().retainMaterialization(pool, sharedReservation,
      { ...oldFootprint, retainedBytes: oldFootprint.retainedBytes + 16 * 1024 })
    expect(oldFootprint.retainedBytes + 16 * 1024).not.toBe(sharedReservation.reservedBytes)
    let releases = 0
    const cleanup = makeService(async original => {
      releases += 1
      await releaseMaterializationClaim(original.receipt, async () => 'released')
      return measureRetainedMaterializationFootprint(original.receipt)
    }, sharedRecord)
    await closeCompletedWorkflowSources(pool, cleanup, report)
    expect(releases).toBe(1)
    await expect(lstat(join(root, shared.materializationId, 'tree'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, shared.sharedTree!.id, 'tree/app.txt'))).toEqual(bytes)
    const accounted = (await pool.query('select state,reserved_bytes,record from source_storage_reservations where reservation_id=$1',
      [sharedReservation.reservationId])).rows[0]!
    expect(accounted.state).toBe('retained')
    expect(accounted.record.referenceReclaimed).toBe(true)
    expect(Number(accounted.reserved_bytes)).toBeLessThan(oldFootprint.retainedBytes + 16 * 1024)
    await closeCompletedWorkflowSources(pool, cleanup, report)
    expect(releases).toBe(1)
  } finally {
    await pool.end(); await dropFixtureDatabase(admin, database); await admin.end(); await removeFixtureDirectory(root)
  }
}, 30_000)
