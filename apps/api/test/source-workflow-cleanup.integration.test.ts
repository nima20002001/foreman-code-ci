import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { expect, it, vi } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { SourceMaterializationRecordSchema } from '@foreman-code/contracts/source-admission'
import { createFixtureDatabase, dropFixtureDatabase, removeFixtureDirectory } from './helpers/testResources.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'
import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'
import { createSourceManifest, sourceSha256 } from '../src/modules/sources/manifest.js'
import { identity, openPrivateRoot } from '../src/modules/sources/privateFilesystem.js'
import { archiveMaterializationClaim, PrivateSourceMaterializer,
  releaseMaterializationClaim } from '../src/modules/sources/materialization.js'
import { systemGitWorktreePorts, type GitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { closeSourceWorktree } from '../src/modules/sources/worktreeCleanup.js'
import { measureRetainedMaterializationFootprint } from '../src/modules/sources/retainedDirectoryUsage.js'
import { sourceWorkingTreePath } from '../src/modules/sources/sourceTreePaths.js'
import { PostgresSourceService, type SourceExecutionHostPort } from '../src/modules/sources/service.js'
import { PostgresSourceReservations } from '../src/modules/sources/reservations.js'
import { closeCompletedWorkflowSources, localWorkflowSourceClosed } from '../src/modules/sources/workflowCleanup.js'
import type { SourceOperationOwner } from '@foreman-code/contracts/source-operations'
import { reclaimSourceReservation } from '../src/modules/sources/reclaimSourceReservation.js'
import { sourceBindingHash } from '../src/modules/sources/bindingHash.js'
import { MaterializationReservationCleanup } from '../src/modules/sources/materializationReservationCleanup.js'
import { DeviceApplicationError } from '../src/modules/devices/deviceApplicationError.js'

const git = (cwd: string, ...args: string[]) => execFileSync('git', args,
  { cwd, encoding: 'utf8', env: gitFixtureEnvironment() }).trim()

async function fixture(host: 'main' | 'device' = 'main') {
  const database = `source_workflow_test_${randomUUID().replaceAll('-', '')}`
  const adminUrl = process.env.TEST_DATABASE_URL!
  const admin = new pg.Pool({ connectionString: adminUrl })
  await createFixtureDatabase(admin, database)
  const url = new URL(adminUrl)
  url.pathname = `/${database}`
  const pool = new pg.Pool({ connectionString: url.toString() })
  const base = await mkdtemp(join(process.env.FOREMAN_CODE_TEST_ROOT!, 'source-workflow-'))
  const dispose = async () => {
    await pool.end()
    await dropFixtureDatabase(admin, database)
    await admin.end()
    await removeFixtureDirectory(base)
  }
  try {
    await pool.query(`
      create table runs (id text primary key, execution_state text not null, workflow_version_id text);
      create table workflow_versions (id text primary key, record jsonb not null);
      create table harness_executions (id text primary key, run_id text not null, record jsonb not null,
        workflow_node_id text not null);
      create table execution_native_sessions (execution_id text primary key, reference jsonb,
        workflow_finalized_at timestamptz);
      create table execution_native_closures (execution_id text, generation bigint, execution_identity jsonb,
        expected_reference jsonb, closed_reference jsonb, closed_at timestamptz, detached_at timestamptz,
        detached_reference jsonb, closed_without_session boolean not null default false);
      create table source_preparation_reconciliations (operation_id text primary key, status text not null);
      create table job_computer_selections (operation_id text, workspace_id text, spec jsonb, released_at timestamptz);
      create table source_storage_reservations (reservation_id uuid primary key, scope_id text, owner_kind text,
        owner_id text, reserved_bytes bigint, state text, record jsonb);
      create table source_execution_materializations (materialization_id uuid primary key, execution_id text,
        reservation_id uuid, record jsonb, state text, worktree_cleanup jsonb);
      insert into runs(id,execution_state) values ('loop-run','running')`)
    const origin = join(base, 'origin')
    const rootPath = join(base, 'materializations')
    await mkdir(origin, { mode: 0o700 })
    await mkdir(rootPath, { mode: 0o700 })
    const bytes = Buffer.from('approved source\n')
    await writeFile(join(origin, 'app.ts'), bytes)
    git(origin, 'init', '-q', '-b', 'main')
    git(origin, 'add', '.')
    git(origin, 'commit', '-qm', 'Approved source')
    const commit = git(origin, 'rev-parse', 'HEAD')
    const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
      capturePolicy: 'git-tree-v1', executablePolicy: 'preserve-approved', deletions: [],
      git: { commit, tree: git(origin, 'rev-parse', 'HEAD^{tree}'), objectFormat: 'sha1', repository: 'fixture/project' },
      entries: [{ path: 'app.ts', kind: 'file', byteSize: bytes.length, sha256: sourceSha256(bytes), executable: false }] })
    const handle = await openPrivateRoot(rootPath)
    const filesystem = await identity(handle)
    await handle.close()
    const device = host === 'device'
      ? { deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 } : null
    const binding = { version: 1 as const, mainId: randomUUID(), deviceId: device?.deviceId ?? null,
      workerInstallationId: device?.workerInstallationId ?? null, workspaceId: 'workspace', rootId: randomUUID(), bindingRevision: 1, locationRevision: 1,
      canonicalPath: rootPath, filesystem, accessMode: 'exclusive-write' as const,
      snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }
    const system = systemGitWorktreePorts(gitFixtureEnvironment())
    const ports: GitWorktreePorts = {
      cloneDirectory: repository => join(base, 'clones', ...repository.split('/')),
      git: (args, options) => system.git(args[0] === 'clone'
        ? ['clone', '--no-checkout', origin, args.at(-1)!] : args, options),
    }
    const materializer = new PrivateSourceMaterializer({ async read() { return bytes } }, async () => {}, undefined, ports)
    const executions = { async releaseClaim(record) {
      await releaseMaterializationClaim(record.receipt, async () => 'released')
      const worktree = await closeSourceWorktree(record.receipt, AbortSignal.timeout(30_000), ports)
      return { ...await measureRetainedMaterializationFootprint(record.receipt), ...(worktree ? { worktree } : {}) }
    } } as Pick<SourceExecutionHostPort, 'releaseClaim'>
    const sources = new PostgresSourceService(pool, {} as never, {} as never, {} as never, binding.mainId,
      {} as never, executions as SourceExecutionHostPort,
      { confirmedClosed: record => localWorkflowSourceClosed(pool, record.receipt.executionId) })
    const root: SourceOperationOwner['root'] = { version: 1, binding,
      source: { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
        manifestDigest: manifest.manifestDigest },
      selection: { hostRef: device ? { kind: 'device', mainId: binding.mainId, deviceId: device.deviceId }
        : { kind: 'main', mainId: binding.mainId }, rootPolicyId: randomUUID(), rootPolicyRevision: '1', locationRevision: '1' },
      registration: device ? { workerInstallationId: device.workerInstallationId, keyRevision: device.keyRevision,
        authorizationRevision: device.authorizationRevision } : null, ownerPrincipalId: 'operator', authorizedByPrincipalId: 'operator',
      attestationId: randomUUID(), attestationDigest: 'a'.repeat(64), boundAt: new Date().toISOString() }
    const saved = makeCurrentWorkflowFixture('source-cleanup', 'single').version
    const node = saved.definition.nodes[0]!
    node.id = 'agent-node'
    node.agentId = 'agent'
    node.placement = { schemaVersion: 1, ...root.selection, projectRoot: origin,
      cwdPolicy: 'project-root', relativeCwd: '', instanceId: randomUUID(), instanceRevision: '1',
      harnessInstallationId: 'fixture-codex', source: root.source,
      rootBinding: { rootId: binding.rootId, bindingRevision: binding.bindingRevision } }
    saved.workspaceId = binding.workspaceId
    saved.definition.workspaceId = binding.workspaceId
    saved.entryNodeId = node.id
    saved.definition.entryNodeId = node.id
    saved.agentConfigurationVersionIds = { [node.agentId]: 'configuration' }
    const version = WorkflowVersionV3Schema.parse(saved)
    await pool.query('insert into workflow_versions values($1,$2)', [version.id, version])
    await pool.query('update runs set workflow_version_id=$1', [version.id])
    return { pool, dispose, ports, binding, root, manifest, materializer, sources, bytes }
  } catch (error) {
    await dispose()
    throw error
  }
}

