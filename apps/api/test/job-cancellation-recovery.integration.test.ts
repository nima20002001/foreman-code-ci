import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { SourceMaterializationRecordSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { JobRuntimeProfileSchema } from '@foreman-code/contracts/job-runtime'
import { jobSpecDigests } from '@foreman-code/contracts/jobs-node'
import { jobCancellationGrantMessage, jobCancellationClosureMessage,
  SignedJobCancellationGrantSchema, JobCancellationRecoveryReadSchema, type JobCancellationRecoveryRead } from '@foreman-code/contracts/job-cancellation-recovery'
import { RemoteJobDispatchIntentSchema } from '@foreman-code/contracts/remote-job-execution'
import { publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../src/modules/access/localHuman.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresJobCancellationRecovery } from '../src/modules/jobs/cancellationRecovery.js'
import { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import { JobService } from '../src/modules/jobs/service.js'
import { projectJobReceiptLocked } from '../src/modules/jobs/receiptProjection.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { loadOrCreateMainDeviceIdentity } from '../src/modules/devices/mainIdentity.js'
import { assertDeviceHostInstallation } from '../src/modules/devices/hostAuthorization.js'
import { createSourceManifest, sourceSha256 } from '../src/modules/sources/manifest.js'
import { sourceBindingHash, sourceMaterializationDigest } from '../src/modules/sources/bindingHash.js'
import { PrivateSourceMaterializer, releaseMaterializationClaim } from '../src/modules/sources/materialization.js'
import { openPrivateRoot, identity } from '../src/modules/sources/privateFilesystem.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { agent3Database } from './helpers/wave25Agent3.js'
import { jobExecution, jobSpec } from './helpers/jobFixture.js'

// Real PostgreSQL, authenticated HTTP/MCP, Ed25519 signatures, durable journal,
// and a protected filesystem claim. This is not a laptop/OCI acceptance run.
describe('approved cancellation recovery of a revoked original Worker', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let app: ReturnType<typeof buildApp>, address: string, directory: string, dispatch: PostgresJobDispatch
  let writer: Awaited<ReturnType<PostgresAccessService['issue']>>, reader: typeof writer
  let client: Client, deniedClient: Client
  const approvalCommandId = randomUUID()
  let proposal: JobCancellationRecoveryRead
  let apply: { recoveryId: string; closure: { closure: { schemaVersion: 1; grantId: string;
    receipt: Awaited<ReturnType<RemoteOperationJournal['jobCancelBeforeEntry']>>;
    sourceClaim: { materializationId: string; reservationId: string; released: true; archiveSha256: string } };
    signature: string } }
  const execution = jobExecution(), workspaceId = randomUUID(), keys = generateKeyPairSync('ed25519')
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  let reservationId: string, throwAfterProjection = false
  const ordinaryTransport = vi.fn(async (): Promise<never> => { throw new Error('Revoked worker transport is unavailable') })
  const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
  beforeAll(async () => {
    database = await agent3Database()
    directory = await mkdtemp(`${process.env.FOREMAN_CODE_TEST_ROOT}/job-revoked-cancellation-`)
    const pool = database.pool
    const mainId = (await pool.query<{ id: string }>('select id from application_installation where singleton=true')).rows[0]!.id
    await loadOrCreateMainDeviceIdentity(pool, mainId)
    const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
    await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Revoked Job cleanup fixture' })])
    writer = await access.issue({ name: 'Cleanup caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 3600000), grants: [{ actions: ['job_definitions:read', 'job_definitions:write',
        'jobs:read', 'jobs:start', 'jobs:cancel'], scope: { workspaceIds: [workspaceId] } }] })
    reader = await access.issue({ name: 'Read only Job caller', audience: 'operator', expiresAt: new Date(Date.now() + 3600000),
      grants: [{ actions: ['jobs:read'], scope: { workspaceIds: [workspaceId] } }] })
    const deviceId = randomUUID(), workerInstallationId = randomUUID(), policyId = randomUUID()
    const registration = { mainId, deviceId, workerInstallationId, keyRevision: 1, authorizationRevision: 2,
      publicKeyFingerprint: publicKeyFingerprint(publicKey), status: 'revoked', scopes: ['connect', 'heartbeat'] }
    await pool.query('insert into device_registrations(id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,$4,$5::jsonb)',
      [deviceId, mainId, workerInstallationId, publicKey, JSON.stringify(registration)])
    const runtime = join(directory, 'runtime'), namespace = join(runtime, 'source-materializations', policyId)
    await mkdir(namespace, { recursive: true, mode: 0o700 })
    const handle = await openPrivateRoot(namespace), filesystem = await identity(handle)
    await handle.close()
    const bytes = Buffer.from('immutable original source\n')
    const manifest = createSourceManifest({ version: 1, snapshotId: randomUUID(), approvedSourceId: randomUUID(),
      capturePolicy: 'git-tree-v1', git: { commit: '2'.repeat(40), tree: '3'.repeat(40), objectFormat: 'sha1' },
      executablePolicy: 'strip', deletions: [], entries: [{ path: 'source.txt', kind: 'file', byteSize: bytes.length,
        sha256: sourceSha256(bytes), executable: false }] })
    const spec = jobSpec()
    Object.assign(execution, { id: randomUUID(), workspaceId, attemptId: randomUUID(), operationId: randomUUID() })
    spec.source = { approvedSourceId: manifest.approvedSourceId, snapshotId: manifest.snapshotId,
      manifestDigest: manifest.manifestDigest, commit: manifest.git!.commit }
    spec.target = { ...spec.target, mainId, mainInstallationId: mainId, hostRef: { kind: 'device', mainId, deviceId },
      registration: { workerInstallationId, keyRevision: 1, authorizationRevision: 1 },
      destination: { ...spec.target.destination, canonicalProjectRoot: namespace, canonicalCwd: namespace,
        managedRuntimeRoot: runtime, rootPolicyId: policyId, attestationId: randomUUID() } }
    const root = SourceRootRecordSchema.parse({ version: 1, source: { approvedSourceId: manifest.approvedSourceId,
      snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest },
      selection: { hostRef: spec.target.hostRef, rootPolicyId: policyId, rootPolicyRevision: '1', locationRevision: '1' },
      binding: { version: 1, mainId, deviceId, workerInstallationId, workspaceId, rootId: randomUUID(), bindingRevision: 1,
        locationRevision: 1, canonicalPath: namespace, filesystem, accessMode: 'exclusive-write',
        snapshotId: manifest.snapshotId, manifestDigest: manifest.manifestDigest }, registration: spec.target.registration,
      ownerPrincipalId: writer.principal.id, authorizedByPrincipalId: writer.principal.id,
      attestationId: spec.target.destination.attestationId, attestationDigest: spec.target.destination.attestationHash,
      boundAt: new Date().toISOString() })
    const attempt = { executionId: execution.id, attemptId: execution.attemptId, keyRevision: 1, authorizationRevision: 1,
      placementHash: '0'.repeat(64) }
    attempt.placementHash = sourceBindingHash(root, attempt, execution.operationId)
    const materializer = new PrivateSourceMaterializer({ read: async () => bytes }, async () => {})
    const receipt = await materializer.prepare({ manifest, binding: root.binding, attempt })
    reservationId = randomUUID()
    const materialization = SourceMaterializationRecordSchema.parse({ receipt, rootPolicyId: policyId, rootPolicyRevision: '1',
      operationId: execution.operationId, reservationId, sourceBindingHash: attempt.placementHash,
      finalDispatchBindingHash: null, state: 'prepared' })
    spec.target.destination.canonicalProjectRoot = join(namespace, receipt.materializationId, 'tree')
    spec.target.destination.canonicalCwd = spec.target.destination.canonicalProjectRoot
    spec.target.destination.directoryIdentityHash = sha(JSON.stringify(receipt.localTreeIdentity))
    spec.policy.isolationPolicyId = randomUUID()
    execution.acceptedSpec = { ...spec, workflowInput: null,
      source: { ...spec.source, materializationId: receipt.materializationId,
        materializationDigest: sourceMaterializationDigest(materialization) },
      definitionId: randomUUID(), definitionVersionId: randomUUID(), definitionRevision: 1,
      ...jobSpecDigests({ ...spec, source: { ...spec.source, materializationId: receipt.materializationId,
        materializationDigest: sourceMaterializationDigest(materialization) } }, null) }
    materialization.finalDispatchBindingHash = execution.acceptedSpec.bindingHash
    const now = new Date().toISOString()
    execution.createdAt = now; execution.updatedAt = now; execution.cancelRequestedAt = now
    const definition = { schemaVersion: 1, id: execution.acceptedSpec.definitionId, workspaceId,
      versionId: execution.acceptedSpec.definitionVersionId, revision: 1, name: 'Original Job', spec, createdAt: now, updatedAt: now }
    await pool.query('insert into job_definitions(id,workspace_id,revision,version_id,record,updated_by) values($1,$2,1,$3,$4::jsonb,$5)',
      [definition.id, workspaceId, definition.versionId, JSON.stringify(definition), writer.principal.id])
    await pool.query('insert into job_definition_versions(id,definition_id,workspace_id,revision,record) values($1,$2,$3,1,$4::jsonb)',
      [definition.versionId, definition.id, workspaceId, JSON.stringify(definition)])
    await pool.query('insert into job_executions(id,workspace_id,definition_version_id,operation_id,attempt_id,record,accepted_spec,accepted_by) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)',
      [execution.id, workspaceId, definition.versionId, execution.operationId, execution.attemptId,
        JSON.stringify(execution), JSON.stringify(execution.acceptedSpec), writer.principal.id])
    const intent = RemoteJobDispatchIntentSchema.parse({ schemaVersion: 1, protocolVersion: 1, mainId,
      executionId: execution.id, operationId: execution.operationId, attemptId: execution.attemptId,
      bindingHash: execution.acceptedSpec.bindingHash, inputDigest: `sha256:${execution.acceptedSpec.specDigest}`,
      owner: execution.owner, subject: { kind: 'manual-job', workspaceId, jobExecutionId: execution.id, definitionId: definition.id } })
    const cancelCommandId = randomUUID()
    await pool.query("insert into job_dispatch_intents(execution_id,workspace_id,intent,delivery_attempted,cancel_command_id,cancel_principal_id,cancel_action) values($1,$2,$3::jsonb,true,$4,$5,'jobs:cancel')",
      [execution.id, workspaceId, JSON.stringify(intent), cancelCommandId, writer.principal.id])
    await pool.query("insert into source_approvals(approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request) values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')",
      [manifest.approvedSourceId, manifest.snapshotId, workspaceId, writer.principal.id, randomUUID(), '1'.repeat(64)])
    await pool.query('insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record) values($1,$2,$3,$4,$5::jsonb)',
      [manifest.snapshotId, manifest.approvedSourceId, workspaceId, manifest.manifestDigest, JSON.stringify({ version: 1,
        workspaceId, ownerPrincipalId: writer.principal.id, approvedByPrincipalId: writer.principal.id, locationRevision: 1,
        mainId, originIdentityHash: `sha256:${'1'.repeat(64)}`, manifest, approvedAt: now, availability: 'retained' })])
    await pool.query('insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision) values($1,$2,$3,1)',
      [root.binding.rootId, workspaceId, randomUUID()])
    await pool.query('insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record) values($1,1,$2,$3,$4::jsonb)',
      [root.binding.rootId, workspaceId, manifest.snapshotId, JSON.stringify(root)])
    const profile = JobRuntimeProfileSchema.parse({ schemaVersion: 1, id: spec.policy.isolationPolicyId, workspaceId,
      revision: 1, name: 'Original runtime metadata', root, policy: spec.policy,
      limits: { cpuLimit: 1, memoryBytes: 1024, pidsLimit: 16, diskBytes: 1048576 }, specDigest: '1'.repeat(64),
      status: 'unqualified', measurement: null, createdAt: now, updatedAt: now })
    await pool.query('insert into job_runtime_profiles(id,workspace_id,revision,root_id,binding_revision,record) values($1,$2,1,$3,1,$4::jsonb)',
      [profile.id, workspaceId, root.binding.rootId, JSON.stringify(profile)])
    await pool.query('insert into job_runtime_profile_versions(profile_id,revision,record) values($1,1,$2::jsonb)', [profile.id, JSON.stringify(profile)])
    const reservation = { reservationId, scopeId: `${mainId}:${deviceId}:${workerInstallationId}:${filesystem.device}:${filesystem.mountId}`,
      ownerKind: 'materialization', ownerId: execution.operationId, reservedBytes: bytes.length }
    await pool.query("insert into source_storage_reservations(reservation_id,scope_id,owner_kind,owner_id,reserved_bytes,state,record) values($1,$2,'materialization',$3,$4,'owned',$5::jsonb)",
      [reservationId, reservation.scopeId, execution.operationId, bytes.length, JSON.stringify(reservation)])
    await pool.query("insert into source_execution_materializations(materialization_id,workspace_id,execution_id,attempt_id,operation_id,reservation_id,root_id,binding_revision,record,state) values($1,$2,$3,$4,$5,$6,$7,1,$8::jsonb,'prepared')",
      [receipt.materializationId, workspaceId, execution.id, execution.attemptId, execution.operationId, reservationId, root.binding.rootId, JSON.stringify(materialization)])
    dispatch = new PostgresJobDispatch(pool, { deliver: ordinaryTransport, reconcile: ordinaryTransport, control: ordinaryTransport }, {
      revalidate: async sql => { await assertDeviceHostInstallation(sql, spec.target.hostRef, workerInstallationId) },
      authorizeControl: async sql => { await assertDeviceHostInstallation(sql, spec.target.hostRef, workerInstallationId) },
      observe: async (sql, original, observed) => {
        await projectJobReceiptLocked(sql, original, observed, { verifyRequiredOutputs: async () => {} })
        if (throwAfterProjection) throw new Error('Injected SQL projection failure')
      },
    }, new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }))
    const recovery = new PostgresJobCancellationRecovery(pool, commands, dispatch)
    const forbidden = async (): Promise<never> => { throw new Error('No execution, copy or publication authorized') }
    const jobs = new JobService(pool, commands, { dispatch, cancellationRecovery: recovery,
      preparation: { choices: forbidden, validate: forbidden, accept: forbidden, adoptFinalBinding: forbidden, revalidateAccepted: forbidden },
      artifacts: { list: forbidden, read: forbidden } })
    app = buildApp({ readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      localHuman: new PostgresLocalHumanAccess(pool, access),
      operator: { access, services: { jobs, commands } as unknown as OperatorServices } })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
    const connect = async (token: string) => {
      const connected = new Client({ name: 'revoked-job-cleanup', version: '1' })
      await connected.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), { authProvider: { token: async () => token } }))
      return connected
    }
    client = await connect(writer.token); deniedClient = await connect(reader.token)
    const journal = await RemoteOperationJournal.open(join(directory, 'original-journal'), { initializeNewInstallation: true })
    try {
      const result = await client.callTool({ name: 'job_cancellation_recovery_propose', arguments: {
        workspaceId, executionId: execution.id, commandId: randomUUID(), journalSha256: sha(await readFile(join(directory, 'original-journal'))) } })
      expect(result.isError).not.toBe(true)
      proposal = JobCancellationRecoveryReadSchema.parse(decodeMcpToolResult(result))
      const approved = await client.callTool({ name: 'job_cancellation_recovery_approve', arguments: {
        workspaceId, executionId: execution.id, recoveryId: proposal.id, commandId: approvalCommandId } })
      expect(approved.isError).not.toBe(true)
      const signed = SignedJobCancellationGrantSchema.parse(decodeMcpToolResult(approved))
      const repeated = await client.callTool({ name: 'job_cancellation_recovery_approve', arguments: {
        workspaceId, executionId: execution.id, recoveryId: proposal.id, commandId: approvalCommandId } })
      expect(decodeMcpToolResult(repeated)).toEqual(signed)
      const persisted = await client.callTool({ name: 'job_cancellation_recovery_get', arguments: {
        workspaceId, executionId: execution.id, recoveryId: proposal.id } })
      expect(decodeMcpToolResult(persisted)).toMatchObject({ state: 'approved', grant: signed })
      const grant = signed.grant
      const command = { schemaVersion: 1 as const, protocolVersion: 1 as const, commandId: cancelCommandId,
        operationId: execution.operationId, attemptId: execution.attemptId, executionId: execution.id,
        bindingHash: intent.bindingHash, subject: intent.subject, owner: intent.owner, action: { kind: 'stop' as const } }
      await journal.jobCancelBeforeEntry(intent, execution, { mainId, deviceId, workerInstallationId, keyRevision: 1,
        authorizationRevision: 1, bootId: randomUUID(), connectionGeneration: 1 }, randomUUID(), command,
      { outcome: 'cancelled', exitCode: null, signal: null, processStopped: true, finishedAt: new Date().toISOString(),
        closureEvidenceDigest: sha(jobCancellationGrantMessage(grant)), resultDigest: '1'.repeat(64),
        logGapPossible: false, logsTruncated: false, outputCollectionError: false, artifactDigests: [] })
      const closed = await journal.jobPublication(execution.operationId, 'complete')
      await releaseMaterializationClaim(receipt, async () => 'released')
      const closure = { schemaVersion: 1 as const, grantId: grant.id, receipt: closed,
        sourceClaim: { materializationId: receipt.materializationId, reservationId, released: true as const,
          archiveSha256: sha(await readFile(join(namespace, receipt.materializationId, 'released-claim.json'))) } }
      apply = { recoveryId: proposal.id, closure: { closure,
        signature: sign(null, Buffer.from(jobCancellationClosureMessage(closure)), keys.privateKey).toString('base64url') } }
    } finally { await journal.close() }
  }, 90000)
  afterAll(async () => {
    await client?.close(); await deniedClient?.close(); await app?.close(); await dispatch?.close()
    await database?.close(); if (directory) await removeFixtureDirectory(directory)
  })
  function route() { return `/api/management/workspaces/${workspaceId}/jobs/executions/${execution.id}/cancellation-recovery/${proposal.id}` }
  async function importClosure(override = apply, caller = client, commandId = randomUUID()) {
    return caller.callTool({ name: 'job_cancel', arguments: { workspaceId, executionId: execution.id,
      commandId, recovery: override } })
  }
  async function state() {
    return (await database.pool.query(`select e.record,d.last_receipt,r.state from job_executions e
      join job_dispatch_intents d on d.execution_id=e.id cross join source_storage_reservations r
      where e.id=$1 and r.reservation_id=$2`, [execution.id, reservationId])).rows[0]!
  }
  it('denies read-only and out-of-scope cleanup while allowing an authorized bearer retry', async () => {
    const denied = await importClosure(apply, deniedClient)
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    const bearer = await app.inject({ method: 'POST', url: `${route()}/approve`,
      headers: { authorization: `Bearer ${writer.token}` }, payload: { commandId: approvalCommandId } })
    expect(bearer.statusCode).toBe(200)
    const deniedApproval = await deniedClient.callTool({ name: 'job_cancellation_recovery_approve', arguments: {
      workspaceId, executionId: execution.id, recoveryId: proposal.id, commandId: randomUUID() } })
    expect(deniedApproval.isError).toBe(true)
    expect(JSON.stringify(deniedApproval.content)).toContain('ACCESS_DENIED')
    const wrongScope = await client.callTool({ name: 'job_cancellation_recovery_approve', arguments: {
      workspaceId: randomUUID(), executionId: execution.id, recoveryId: proposal.id, commandId: randomUUID() } })
    expect(wrongScope.isError).toBe(true)
    expect(JSON.stringify(wrongScope.content)).toContain('ACCESS_DENIED')
    const sql = await database.pool.connect()
    try { await expect(assertDeviceHostInstallation(sql, execution.acceptedSpec.target.hostRef,
      execution.acceptedSpec.target.registration!.workerInstallationId)).rejects.toMatchObject({ code: 'revoked' }) }
    finally { sql.release() }
    expect(ordinaryTransport).not.toHaveBeenCalled()
    expect(await state()).toMatchObject({ state: 'owned', last_receipt: null, record: { process: { processStopped: false } } })
  })
  it('rejects changed source-claim pins and expired cleanup authorization without changing Main', async () => {
    const changed = structuredClone(apply)
    changed.closure.closure.sourceClaim.reservationId = randomUUID()
    changed.closure.signature = sign(null, Buffer.from(jobCancellationClosureMessage(changed.closure.closure)),
      keys.privateKey).toString('base64url')
    const mismatch = await importClosure(changed)
    expect(mismatch.isError).toBe(true)
    expect(JSON.stringify(mismatch.content)).toContain('source-claim closure is invalid')
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 360000)
    try {
      const expired = await importClosure()
      expect(expired.isError).toBe(true)
      expect(JSON.stringify(expired.content)).toContain('expired')
    } finally { clock.mockRestore() }
    expect(await state()).toMatchObject({ state: 'owned', last_receipt: null, record: { process: { processStopped: false } } })
  })
  it('denies a revoked Worker signature without a matching fresh cleanup authorization', async () => {
    const pending = await client.callTool({ name: 'job_cancellation_recovery_propose', arguments: {
      workspaceId, executionId: execution.id, commandId: randomUUID(), journalSha256: proposal.journalSha256 } })
    expect(pending.isError).not.toBe(true)
    const unapproved = JobCancellationRecoveryReadSchema.parse(decodeMcpToolResult(pending))
    const changed = structuredClone(apply)
    changed.recoveryId = unapproved.id
    changed.closure.closure.grantId = unapproved.id
    changed.closure.signature = sign(null, Buffer.from(jobCancellationClosureMessage(changed.closure.closure)),
      keys.privateKey).toString('base64url')
    const denied = await importClosure(changed)
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('fresh cleanup authorization')
    expect(await state()).toMatchObject({ state: 'owned', last_receipt: null, record: { process: { processStopped: false } } })
  })
  it('rechecks the approved caller grant before importing any signed closure', async () => {
    await database.pool.query('update management_principals set grants=$2::jsonb where id=$1',
      [writer.principal.id, JSON.stringify([{ actions: ['jobs:read'], scope: { workspaceIds: [workspaceId] } }])])
    try {
      const denied = await importClosure()
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    } finally {
      await database.pool.query('update management_principals set grants=$2::jsonb where id=$1',
        [writer.principal.id, JSON.stringify(writer.principal.grants)])
    }
    expect(await state()).toMatchObject({ state: 'owned', last_receipt: null, record: { process: { processStopped: false } } })
  })
  it('rolls back Job closure, signed import receipt and resource release if projection fails', async () => {
    throwAfterProjection = true
    try { expect((await importClosure()).isError).toBe(true) } finally { throwAfterProjection = false }
    expect(await state()).toMatchObject({ state: 'owned', last_receipt: null, record: { process: { processStopped: false } } })
    expect((await database.pool.query("select 1 from management_command_receipts where operation='job.cancellation-recovery.import'" )).rows).toEqual([])
  })
  it('imports the approved original closure atomically and replays only the same command and proof', async () => {
    const commandId = randomUUID()
    const result = await importClosure(apply, client, commandId)
    expect(result.isError).not.toBe(true)
    expect(decodeMcpToolResult(result)).toMatchObject({ execution: { id: execution.id, operationId: execution.operationId,
      acceptedSpec: execution.acceptedSpec, transport: 'unknown', process: { phase: 'terminal', outcome: 'cancelled', processStopped: true } } })
    expect(decodeMcpToolResult((await importClosure(apply, client, commandId)))).toEqual(decodeMcpToolResult(result))
    expect((await importClosure(apply, client, randomUUID())).isError).toBe(true)
    expect(await state()).toMatchObject({ state: 'retained', record: { process: { processStopped: true } } })
    const get = await client.callTool({ name: 'job_get', arguments: { workspaceId, executionId: execution.id } })
    expect(decodeMcpToolResult(get)).toEqual(decodeMcpToolResult(result))
    const persisted = await client.callTool({ name: 'job_cancellation_recovery_get', arguments: {
      workspaceId, executionId: execution.id, recoveryId: proposal.id } })
    expect(decodeMcpToolResult(persisted)).toMatchObject({ state: 'consumed', closure: apply.closure })
    expect(ordinaryTransport).not.toHaveBeenCalled()
  })
})