async function addOccurrence(f: Awaited<ReturnType<typeof fixture>>, state: 'running' | 'completed',
  closed = state === 'completed') {
  const operationId = randomUUID()
  const attempt = { executionId: randomUUID(), attemptId: randomUUID(), placementHash: '',
    keyRevision: f.root.registration?.keyRevision ?? null,
    authorizationRevision: f.root.registration?.authorizationRevision ?? null }
  attempt.placementHash = sourceBindingHash(f.root, attempt, operationId)
  const receipt = await f.materializer.prepare({ binding: f.binding, manifest: f.manifest, attempt,
    sharedWritableTree: true, worktree: { repository: 'fixture/project', branch: 'foreman/loop' } })
  const reservation = { reservationId: randomUUID(), scopeId: 'source-filesystem', ownerKind: 'materialization' as const,
    ownerId: operationId, reservedBytes: 8 * 1024 * 1024 }
  const record = SourceMaterializationRecordSchema.parse({ receipt, rootPolicyId: randomUUID(), rootPolicyRevision: '1',
    operationId: reservation.ownerId, reservationId: reservation.reservationId, sourceBindingHash: attempt.placementHash,
    finalDispatchBindingHash: 'b'.repeat(64), state: 'prepared' })
  const workingDirectory = sourceWorkingTreePath(receipt)
  const session = { harness: 'codex', nativeSessionId: randomUUID(), providerVersion: '1.0.0' }
  const execution = HarnessExecutionSchema.parse({ id: attempt.executionId, runId: 'loop-run', workflowNodeId: 'agent-node',
    agentId: 'agent', agentConfigurationVersionId: 'configuration', attempt: 1, workingDirectory, input: {}, state,
    nativeSessionId: session.nativeSessionId, createdAt: new Date().toISOString(),
    ...(state === 'completed' ? { result: { outcome: 'succeeded' }, finishedAt: new Date().toISOString() } : {}) })
  const executionIdentity = { id: execution.id, runId: execution.runId, workflowNodeId: execution.workflowNodeId,
    agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId,
    attempt: execution.attempt, workingDirectory }
  await f.pool.query('insert into harness_executions values($1,$2,$3,$4)',
    [execution.id, execution.runId, execution, execution.workflowNodeId])
  await f.pool.query('insert into execution_native_sessions values($1,$2,$3)',
    [execution.id, session, closed ? new Date() : null])
  await f.pool.query(`insert into execution_native_closures
    (execution_id,generation,execution_identity,expected_reference,closed_reference,closed_at)
    values($1,1,$2,$3,$3,$4)`, [execution.id, executionIdentity, session, closed ? new Date() : null])
  await f.pool.query('insert into source_storage_reservations values($1,$2,$3,$4,$5,$6,$7)',
    [reservation.reservationId, reservation.scopeId, reservation.ownerKind, reservation.ownerId,
      reservation.reservedBytes, 'owned', reservation])
  await f.pool.query('insert into source_execution_materializations values($1,$2,$3,$4,$5,null)',
    [receipt.materializationId, execution.id, reservation.reservationId, record, 'prepared'])
  return { record, reservation, workingDirectory }
}

async function addReclamationTables(pool: pg.Pool) {
  await pool.query(`
    alter table runs add column workspace_id text, add column stop_requested_at timestamptz;
    alter table source_execution_materializations add column operation_id text;
    alter table source_preparation_reconciliations
      add column owner jsonb, add column principal_id text, add column command_id text,
      add column queue_ticket_id text, add column reconciliation_id uuid;
    create table job_executions (operation_id text, record jsonb);
    create table job_admission_queue (operation_id text, record jsonb);
    create table job_preparations (operation_id text, workspace_id text);
    create table workflow_job_preparations (run_id text, preparation jsonb);
    create table execution_dispatch_intents (operation_id text, run_id text);
    create table run_cleanup_intents (run_id text, pending boolean);
    create table execution_native_recoveries
      (execution_id text, generation bigint, execution_identity jsonb, reference jsonb);
    create table application_installation (singleton boolean, id uuid);
    create table device_registrations (id text, main_id text, record jsonb);
    create table source_root_bindings (root_id uuid, binding_revision integer, record jsonb);
    create table management_audit
      (principal_id text, source text, action text, target_key text, outcome text, details jsonb);
  `)
}

it('defers automatic Main source reclamation until the original native owner confirms closure', async () => {
  const f = await fixture()
  try {
    const copy = await addOccurrence(f, 'completed', false)
    const executionId = copy.record.receipt.executionId
    await addReclamationTables(f.pool)
    const binding = f.binding
    const scopeId = `${binding.mainId}:original-main:${binding.mainId}:${binding.filesystem.device}:${binding.filesystem.mountId}`
    const reservation = { ...copy.reservation, scopeId }
    await f.pool.query('insert into application_installation values(true,$1)', [binding.mainId])
    await f.pool.query('insert into source_root_bindings values($1,$2,$3)',
      [binding.rootId, binding.bindingRevision, f.root])
    await f.pool.query('update source_execution_materializations set operation_id=$1 where execution_id=$2',
      [copy.record.operationId, executionId])
    await f.pool.query('update source_storage_reservations set scope_id=$1,record=$2 where reservation_id=$3',
      [scopeId, reservation, reservation.reservationId])
    const reclaim = vi.fn((grant: Parameters<typeof reclaimSourceReservation>[0]) => reclaimSourceReservation(grant, {
      authorize: async () => {}, operationClosed: async () => true,
      nativeClosed: owner => localWorkflowSourceClosed(f.pool, owner.attempt.executionId), git: f.ports,
    }, AbortSignal.timeout(60_000)))
    const cleanup = new MaterializationReservationCleanup(f.pool, reclaim)
    const report = vi.fn()
    expect(await cleanup.reconcile(report)).toBe(0)
    expect(report).not.toHaveBeenCalled()
    expect(reclaim).not.toHaveBeenCalled()
    expect((await f.pool.query('select state,reserved_bytes from source_storage_reservations where reservation_id=$1',
      [reservation.reservationId])).rows[0]).toEqual({ state: 'owned', reserved_bytes: String(reservation.reservedBytes) })
    expect(await readFile(join(copy.workingDirectory, f.manifest.entries[0]!.path))).toEqual(f.bytes)

    await f.pool.query('update execution_native_closures set closed_at=clock_timestamp() where execution_id=$1',
      [executionId])
    expect(await cleanup.reconcile(report)).toBe(1)
    expect(report).not.toHaveBeenCalled()
    expect(reclaim).toHaveBeenCalledOnce()
    expect((await f.pool.query('select state from source_execution_materializations where execution_id=$1',
      [executionId])).rows[0]).toEqual({ state: 'closed' })
    await expect(stat(copy.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await f.dispose()
  }
}, 60_000)

it('asks the Worker to reclaim a source only after Main records its native owner closure', async () => {
  const f = await fixture('device')
  try {
    const copy = await addOccurrence(f, 'completed', false)
    const executionId = copy.record.receipt.executionId
    await addReclamationTables(f.pool)
    const binding = f.binding
    const registration = f.root.registration!
    const scopeId = `${binding.mainId}:${binding.deviceId}:${binding.workerInstallationId}`
      + `:${binding.filesystem.device}:${binding.filesystem.mountId}`
    const reservation = { ...copy.reservation, scopeId }
    await f.pool.query('insert into application_installation values(true,$1)', [binding.mainId])
    await f.pool.query('insert into device_registrations values($1,$2,$3)', [binding.deviceId, binding.mainId,
      { mainId: binding.mainId, deviceId: binding.deviceId, workerInstallationId: registration.workerInstallationId,
        publicKeyFingerprint: 'c'.repeat(64), keyRevision: registration.keyRevision,
        authorizationRevision: registration.authorizationRevision, status: 'paired', scopes: [] }])
    await f.pool.query('insert into source_root_bindings values($1,$2,$3)',
      [binding.rootId, binding.bindingRevision, f.root])
    await f.pool.query('update source_execution_materializations set operation_id=$1 where execution_id=$2',
      [copy.record.operationId, executionId])
    await f.pool.query('update source_storage_reservations set scope_id=$1,record=$2 where reservation_id=$3',
      [scopeId, reservation, reservation.reservationId])
    // The Worker refuses cleanup while the native owner of the finished execution is still closing.
    let workerNativeClosed = false
    const reclaim = vi.fn(async (grant: Parameters<typeof reclaimSourceReservation>[0]) => {
      if (!workerNativeClosed) throw new DeviceApplicationError('source-reconciliation-unconfirmed')
      return reclaimSourceReservation(grant, {
        authorize: async () => {}, operationClosed: async () => true, nativeClosed: async () => true, git: f.ports,
      }, AbortSignal.timeout(60_000))
    })
    const cleanup = new MaterializationReservationCleanup(f.pool, reclaim)
    const report = vi.fn()
    expect(await cleanup.reconcile(report)).toBe(0)
    expect(reclaim).not.toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
    expect((await f.pool.query('select state,reserved_bytes from source_storage_reservations where reservation_id=$1',
      [reservation.reservationId])).rows[0]).toEqual({ state: 'owned', reserved_bytes: String(reservation.reservedBytes) })

    workerNativeClosed = true
    await f.pool.query('update execution_native_closures set closed_at=clock_timestamp() where execution_id=$1',
      [executionId])
    await cleanup.reconcile(report)
    expect(reclaim).toHaveBeenCalledOnce()
  } finally {
    await f.dispose()
  }
}, 60_000)

it('releases finished Loop copies while preserving live ownership, dirty work and saved commits', async () => {
  const f = await fixture()
  try {
    const clean = await addOccurrence(f, 'completed')
    const dirty = await addOccurrence(f, 'completed')
    const live = await addOccurrence(f, 'running')
    const settling = await addOccurrence(f, 'completed', false)
    await writeFile(join(clean.workingDirectory, 'result.txt'), 'saved result\n')
    git(clean.workingDirectory, 'add', '.')
    git(clean.workingDirectory, 'commit', '-qm', 'Save result')
    const savedCommit = git(clean.workingDirectory, 'rev-parse', 'HEAD')
    await writeFile(join(dirty.workingDirectory, 'uncommitted.txt'), 'preserve this work\n')
    const reserve = () => new PostgresSourceReservations().reserve(f.pool, {
      scopeId: 'source-filesystem', ownerKind: 'materialization', ownerId: randomUUID(), reservedBytes: 4096,
    }, { capacity: sourceStorageCapacityFixture() })
    await expect(reserve()).rejects.toMatchObject({ code: 'SOURCE_CAPACITY', details: {
      exhausted: ['materializations'], usage: { activeMaterializations: 4 },
    } })
    await expect(f.sources.confirmClosed(live.record)).rejects.toMatchObject({ code: 'SOURCE_EXECUTION_UNCERTAIN' })
    const report = (error: unknown): never => { throw error }
    await closeCompletedWorkflowSources(f.pool, f.sources, report)
    const rows = (await f.pool.query(`select m.execution_id,m.state,m.worktree_cleanup,s.state as reservation_state
      from source_execution_materializations m join source_storage_reservations s using(reservation_id)`)).rows
    expect(rows.find(row => row.execution_id === clean.record.receipt.executionId))
      .toMatchObject({ state: 'closed', reservation_state: 'retained', worktree_cleanup: { state: 'removed' } })
    expect(rows.find(row => row.execution_id === dirty.record.receipt.executionId))
      .toMatchObject({ state: 'closed', reservation_state: 'retained', worktree_cleanup: { state: 'retained' } })
    for (const active of [live, settling]) {
      expect(rows.find(row => row.execution_id === active.record.receipt.executionId))
        .toMatchObject({ state: 'prepared', reservation_state: 'owned' })
      expect(await readFile(join(active.workingDirectory, f.manifest.entries[0]!.path))).toEqual(f.bytes)
    }
    await expect(stat(clean.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(git(f.ports.cloneDirectory('fixture/project'), 'rev-parse', clean.record.receipt.worktree!.branch))
      .toBe(savedCommit)
    expect(await readFile(join(dirty.workingDirectory, 'uncommitted.txt'), 'utf8')).toBe('preserve this work\n')
    await expect(reserve()).rejects.toMatchObject({ details: { usage: { activeMaterializations: 2 } } })
    await f.pool.query('update execution_native_closures set closed_at=clock_timestamp() where execution_id=$1',
      [settling.record.receipt.executionId])
    await f.pool.query('update execution_native_sessions set workflow_finalized_at=clock_timestamp() where execution_id=$1',
      [settling.record.receipt.executionId])
    git(dirty.workingDirectory, 'add', '.')
    git(dirty.workingDirectory, 'commit', '-qm', 'Save retained work')
    const retainedCommit = git(dirty.workingDirectory, 'rev-parse', 'HEAD')
    // Reproduce a close that released its reference but never finished worktree cleanup.
    await f.pool.query('update source_execution_materializations set worktree_cleanup=null where materialization_id=$1',
      [dirty.record.receipt.materializationId])
    await closeCompletedWorkflowSources(f.pool, f.sources, report)
    await expect(stat(dirty.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(git(f.ports.cloneDirectory('fixture/project'), 'rev-parse', dirty.record.receipt.worktree!.branch))
      .toBe(retainedCommit)
    expect((await f.pool.query('select execution_state from runs')).rows[0].execution_state).toBe('running')
    const retained = (await f.pool.query('select record,reserved_bytes from source_storage_reservations where reservation_id=$1',
      [dirty.reservation.reservationId])).rows[0]
    expect(retained.record.referenceReclaimed).toBe(true)
    expect(Number(retained.reserved_bytes)).toBeLessThan(dirty.reservation.reservedBytes)
    await expect(reserve()).resolves.toHaveProperty('reservationId')
  } finally {
    await f.dispose()
  }
}, 60_000)

it('retires previously closed Worker references while the Loop Run continues and preserves execution history', async () => {
  const f = await fixture('device')
  try {
    await f.pool.query(`
      create table remote_execution_receipts (operation_id text, receipt jsonb);
      create table execution_dispatch_intents (operation_id text, execution_id text)`)
    const copy = await addOccurrence(f, 'completed')
    const receipt = copy.record.receipt
    await archiveMaterializationClaim(receipt, { filesystem: f.binding.filesystem }, async () => 'released')
    const worktree = await closeSourceWorktree(receipt, AbortSignal.timeout(30_000), f.ports)
    expect(worktree).toMatchObject({ state: 'removed' })
    const footprint = await measureRetainedMaterializationFootprint(receipt)
    await new PostgresSourceReservations().retainMaterialization(f.pool, copy.reservation,
      { ...footprint, retainedBytes: footprint.retainedBytes + 16 * 1024 })
    await f.pool.query(`update source_execution_materializations set state='closed',worktree_cleanup=$2
      where materialization_id=$1`, [receipt.materializationId, worktree])
    const live = await addOccurrence(f, 'running')
    const settling = await addOccurrence(f, 'completed', false)
    const history = (await f.pool.query('select record from harness_executions order by id')).rows
    await expect(f.sources.confirmClosed(live.record)).rejects.toMatchObject({ code: 'SOURCE_EXECUTION_UNCERTAIN' })
    await closeCompletedWorkflowSources(f.pool, f.sources, error => { throw error })
    await expect(stat(join(f.binding.canonicalPath, receipt.materializationId, 'tree')))
      .rejects.toMatchObject({ code: 'ENOENT' })
    const retained = (await f.pool.query('select record,reserved_bytes from source_storage_reservations where reservation_id=$1',
      [copy.reservation.reservationId])).rows[0]
    expect(retained.record.referenceReclaimed).toBe(true)
    expect(Number(retained.reserved_bytes)).toBeLessThan(footprint.retainedBytes + 16 * 1024)
    const sourcePath = f.manifest.entries[0]!.path
    for (const active of [live, settling]) {
      expect(await readFile(join(active.workingDirectory, sourcePath))).toEqual(f.bytes)
      expect(await readFile(join(f.binding.canonicalPath, active.record.receipt.materializationId, 'tree', sourcePath)))
        .toEqual(f.bytes)
    }
    expect((await f.pool.query('select execution_state from runs')).rows).toEqual([{ execution_state: 'running' }])
    expect((await f.pool.query('select record from harness_executions order by id')).rows).toEqual(history)
    await closeCompletedWorkflowSources(f.pool, f.sources, error => { throw error })
    expect((await f.pool.query('select record,reserved_bytes from source_storage_reservations where reservation_id=$1',
      [copy.reservation.reservationId])).rows[0]).toEqual(retained)
  } finally { await f.dispose() }
}, 60_000)

it('visits later cleanup candidates after more than one page of persistent retained worktrees', async () => {
  const f = await fixture()
  try {
    const original = await addOccurrence(f, 'completed')
    const live = await addOccurrence(f, 'running')
    const reclaimed = await addOccurrence(f, 'completed')
    await f.pool.query("update source_execution_materializations set state='closed' where materialization_id=$1",
      [reclaimed.record.receipt.materializationId])
    await f.pool.query("update source_storage_reservations set state='reclaimed' where reservation_id=$1",
      [reclaimed.reservation.reservationId])
    const count = 105
    for (let index = 0; index < count; index++) {
      const materializationId = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
      const record = SourceMaterializationRecordSchema.parse({ ...original.record,
        receipt: { ...original.record.receipt, materializationId }, reservationId: randomUUID(), operationId: randomUUID() })
      const reservation = { ...original.reservation, reservationId: record.reservationId, ownerId: record.operationId,
        referenceReclaimed: true }
      await f.pool.query('insert into source_storage_reservations values($1,$2,$3,$4,$5,$6,$7)',
        [reservation.reservationId, reservation.scopeId, reservation.ownerKind, reservation.ownerId,
          reservation.reservedBytes, 'retained', reservation])
      await f.pool.query('insert into source_execution_materializations values($1,$2,$3,$4,$5,$6)',
        [materializationId, original.record.receipt.executionId, reservation.reservationId, record, 'closed',
          { state: 'retained', message: 'Uncommitted changes remain in this worktree.' }])
    }
    const visited: string[] = []
    await closeCompletedWorkflowSources(f.pool, { async confirmClosed(record) {
      visited.push(record.receipt.materializationId)
    } }, error => { throw error })
    expect(visited[0]).toBe(original.record.receipt.materializationId)
    expect(new Set(visited).size).toBe(count + 1)
    expect(visited).not.toContain(live.record.receipt.materializationId)
    expect(visited).not.toContain(reclaimed.record.receipt.materializationId)
    expect(visited.at(-1)).toBe(`00000000-0000-4000-8000-${(count - 1).toString(16).padStart(12, '0')}`)
    expect((await f.pool.query("select count(*) from source_storage_reservations where state='retained'")).rows[0].count)
      .toBe(String(count))
  } finally {
    await f.dispose()
  }
}, 60_000)


it('cleans reconciled sessionless worktrees only after positive closure and retries dirty copies', async () => {
  const f = await fixture()
  try {
    const clean = await addOccurrence(f, 'completed')
    const dirty = await addOccurrence(f, 'completed')
    const live = await addOccurrence(f, 'running')
    await writeFile(join(dirty.workingDirectory, 'unfinished.txt'), 'keep this work')
    for (const copy of [clean, dirty]) {
      const executionId = copy.record.receipt.executionId
      await f.pool.query("update harness_executions set record=(record-'nativeSessionId') || $2::jsonb where id=$1",
        [executionId, { result: { outcome: 'canceled' } }])
      await f.pool.query('delete from execution_native_sessions where execution_id=$1', [executionId])
      await f.pool.query(`update execution_native_closures set expected_reference=null,closed_reference=null,
        closed_without_session=true where execution_id=$1`, [executionId])
      const receipt = copy.record.receipt
      const owner: SourceOperationOwner = { identity: { operationId: copy.record.operationId,
        ownerPrincipalId: 'operator', expiresAt: new Date(Date.now() + 300_000).toISOString() },
        root: f.root, source: f.root.source, attempt: { executionId, attemptId: receipt.attemptId,
          placementHash: receipt.placementHash, keyRevision: null, authorizationRevision: null },
        record: copy.record, physicalClosureConfirmed: false, preparationClosed: true }
      const cleanupPorts = {
        authorize: async () => {}, operationClosed: async () => true,
        nativeClosed: () => localWorkflowSourceClosed(f.pool, executionId), git: f.ports,
      }
      const result = await reclaimSourceReservation({ reservationId: copy.reservation.reservationId,
        reclamationId: randomUUID(), operationId: copy.record.operationId, scopeId: copy.reservation.scopeId,
        expiresAt: owner.identity.expiresAt, roots: [f.root], owner }, cleanupPorts, AbortSignal.timeout(60_000))
      expect(result.closures).toEqual([expect.objectContaining({ childrenClosed: true, claimReleased: true })])
      expect(result.retained).toBeDefined()
      await new PostgresSourceReservations().retainMaterialization(f.pool, copy.reservation,
        { ...result.retained!, retainedBytes: result.retained!.retainedBytes + 16 * 1024 })
      await f.pool.query("update source_execution_materializations set state='closed',worktree_cleanup=$2 where materialization_id=$1",
        [receipt.materializationId, result.retained!.worktree ?? null])
      await f.pool.query('insert into source_preparation_reconciliations values($1,$2)', [copy.record.operationId, 'closed'])
    }
    await closeCompletedWorkflowSources(f.pool, f.sources, error => { throw error })
    await expect(stat(clean.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(dirty.workingDirectory, 'unfinished.txt'), 'utf8')).toBe('keep this work')
    const cleanupRows = (await f.pool.query(`select m.execution_id,m.state,m.worktree_cleanup,
      s.state as reservation_state
      from source_execution_materializations m join source_storage_reservations s using(reservation_id)`)).rows
    expect(cleanupRows.find(row => row.execution_id === clean.record.receipt.executionId))
      .toMatchObject({ state: 'closed', reservation_state: 'retained', worktree_cleanup: { state: 'removed' } })
    expect(cleanupRows.find(row => row.execution_id === dirty.record.receipt.executionId))
      .toMatchObject({ state: 'closed', reservation_state: 'retained', worktree_cleanup: { state: 'retained' } })
    expect(cleanupRows.find(row => row.execution_id === live.record.receipt.executionId))
      .toMatchObject({ state: 'prepared', reservation_state: 'owned', worktree_cleanup: null })
    git(dirty.workingDirectory, 'add', '.')
    git(dirty.workingDirectory, 'commit', '-qm', 'Retain result')
    const resultCommit = git(dirty.workingDirectory, 'rev-parse', 'HEAD')
    await closeCompletedWorkflowSources(f.pool, f.sources, error => { throw error })
    expect(await stat(dirty.workingDirectory)).toBeDefined()
    const nextAttemptAt = cleanupRows.find(row => row.execution_id === dirty.record.receipt.executionId)
      .worktree_cleanup.nextAttemptAt as string
    expect(Date.parse(nextAttemptAt)).toBeGreaterThan(Date.now())
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(nextAttemptAt))
    try {
      await closeCompletedWorkflowSources(f.pool, f.sources, error => { throw error })
    } finally {
      clock.mockRestore()
    }
    await expect(stat(dirty.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(git(f.ports.cloneDirectory('fixture/project'), 'rev-parse', dirty.record.receipt.worktree!.branch))
      .toBe(resultCommit)
    expect(await readFile(join(live.workingDirectory, f.manifest.entries[0]!.path))).toEqual(f.bytes)
    const stored = (await f.pool.query('select worktree_cleanup from source_execution_materializations where materialization_id=$1',
      [dirty.record.receipt.materializationId])).rows[0]
    expect(stored.worktree_cleanup).toEqual({ state: 'removed' })
  } finally {
    await f.dispose()
  }
}, 60_000)
