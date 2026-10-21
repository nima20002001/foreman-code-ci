import { beginTransaction, rollbackTransaction } from '../src/infrastructure/transaction.js'
import { sourceStorageCapacityFixture } from './helpers/sourceStorageCapacityFixture.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import type { SourceQuotaPool } from '../src/modules/sources/materialization.js'
import { readdir, open } from 'node:fs/promises'
import { verificationRuntimeFixture } from './helpers/verificationRuntimeFixture.js'
import { JobVerificationProfileSchema, JobVerificationRuntimeMeasurementSchema, JobRuntimeApprovalRecordSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import { jobDigest } from '../src/modules/jobs/service.js'
import { JobVerificationPolicyRequirementsSchema } from '@foreman-code/contracts/job-verification-policy'
import { removeFixtureDirectory } from './helpers/testResources.js'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import pino from 'pino'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { SourceFilesystemOperationSchema } from '@foreman-code/contracts/source-operations'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { JobService } from '../src/modules/jobs/service.js'
import { WorkerExecutionPolicy } from '../src/modules/settings/workerExecution.js'
import { PostgresSourceService } from '../src/modules/sources/service.js'
import { PostgresSourceReservations } from '../src/modules/sources/reservations.js'
import { PrivateSourceSnapshotStore } from '../src/modules/sources/store.js'
import { PrivateSourceMaterializer } from '../src/modules/sources/materialization.js'
import { sourceBindingHash } from '../src/modules/sources/bindingHash.js'
import { createSourceManifest, sourceSha256 } from '../src/modules/sources/manifest.js'
import { openPrivateRoot, identity } from '../src/modules/sources/privateFilesystem.js'
import { qualifyApprovedRootAllowlist } from '../src/modules/sources/rootAttestation.js'
import { PostgresSourceOperationAuthority } from '../src/modules/sources/operationAuthority.js'
import { SourceOperationWorkerService } from '../src/modules/sources/operationWorker.js'
import { CarrierRemoteSourceMaterializationHost } from '../src/modules/sources/operationCarrier.js'
import { RemoteOperationJournal } from '../src/modules/runs/remote/operationJournal.js'
import { DomainError } from '../src/modules/errors.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { verificationFixture } from './helpers/jobVerificationFixture.js'
import { jobPolicyRequirementsRecord, ResolvedJobDefinitionSpecRecordSchema, type ResolvedJobDefinitionSpecRecord } from '@foreman-code/contracts/job-verification'
import { createVerificationProfile } from '../src/modules/jobs/verificationProfiles.js'
import { JOB_VERIFICATION_APPROVAL_LIFETIME_MS } from '@foreman-code/contracts/job-verification-policy'
import { jobSpec } from './helpers/jobFixture.js'
import { buildQueueFixture } from './helpers/buildComputerFixture.js'
import { installedSourceQuotaPool } from '../src/modules/jobs/quotaOwnership.js'
import { JobComputerSelection, releaseClosedJobComputers } from '../src/modules/jobs/computerSelection.js'
import { buildComputerTarget } from '../src/modules/settings/buildComputers.js'
import { JobDefinitionSchema, ResolvedJobDefinitionSpecSchema } from '@foreman-code/contracts/jobs'
import { JobExecutionRecordSchema } from '@foreman-code/contracts/job-verification'
import { sourceMaterializationDigest } from '../src/modules/sources/bindingHash.js'
import { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import { projectJobReceiptLocked } from '../src/modules/jobs/receiptProjection.js'
import { RemoteJobOperationReceiptRecordSchema } from '@foreman-code/contracts/remote-job-execution'
import { releaseMaterializationClaim } from '../src/modules/sources/materialization.js'
import { measureRetainedSourceDirectory } from '../src/modules/sources/retainedDirectoryUsage.js'
import type { SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'

/** Actual SQL/HTTP/MCP, protected local filesystem and worker source service.
 * The paired W07 carrier is an in-memory boundary; no laptop/container proof. */
describe.skipIf(!postgresEnabled)('failed Job source preparation reconciliation', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>, app: ReturnType<typeof buildApp>, address: string, directory: string
  let verificationQuota: SourceQuotaPool | undefined
  let access: PostgresAccessService, sources: PostgresSourceService, journal: RemoteOperationJournal
  let jobs: JobService
  let writer: Awaited<ReturnType<PostgresAccessService['issue']>>, reader: Awaited<ReturnType<PostgresAccessService['issue']>>
  const workspaceId = `source-reconcile-${randomUUID()}`, clients: Client[] = [], commandsToReconcile: string[] = []
  let root: ReturnType<typeof SourceRootRecordSchema.parse>, definitionId: string, worker: SourceOperationWorkerService, binding: DeviceSessionBinding
  let pause: { entered(): void; released: Promise<void> } | null = null
  let closureDispatch: PostgresJobDispatch | undefined
  let failSourceSettlement = false
  let interruptSourceTransfer = false
  let sharedInitialization: 'none' | 'fail' | 'complete' = 'none'
  let allowPreparationClosure = true
  let sourceQuotaConfiguration: { path: string; ownerUid: number } | undefined
  const queueServices: JobService[] = []
  const dispatches: PostgresJobDispatch[] = []
  beforeEach(async () => {
    verificationQuota = undefined
    closureDispatch = undefined
    failSourceSettlement = false
    interruptSourceTransfer = false
    sharedInitialization = 'none'
    allowPreparationClosure = true
    sourceQuotaConfiguration = undefined
    pause = null
    database = await agent3Database(); directory = await mkdtemp(`${process.env.FOREMAN_CODE_TEST_ROOT}/jobprep-reconcile-sql-`)
    const runtime = join(directory, 'runtime'), project = join(directory, 'project'), policyId = randomUUID()
    await mkdir(runtime, { mode: 0o700 }); await mkdir(project, { mode: 0o700 }); await mkdir(join(runtime, 'source-materializations'), { mode: 0o700 })
    const namespace = join(runtime, 'source-materializations', policyId); await mkdir(namespace, { mode: 0o700 })
    const mainId = (await database.pool.query<{id: string}>('select id from application_installation where singleton=true')).rows[0]!.id
    binding = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1,
      bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 1 }
    await database.pool.query('insert into device_registrations(id,main_id,worker_installation_id,public_key,record) values($1,$2,$3,$4,$5::jsonb)',
      [binding.deviceId,mainId,binding.workerInstallationId,'synthetic-pairing-fixture',JSON.stringify({ mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,
        keyRevision:1,authorizationRevision:1,publicKeyFingerprint:'f'.repeat(64),status:'paired',scopes:['connect','heartbeat'] })])
    await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId,JSON.stringify({id:workspaceId,name:'Failed source preparation fixture'})])
    access = new PostgresAccessService(database.pool)
    writer = await access.issue({ name: 'Scoped cleanup writer', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['sources:read','sources:reconcile','source_roots:read','workspace_locations:read',
        'job_definitions:read','job_definitions:write','jobs:start','jobs:read','capabilities:read'],
      scope: {workspaceIds:[workspaceId]} }] })
    reader = await access.issue({ name: 'Scoped source reader', audience: 'operator', expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['sources:read','source_roots:read','capabilities:read'], scope: {workspaceIds:[workspaceId]} }] })
    const bytes = Buffer.from('original immutable source'), manifest = createSourceManifest({ version:1,snapshotId:randomUUID(),approvedSourceId:randomUUID(),
      capturePolicy:'git-tree-v1',git:{commit:'2'.repeat(40),tree:'3'.repeat(40),objectFormat:'sha1'},executablePolicy:'strip',deletions:[],
      entries:[{path:'source.txt',kind:'file',byteSize:bytes.length,sha256:sourceSha256(bytes),executable:false}] })
    const snapshotRoot = join(directory, 'snapshots')
    await mkdir(snapshotRoot, { mode: 0o700 })
    const snapshots = new PrivateSourceSnapshotStore(snapshotRoot)
    await snapshots.write(manifest.snapshotId, manifest.entries[0]!, bytes)
    await snapshots.commit(manifest)
    const handle = await openPrivateRoot(namespace), filesystem = await identity(handle); await handle.close()
    root = SourceRootRecordSchema.parse({version:1,source:{approvedSourceId:manifest.approvedSourceId,snapshotId:manifest.snapshotId,manifestDigest:manifest.manifestDigest},
      selection:{hostRef:{kind:'device',mainId,deviceId:binding.deviceId},rootPolicyId:policyId,rootPolicyRevision:'1',locationRevision:'1'},
      binding:{version:1,mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,workspaceId,rootId:randomUUID(),bindingRevision:1,locationRevision:1,
        canonicalPath:namespace,filesystem,accessMode:'exclusive-write',snapshotId:manifest.snapshotId,manifestDigest:manifest.manifestDigest},
      registration:{workerInstallationId:binding.workerInstallationId,keyRevision:1,authorizationRevision:1},ownerPrincipalId:writer.principal.id,authorizedByPrincipalId:writer.principal.id,
      attestationId:randomUUID(),attestationDigest:'a'.repeat(64),boundAt:new Date().toISOString()})
    await database.pool.query("insert into source_approvals(approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request) values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')",
      [manifest.approvedSourceId,manifest.snapshotId,workspaceId,writer.principal.id,randomUUID(),'f'.repeat(64)])
    await database.pool.query('insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record) values($1,$2,$3,$4,$5::jsonb)',
      [manifest.snapshotId,manifest.approvedSourceId,workspaceId,manifest.manifestDigest,JSON.stringify({version:1,workspaceId,ownerPrincipalId:writer.principal.id,approvedByPrincipalId:writer.principal.id,
        locationRevision:1,mainId,originIdentityHash:`sha256:${'f'.repeat(64)}`,manifest,approvedAt:new Date().toISOString(),availability:'retained'})])
    await database.pool.query('insert into source_root_catalog(root_id,workspace_id,scope_hash,current_binding_revision) values($1,$2,$3,1)',[root.binding.rootId,workspaceId,randomUUID()])
    await database.pool.query('insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record) values($1,1,$2,$3,$4::jsonb)',[root.binding.rootId,workspaceId,manifest.snapshotId,JSON.stringify(root)])
    await database.pool.query("insert into workspace_root_policies(root_policy_id,root_policy_revision,workspace_id,host_scope,location_revision,record) values($1,1,$2,$3,1,'{}')",[policyId,workspaceId,randomUUID()])
    const approved = await qualifyApprovedRootAllowlist({schemaVersion:1,hostRef:root.selection.hostRef,applicationInstallationId:binding.workerInstallationId,
      configurationRevision:'1',bases:[{baseId:randomUUID(),canonicalPath:project,accessModes:['read-only','read-write']}],managedRuntimeRoot:runtime})
    journal = await RemoteOperationJournal.open(join(directory, 'job-journal.json'), { initializeNewInstallation: true })
    const unused = async (): Promise<never> => { throw new Error('No native execution or transfer in this fixture') }
    const attempts = { authorize: async () => {}, authorizeFinal: async () => {}, revalidate: async () => {}, revalidateMaterialization: async () => {} }
    const confirmedClosed = async (record: SourceMaterializationRecord) => {
      if (!closureDispatch) return false
      const row = (await database.pool.query<{ record: unknown }>(
        'select record from job_executions where id=$1', [record.receipt.executionId])).rows[0]
      if (!row) return false
      const execution = JobExecutionRecordSchema.parse(row.record)
      return Boolean(await closureDispatch.readAcceptedClosureReceipt(database.pool, {
        workspaceId, executionId: execution.id, attemptId: execution.attemptId,
        operationId: execution.operationId, bindingHash: execution.acceptedSpec.bindingHash, owner: execution.owner,
      }))
    }
    const owners = new PostgresSourceOperationAuthority(database.pool, attempts, (_sql, record) => confirmedClosed(record))
    worker = new SourceOperationWorkerService({mainNow:()=>Date.now(),authenticate:async context=>{expect(context.binding).toEqual(binding)},approvedRoots:async()=>approved,
      currentOwner:(operation,context)=>owners.resolve(operation,DeviceConnectionIdentitySchema.parse({mainId:context.binding.mainId,deviceId:context.binding.deviceId,
        workerInstallationId:context.binding.workerInstallationId,keyRevision:1,authorizationRevision:1,bootId:context.binding.bootId,connectionGeneration:1})),
      quotaPoolFor: async binding => {
        if (!sourceQuotaConfiguration) return verificationQuota
        const pool = await installedSourceQuotaPool(sourceQuotaConfiguration, binding)
        return pool && verificationQuota ? { ...verificationQuota, pool } : undefined
      },
      preparationNativeClosed:async operationId=>allowPreparationClosure && (await journal.jobNativeOwner(operationId))===null})
    const remote = new CarrierRemoteSourceMaterializationHost({capture:()=>({identity:DeviceConnectionIdentitySchema.parse({mainId,deviceId:binding.deviceId,
      workerInstallationId:binding.workerInstallationId,keyRevision:1,authorizationRevision:1,bootId:binding.bootId,connectionGeneration:1}),
      request:async(_namespace,request)=>({payload:await worker.handle(SourceFilesystemOperationSchema.parse(request),{binding,signal:new AbortController().signal})})})},owners,{publish:unused})
    const commands = new PostgresCommandCoordinator(database.pool)
    sources = new PostgresSourceService(database.pool,commands,{} as never,snapshots,mainId,{} as never,
      {authorize:async()=>{},authorizeFinal:async()=>{},
        storageCapacity: async (root, attempt) => {
          const measured = await remote.storageCapacity(root, attempt)
          // A one-CPU fixture host has two slots regardless of the machine running this suite.
          return sourceStorageCapacityFixture({ filesystem: measured.filesystem })
        },
        prepare: async (manifest, root, attempt) => {
          if (interruptSourceTransfer) throw new DomainError('SOURCE_TRANSFER_PENDING', 'Fixture source transfer interrupted', 503)
          const row = (await database.pool.query<{ spec: unknown }>(
            'select spec from job_computer_selections where execution_id=$1', [attempt.executionId])).rows[0]
          const quota = row && 'verification' in ResolvedJobDefinitionSpecRecordSchema.parse(row.spec)
            ? verificationQuota : undefined
          let checks = 0
          const authorize = async () => {
            checks += 1
            if (sharedInitialization === 'fail' && checks === 4) {
              throw new DomainError('SOURCE_INITIALIZATION_INTERRUPTED', 'Shared initialization interrupted', 503)
            }
          }
          return new PrivateSourceMaterializer({ read: async () => bytes }, authorize, quota)
            .prepare({ manifest, binding: root.binding, attempt,
              ...(sharedInitialization !== 'none' ? { sharedWritableTree: true as const } : {}) })
        },verify: record => remote.verify(record),verifyWorkingDirectory:unused,
        releaseClaim: async record => {
          await releaseMaterializationClaim(record.receipt, async () => 'released',
            record.receipt.quota ? verificationQuota : undefined)
          if (record.receipt.quota) return { retainedBytes: 0 }
          return { retainedBytes: await measureRetainedSourceDirectory(record.receipt.binding.canonicalPath,
            record.receipt.materializationId, record.receipt.binding.filesystem) }
        }, reconcilePreparation:(id,owner)=>remote.reconcilePreparation(id,owner)}, {confirmedClosed}, {
        closed: async () => {
          if (failSourceSettlement) throw new Error('Interrupted after process and publication commit')
        },
      })
    const spec = jobSpec(); spec.source={...root.source,commit:manifest.git!.commit}
    spec.target={...spec.target,mainId,mainInstallationId:mainId,hostRef:root.selection.hostRef,registration:root.registration,
      destination:{...spec.target.destination,canonicalProjectRoot:namespace,canonicalCwd:namespace,managedRuntimeRoot:runtime,rootPolicyId:policyId,attestationId:root.attestationId,attestationHash:root.attestationDigest}}
    spec.policy.preparationTimeoutMs=600000
    jobs = new JobService(database.pool,commands,{
      workerExecution: new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' }),
      preparation:{choices:async()=>({targets:[],sources:[],policies:[]}),validate:async()=>({valid:true,reasons:[],sideEffects:false}),
      revalidateAccepted:async()=>{},adoptFinalBinding:async()=>{},accept:async(_sql,principal,_workspace,_spec,identity)=>{
        const attempt={executionId:identity.executionId,attemptId:identity.attemptId,placementHash:'',keyRevision:1,authorizationRevision:1};attempt.placementHash=sourceBindingHash(root,attempt,identity.operationId)
        await sources.prepareExecution({principal,workspaceId,rootId:root.binding.rootId,bindingRevision:1,source:root.source,attempt,operationId:identity.operationId})
        if(pause) {pause.entered();await pause.released}
        throw new DomainError('SOURCE_REPOSITORY_TIMEOUT','Private repository fixture failure',503)
      }},dispatch:{accept:unused,cancelForRunCleanup:unused,cancel:unused,wake:unused},artifacts:{list:async()=>[],read:unused}})
    app = buildApp({logger:pino({level:'error'}),readiness:{database:{ping:async()=>{}},checkpoints:{ping:async()=>{}}},operator:{access,services:{sources,jobs,commands} as unknown as OperatorServices}})
    address = await app.listen({host:'127.0.0.1',port:0})
    const save = await app.inject({method:'POST',url:`/api/management/workspaces/${workspaceId}/jobs/definitions`,headers:{authorization:`Bearer ${writer.token}`},
      payload:{commandId:randomUUID(),expectedRevision:null,name:'Failure before native admission',spec}})
    expect(save.statusCode).toBe(200);definitionId=save.json().definition.id
  },60000)
  afterEach(async()=>{
    await Promise.allSettled(queueServices.map(service => service.closeQueue()))
    await Promise.allSettled(dispatches.map(dispatch => dispatch.close()))
    await Promise.allSettled(clients.map(client=>client.close()));await app?.close();await journal?.close();await database?.close();if(directory)await removeFixtureDirectory(directory)
    queueServices.length = 0
    dispatches.length = 0
    clients.length = 0
    commandsToReconcile.length = 0
  })
  const sourceUrl=()=>`/api/management/workspaces/${workspaceId}/source-preparations`
  const start=(commandId:string)=>app.inject({method:'POST',url:`/api/management/workspaces/${workspaceId}/jobs/executions`,headers:{authorization:`Bearer ${writer.token}`},payload:{commandId,definitionId,expectedRevision:1}})
  async function client(token:string) {const value=new Client({name:'source-reconciliation-fixture',version:'1'});clients.push(value);await value.connect(new StreamableHTTPClientTransport(new URL('/mcp',address),{requestInit:{headers:{authorization:`Bearer ${token}`}}}));return value}
  it('reproduces capacity exhaustion, preserves failed evidence, audits HTTP/MCP cleanup and frees active slots',async()=>{
    for(let i=0;i<2;i++) {
      interruptSourceTransfer = i === 1
      const commandId=randomUUID();commandsToReconcile.push(commandId)
      // Retained preparations use the original domain path; HTTP retries preserve that identity.
      await expect(jobs.start(writer.principal, 'http', workspaceId,
        { commandId, definitionId, expectedRevision: 1 })).rejects.toMatchObject({
          code: i === 0 ? 'SOURCE_REPOSITORY_TIMEOUT' : 'SOURCE_TRANSFER_PENDING',
        })
      const result=await start(commandId);expect(result.statusCode).toBeGreaterThanOrEqual(400)
    }
    interruptSourceTransfer = false
    const exhaustedCommand = randomUUID()
    await expect(jobs.start(writer.principal, 'http', workspaceId,
      { commandId: exhaustedCommand, definitionId, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'SOURCE_CAPACITY', status: 409 })
    const exhausted=await start(exhaustedCommand);expect(exhausted.statusCode,JSON.stringify(exhausted.json())).toBe(409);expect(exhausted.json().error.code).toBe('SOURCE_CAPACITY')
    const rows=(await database.pool.query<{operation_id:string}>('select operation_id from job_preparations where workspace_id=$1 and command_id=any($2) order by created_at',[workspaceId,commandsToReconcile])).rows
    expect(rows).toHaveLength(2)
    const operator=await client(writer.token)
    expect((await operator.listTools()).tools.map(tool=>tool.name)).toContain('source_preparation_reconcile')
    for(const [i,row] of rows.entries()) {
      const before=await app.inject({method:'POST',url:sourceUrl()+'/get',headers:{authorization:`Bearer ${reader.token}`},payload:{operationId:row.operation_id}})
      expect(before.statusCode).toBe(200);expect(before.json().reservationState).toBe(i===0?'owned':'preparing')
      expect(decodeMcpToolResult((await operator.callTool({name:'source_preparation_get',arguments:{workspaceId,startCommandId:commandsToReconcile[i]!}})))).toEqual(before.json())
      const command={operationId:row.operation_id,commandId:randomUUID()}
      const denied=await app.inject({method:'POST',url:sourceUrl()+'/reconcile',headers:{authorization:`Bearer ${reader.token}`},payload:command})
      expect(denied.statusCode).toBe(403)
      const result=await operator.callTool({name:'source_preparation_reconcile',arguments:{workspaceId,...command}})
      expect(result.isError).not.toBe(true)
      const value=(decodeMcpToolResult(result) as {value:{reservationState:string;reservedBytes:number;closure:{materializationId:string|null}}}).value
      expect(value.reservationState).toBe('retained')
      expect(value.reservedBytes).toBe(value.closure.materializationId === null
        ? Math.min(before.json().reservedBytes, 16 * 1024) : before.json().reservedBytes)
      const stored = (await database.pool.query<{ reserved_bytes: string }>(
        'select reserved_bytes from source_storage_reservations where owner_id=$1', [row.operation_id])).rows[0]!
      expect(Number(stored.reserved_bytes)).toBe(value.reservedBytes)
      expect(decodeMcpToolResult((await operator.callTool({name:'source_preparation_get',arguments:{workspaceId,operationId:row.operation_id}})))).toEqual(value)
      const replay=await app.inject({method:'POST',url:sourceUrl()+'/reconcile',headers:{authorization:`Bearer ${writer.token}`},payload:command})
      expect(replay.statusCode).toBe(200);expect(replay.json()).toEqual({value,replayed:true})
      if(value.closure.materializationId) expect(await readFile(join(root.binding.canonicalPath,value.closure.materializationId,'tree/source.txt'),'utf8')).toBe('original immutable source')
      expect(Number((await database.pool.query("select count(*) from management_audit where action='source.preparation.reconcile' and outcome='succeeded' and details->>'commandId'=$1",[command.commandId])).rows[0].count)).toBe(1)
    }
    const sql=await database.pool.connect()
    try {await beginTransaction(sql);const original=(await sql.query<{record:{scopeId:string}}>('select record from source_storage_reservations where owner_id=$1',[rows[0]!.operation_id])).rows[0]!.record
      const reservations = new PostgresSourceReservations(async () =>
        sourceStorageCapacityFixture({ filesystem: root.binding.filesystem }))
      await expect(reservations.reserve(sql,{scopeId:original.scopeId,ownerKind:'materialization',ownerId:randomUUID(),reservedBytes:1000})).resolves.toHaveProperty('reservationId');await rollbackTransaction(sql)
    } finally {sql.release()}
    expect(Number((await database.pool.query('select count(*) from job_executions where workspace_id=$1',[workspaceId])).rows[0].count)).toBe(0)
    const old=await start(commandsToReconcile[0]!);expect(old.statusCode).toBe(409);expect(old.json().error.code).toBe('SOURCE_PREPARATION_RECONCILED')
    const revoked=await access.issue({name:'Later revoked reader',audience:'operator',expiresAt:new Date(Date.now()+60000),grants:[{actions:['sources:read','source_roots:read'],scope:{workspaceIds:[workspaceId]}}]})
    const deniedClient=await client(reader.token)
    expect((await deniedClient.listTools()).tools.some(tool=>tool.name==='source_preparation_reconcile')).toBe(false)
    await expectMcpAccessDenied(deniedClient.callTool({name:'source_preparation_reconcile',arguments:{workspaceId,operationId:rows[0]!.operation_id,commandId:randomUUID()}}))
    const foreign=await operator.callTool({name:'source_preparation_get',arguments:{workspaceId:'foreign',operationId:rows[0]!.operation_id}});expect(foreign.isError).toBe(true)
    await database.pool.query('update management_principals set revoked_at=now() where id=$1',[revoked.principal.id])
    await expect(sources.preparationGet(revoked.principal,'mcp',{workspaceId,operationId:rows[0]!.operation_id})).rejects.toMatchObject({code:'AUTH_REVOKED'})
  },60000)
  it.each([undefined, '', '{"version":1', '{"version":1,"id":false}'])(
    'recovers an incomplete readiness record %j through authenticated MCP and reads back the closed owner', async readiness => {
    const operator = await client(writer.token)
    const denied = await client(reader.token)
    const startCommand = randomUUID()
    sharedInitialization = 'fail'
    try {
      await expect(jobs.start(writer.principal, 'mcp', workspaceId,
        { commandId: startCommand, definitionId, expectedRevision: 1 }))
        .rejects.toMatchObject({ code: 'SOURCE_INITIALIZATION_INTERRUPTED' })
      const operationId = (await database.pool.query<{ operation_id: string }>(
        'select operation_id from job_preparations where workspace_id=$1 and command_id=$2',
        [workspaceId, startCommand])).rows[0]!.operation_id
      if (readiness !== undefined) {
        const pending = (await readdir(root.binding.canonicalPath)).find(name => name.endsWith('.json.pending'))!
        await writeFile(join(root.binding.canonicalPath, `${pending}.ready`), readiness, { mode: 0o600 })
      }
      const command = { workspaceId, operationId, commandId: randomUUID() }
      await expectMcpAccessDenied(denied.callTool({ name: 'source_preparation_reconcile', arguments: command }))
      const result = await operator.callTool({ name: 'source_preparation_reconcile', arguments: command })
      expect(result.isError).not.toBe(true)
      const value = (decodeMcpToolResult(result) as { value: unknown }).value
      expect(value).toMatchObject({ operationId, reservationState: 'retained',
        closure: { childrenClosed: true, claimReleased: true } })
      expect(decodeMcpToolResult(await operator.callTool({ name: 'source_preparation_get',
        arguments: { workspaceId, operationId } }))).toEqual(value)
      sharedInitialization = 'complete'
      const nextCommand = randomUUID()
      await expect(jobs.start(writer.principal, 'mcp', workspaceId,
        { commandId: nextCommand, definitionId, expectedRevision: 1 }))
        .rejects.toMatchObject({ code: 'SOURCE_REPOSITORY_TIMEOUT' })
      const next = (await database.pool.query<{ record: SourceMaterializationRecord }>(
        `select m.record from source_execution_materializations m join job_preparations p using(operation_id)
          where p.workspace_id=$1 and p.command_id=$2`, [workspaceId, nextCommand])).rows[0]!
      expect(next.record.receipt.binding).toEqual(root.binding)
      expect(await readFile(join(root.binding.canonicalPath, next.record.receipt.sharedTree!.id,
        'tree', 'source.txt'), 'utf8')).toBe('original immutable source')
      expect((await operator.callTool({ name: 'source_preparation_reconcile', arguments: {
        workspaceId, operationId: next.record.operationId, commandId: randomUUID(),
      } })).isError).not.toBe(true)
    } finally {
      sharedInitialization = 'none'
    }
  }, 60000)

  it('keeps capacity and evidence while the original Start command is live, then reconciles its recorded failure',async()=>{
    let entered!:()=>void,release!:()=>void
    const started=new Promise<void>(resolve=>{entered=resolve}),released=new Promise<void>(resolve=>{release=resolve})
    pause={entered,released};const startCommand=randomUUID()
    const pending = expect(jobs.start(writer.principal, 'http', workspaceId,
      { commandId: startCommand, definitionId, expectedRevision: 1 }))
      .rejects.toMatchObject({ code: 'SOURCE_REPOSITORY_TIMEOUT', status: 503 })
    try {
      await Promise.race([started, pending.then(() => {
        throw new Error('Start settled before source preparation entered')
      })])
      const row=(await database.pool.query<{operation_id:string}>('select operation_id from job_preparations where principal_id=$1 and command_id=$2',[writer.principal.id,startCommand])).rows[0]!
      const command={operationId:row.operation_id,commandId:randomUUID()}
      const result=await app.inject({method:'POST',url:sourceUrl()+'/reconcile',headers:{authorization:`Bearer ${writer.token}`},payload:command})
      expect(result.statusCode).toBe(409);expect(result.json().error.code).toBe('SOURCE_PREPARATION_ACTIVE')
      expect((await sources.preparationGet(reader.principal,'http',{workspaceId,operationId:row.operation_id})).reservationState).toBe('owned')
      release();pause=null;await pending
      expect((await start(startCommand)).statusCode).toBe(503)
      const closed=await app.inject({method:'POST',url:sourceUrl()+'/reconcile',headers:{authorization:`Bearer ${writer.token}`},payload:command})
      expect(closed.statusCode,JSON.stringify(closed.json())).toBe(200);expect(closed.json().value.reservationState).toBe('retained')
    } finally {release();pause=null;await pending}
  },60000)

  async function queuedFixture(kind: 'build' | 'verification' = 'build') {
    const authority = await access.issue({ name: 'Queued source writer', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['sources:read', 'source_roots:read',
        'job_definitions:read', 'job_definitions:write', 'jobs:start', 'jobs:read', 'jobs:cancel',
        'settings:read', 'settings:update'], scope: {} }] })
    const f = await buildQueueFixture(database.pool, authority.principal, { workspaceId })
    queueServices.push(f.jobs)
    const saved = JobDefinitionSchema.parse((await database.pool.query<{ record: unknown }>(
      'select record from job_definitions where id=$1', [definitionId])).rows[0]!.record)
    let spec: ResolvedJobDefinitionSpecRecord = ResolvedJobDefinitionSpecSchema.parse({ ...jobSpec(), ...saved.spec })
    if (kind === 'verification') {
      const verification = verificationFixture().spec
      spec = { ...verification, source: spec.source, target: spec.target, argv: verification.argv,
        policy: { ...verification.policy, isolationPolicyId: randomUUID() } }
    }
    const computer = f.computers[0]!
    let profile = 'verification' in spec ? createVerificationProfile({
      id: spec.policy.isolationPolicyId, revision: spec.policy.isolationPolicyRevision, workspaceId,
      name: 'Verification cleanup runtime', root, sourceCommit: spec.source.commit,
      spec: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision,
        resources: spec.verification.resources, policy: JobVerificationPolicyRequirementsSchema.parse(jobPolicyRequirementsRecord(spec.policy)),
        suites: ['unit'], approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS } },
      previous: null, now: new Date().toISOString(),
    }) : { ...computer.candidate.profile, root }
    if (profile.schemaVersion === 2) {
      // Runtime metadata is a serialized boundary fixture; the worker cleanup and storage path are real.
      const facts = verificationRuntimeFixture().measurement
      const requestedAt = new Date().toISOString()
      const approvalId = randomUUID()
      const qualificationId = randomUUID()
      const fingerprint = { ...facts.fingerprint, profileId: profile.id, profileRevision: profile.revision,
        specDigest: profile.specDigest, root, hostRef: root.selection.hostRef, registration: root.registration,
        mainInstallationId: root.binding.mainId, sourceCommit: spec.source.commit, approvalConfig: profile.approvalConfig,
        quotaPool: { ...facts.fingerprint.quotaPool!, slots: facts.fingerprint.quotaPool!.slots.map(slot => ({
          ...slot, filesystem: { ...root.binding.filesystem, inode: slot.filesystem.inode },
        })) } }
      for (const slot of fingerprint.quotaPool.slots) {
        const path = join(root.binding.canonicalPath, slot.namespace)
        await mkdir(path, { mode: 0o700 })
        const directory = await openPrivateRoot(path)
        try { slot.filesystem = await identity(directory) } finally { await directory.close() }
      }
      verificationQuota = { pool: fingerprint.quotaPool, read: async (pool, path, signal) => {
        signal.throwIfAborted()
        const slot = pool.slots.find(value => path.startsWith(join(root.binding.canonicalPath, value.namespace)))!
        const handle = await openPrivateRoot(path)
        const filesystem = await identity(handle)
        await handle.close()
        const base = join(root.binding.canonicalPath, slot.namespace)
        const directory = await open(base, 'r')
        const allocated = (await directory.stat()).blocks * 512
        await directory.close()
        const occupied = (await readdir(base)).length > 0
        return { volumeCapacityBytes: fingerprint.quota.volumeCapacityBytes,
          volumeCapacityInodes: pool.volumeCapacityInodes, projectId: slot.projectId, inheritance: true,
          hardLimitBytes: slot.hardLimitBytes, hardInodes: slot.hardInodes,
          usedBytes: occupied ? allocated + 4096 : allocated, usedInodes: occupied ? 2 : 1,
          accountingEnabled: true, filesystem }
      } }
      const approvalExpiresAt = new Date(Date.parse(requestedAt) + profile.approvalConfig.approvalLifetimeMs).toISOString()
      const profileIdentity = { ...facts.identity, profileId: profile.id, profileRevision: profile.revision,
        rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision,
        qualificationId, approvalId, fingerprintDigest: jobDigest(fingerprint), approvalExpiresAt }
      const measurement = JobVerificationRuntimeMeasurementSchema.parse({ ...facts, fingerprint, identity: profileIdentity,
        approvedAt: requestedAt, checkedAt: requestedAt,
        suites: facts.suites.map(suite => ({ ...suite, maxConcurrentHeavyJobs: 2 })) })
      const saved = profile
      profile = JobVerificationProfileSchema.parse({ ...saved, status: 'qualified', measurement })
      await database.pool.query(`insert into job_runtime_profiles(id,workspace_id,revision,root_id,binding_revision,record)
        values($1,$2,$3,$4,$5,$6::jsonb)`, [profile.id, workspaceId, profile.revision,
        root.binding.rootId, root.binding.bindingRevision, JSON.stringify(profile)])
      await database.pool.query('insert into job_runtime_profile_versions(profile_id,revision,record) values($1,$2,$3::jsonb)',
        [saved.id, saved.revision, JSON.stringify(saved)])
      const approval = JobRuntimeApprovalRecordSchema.parse({ schemaVersion: 2, id: approvalId, qualificationId,
        workspaceId, profileId: profile.id, profileRevision: profile.revision, fingerprint,
        fingerprintDigest: profileIdentity.fingerprintDigest, requestedByPrincipalId: authority.principal.id,
        status: 'complete', approvedByPrincipalId: authority.principal.id, approvedAt: requestedAt,
        requestedAt, expiresAt: approvalExpiresAt })
      await database.pool.query(`insert into job_runtime_qualification_approvals
        (id,qualification_id,profile_id,profile_revision,workspace_id,record,measurement,requested_by,approved_by)
        values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$8)`, [approvalId, qualificationId, profile.id,
        profile.revision, workspaceId, JSON.stringify(approval), JSON.stringify(measurement), authority.principal.id])
    }
    const candidate = { ...computer.candidate, spec, ready: true, reasons: [],
      profile, sourceReservation: {
        scopeId: `${binding.mainId}:${binding.deviceId}:${binding.workerInstallationId}:${root.binding.filesystem.device}:${root.binding.filesystem.mountId}`,
        reservedBytes: 2097152,
      } }
    const target = buildComputerTarget(spec.target)
    const preference = await f.settings.read(authority.principal, { target })
    await f.settings.update(authority.principal, 'http', { commandId: randomUUID(), target,
      expectedRevision: preference.preference.revision, buildEnabled: true, buildPriority: 100 })
    const executionPolicy = new WorkerExecutionPolicy({ enabled: true, managedBy: 'startup' })
    const placement = new JobComputerSelection(f.settings, { candidates: async () => ({ candidates: [candidate], diagnosticCodes: [] }) }, executionPolicy, async () => 32 * 2 ** 30)
    let afterMaterialization: (() => Promise<void>) | undefined
    const delivered: string[] = []
    function create() {
      const dispatch = new PostgresJobDispatch(database.pool, {
        async deliver(intent, execution) {
          delivered.push(execution.id)
          const finishedAt = new Date().toISOString()
          const terminal = { finishedAt, closureEvidenceDigest: '7'.repeat(64), outcome: 'preparation_failed',
            exitCode: null, signal: null, processStopped: true, resultDigest: '8'.repeat(64),
            logGapPossible: false, logsTruncated: false, outputCollectionError: false, artifactDigests: [] }
          return { status: 'known', receipt: RemoteJobOperationReceiptRecordSchema.parse({
            schemaVersion: 1, kind: 'job', intent, execution: { ...execution,
              process: { phase: 'terminal', outcome: 'preparation_failed', exitCode: null, signal: null,
                processStopped: true }, publication: 'complete', finishedAt },
            connection: binding, workerIncarnationId: randomUUID(), sequence: 1,
            observedAt: finishedAt, phase: 'confirmed_terminal', entryAttempted: false, stopFence: false,
            controls: [], terminal, publication: 'complete',
          }) }
        },
        async reconcile() { throw new Error('Settled recovery must use the retained closure') },
        async control() { throw new Error('Claimed cancellation must not reach execution control') },
      }, {
        revalidate: async () => {}, authorizeControl: async () => {},
        observe: (sql, execution, receipt) => projectJobReceiptLocked(sql, execution, receipt,
          { verifyRequiredOutputs: async () => {} }),
        settleSource: async id => {
          const row = (await database.pool.query<{ record: SourceMaterializationRecord }>(
            'select record from source_execution_materializations where execution_id=$1', [id])).rows[0]!
          await sources.confirmClosed(row.record)
          await releaseClosedJobComputers(database.pool)
        },
      }, executionPolicy)
      dispatches.push(dispatch)
      closureDispatch = dispatch
      const jobs = new JobService(database.pool, f.commands, { placement, queue: { ...f.queue,
        resources: (sql, definition) => 'verification' in definition.spec
          ? Promise.resolve(definition.spec.verification.resources) : f.queue.resources(sql, definition) },
        workerExecution: executionPolicy, dispatch,
        closePreparation: ticket => sources.closeQueuedPreparation(ticket),
        preparation: {
          choices: async () => ({ targets: [], sources: [], policies: [] }),
          validate: async () => ({ valid: true, reasons: [], sideEffects: false }),
          revalidateAccepted: async () => {},
          async adoptFinalBinding(sql, principal, execution) {
            const row = (await sql.query<{ record: SourceMaterializationRecord }>(
              'select record from source_execution_materializations where execution_id=$1', [execution.id])).rows[0]!
            await sources.adoptFinalBinding(sql, principal, row.record, execution.acceptedSpec.bindingHash)
          },
          async accept(_sql, principal, _workspace, resolved, identity) {
            const attempt = { executionId: identity.executionId, attemptId: identity.attemptId,
              placementHash: '', keyRevision: 1, authorizationRevision: 1 }
            attempt.placementHash = sourceBindingHash(root, attempt, identity.operationId)
            const record = await sources.prepareExecution({ principal, workspaceId, rootId: root.binding.rootId,
              bindingRevision: 1, source: root.source, attempt, operationId: identity.operationId })
            await afterMaterialization?.()
            return { ...resolved, source: { ...resolved.source, materializationId: record.receipt.materializationId,
              materializationDigest: sourceMaterializationDigest(record) } }
          },
        }, artifacts: { list: async () => [], read: async () => { throw new Error('No declared output') } },
      })
      queueServices.push(jobs)
      return { jobs, dispatch }
    }
    const runtime = create()
    const definition = await runtime.jobs.saveDefinition(authority.principal, 'http', workspaceId, {
      commandId: randomUUID(), expectedRevision: null, name: 'Source recovery build', spec })
    async function enqueue(jobs = runtime.jobs, principal = authority.principal) {
      const admission = await jobs.enqueue(principal, 'http', workspaceId, { commandId: randomUUID(),
        definitionId: definition.id, expectedRevision: definition.revision })
      if (admission.kind === 'retained-execution') throw new Error('Expected queue admission')
      const ticketId = admission.kind === 'accepted' ? admission.ticketId : admission.ticket.id
      return jobs.getQueueTicket(principal, workspaceId, ticketId)
    }
    return { ...runtime, principal: authority.principal, create, enqueue, delivered, placement, definition,
      pausePreparation: (callback?: () => Promise<void>) => { afterMaterialization = callback } }
  }

  it('recovers source settlement after terminal publication commits and lets the next Job use the slot', async () => {
    const f = await queuedFixture()
    failSourceSettlement = true
    const ticket = await f.enqueue()
    await expect(f.jobs.wakeQueue()).rejects.toMatchObject({ code: 'JOB_DISPATCH_PENDING' })
    expect(await f.jobs.getExecution(f.principal, workspaceId, ticket.executionId))
      .toMatchObject({ process: { phase: 'terminal', processStopped: true }, publication: 'complete' })
    const sourceState = () => database.pool.query<{ state: string }>(
      'select state from source_execution_materializations where execution_id=$1', [ticket.executionId])
    expect((await sourceState()).rows[0]!.state).toBe('prepared')
    await f.jobs.closeQueue()
    await f.dispatch.close()
    failSourceSettlement = false
    const restarted = f.create()
    await restarted.jobs.wakeQueue()
    expect((await sourceState()).rows[0]!.state).toBe('closed')
    expect(f.delivered).toEqual([ticket.executionId])
    const next = await f.enqueue(restarted.jobs)
    await restarted.jobs.wakeQueue()
    expect((await restarted.jobs.getQueueTicket(f.principal, workspaceId, next.id)).state).toBe('accepted')
    expect(f.delivered).toEqual([ticket.executionId, next.executionId])
  })

  it('keeps a queued ordinary Job on its captured commit after the source-root head advances, with scoped MCP readback', async () => {
    const f = await queuedFixture()
    const ticket = await f.enqueue()
    const snapshotId = randomUUID()
    const approvedSourceId = randomUUID()
    const captured = await sources.get(writer.principal, 'http', { workspaceId, ...root.source })
    const advancedCommit = '4'.repeat(40)
    const manifest = createSourceManifest({ ...captured.manifest, snapshotId, approvedSourceId,
      git: { ...captured.manifest.git!, commit: advancedCommit } })
    const manifestDigest = manifest.manifestDigest
    const snapshot = { ...captured, manifest, approvedAt: new Date().toISOString() }
    const advanced = { ...root, attestationId: randomUUID(), source: { approvedSourceId, snapshotId, manifestDigest },
      binding: { ...root.binding, bindingRevision: 2, snapshotId, manifestDigest } }
    try {
      await database.pool.query(`insert into source_approvals
        (approved_source_id,snapshot_id,workspace_id,owner_principal_id,requested_by,command_id,input_hash,state,origin,request)
        values($1,$2,$3,$4,$4,$5,$6,'approved','{}','{}')`,
      [approvedSourceId, snapshotId, workspaceId, writer.principal.id, randomUUID(), manifestDigest])
      await database.pool.query(`insert into source_snapshots(snapshot_id,approved_source_id,workspace_id,manifest_digest,record)
        values($1,$2,$3,$4,$5::jsonb)`,
      [snapshotId, approvedSourceId, workspaceId, manifestDigest, JSON.stringify(snapshot)])
      await database.pool.query(`insert into source_root_bindings(root_id,binding_revision,workspace_id,snapshot_id,record)
        values($1,2,$2,$3,$4::jsonb)`, [root.binding.rootId, workspaceId, snapshotId, JSON.stringify(advanced)])
      await database.pool.query('update source_root_catalog set current_binding_revision=2 where root_id=$1',
        [root.binding.rootId])
      expect((await sources.rootList(writer.principal, 'http', { workspaceId })).items).toContainEqual(advanced)
      const head = await sources.get(writer.principal, 'http', { workspaceId, ...advanced.source })
      expect(head.manifest.git?.commit).toBe(advancedCommit)
      expect(head.manifest.git?.commit).not.toBe(f.definition.spec.source.commit)
      await f.jobs.wakeQueue()
      expect(await f.jobs.getQueueTicket(f.principal, workspaceId, ticket.id))
        .toMatchObject({ state: 'accepted', executionId: ticket.executionId })
      const execution = await f.jobs.getExecution(f.principal, workspaceId, ticket.executionId)
      expect(execution.acceptedSpec.source.commit).toBe(f.definition.spec.source.commit)
      expect(execution.acceptedSpec.source.snapshotId).toBe(root.source.snapshotId)
      expect(f.delivered).toEqual([ticket.executionId])
      const operator = await client(writer.token)
      const input = { workspaceId, executionId: ticket.executionId }
      const readback = await operator.callTool({ name: 'job_get', arguments: input })
      expect(readback.isError, JSON.stringify(readback)).not.toBe(true)
      expect(decodeMcpToolResult(readback)).toMatchObject({ execution: { acceptedSpec: execution.acceptedSpec } })
      const denied = await client(reader.token)
      expect((await denied.callTool({ name: 'job_get', arguments: input })).isError).toBe(true)
    } finally {
      await database.pool.query('update source_root_catalog set current_binding_revision=1 where root_id=$1',
        [root.binding.rootId])
      // Immutable snapshot and binding records remain until the fixture database is dropped.
    }
  })
  it('audits fresh bounded MCP recovery of a stopped admitted Job and denies a caller without Job cancellation authority', async () => {
    const f = await queuedFixture('verification')
    failSourceSettlement = true
    const ticket = await f.enqueue()
    await expect(f.jobs.wakeQueue()).rejects.toMatchObject({ code: 'JOB_DISPATCH_PENDING' })
    const execution = await f.jobs.getExecution(f.principal, workspaceId, ticket.executionId)
    if (execution.schemaVersion !== 2) throw new Error('Verification execution required')
    expect(execution).toMatchObject({ process: { phase: 'terminal', processStopped: true }, publication: 'complete' })
    await f.jobs.closeQueue(); await f.dispatch.close(); failSourceSettlement = false
    const cleanup = await access.issue({ name: 'Stopped Job source recovery', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['sources:read', 'source_roots:read',
        'sources:reconcile', 'jobs:cancel', 'capabilities:read'], scope: { workspaceIds: [workspaceId] } }] })
    const sourceOnly = await access.issue({ name: 'Source recovery without Job authority', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['sources:read', 'source_roots:read',
        'sources:reconcile', 'capabilities:read'], scope: { workspaceIds: [workspaceId] } }] })
    const command = { workspaceId, operationId: ticket.operationId, commandId: randomUUID() }
    const denied = await client(sourceOnly.token)
    expect((await denied.callTool({ name: 'source_preparation_reconcile', arguments: command })).isError).toBe(true)
    const operator = await client(cleanup.token)
    const result = await operator.callTool({ name: 'source_preparation_reconcile', arguments: command })
    expect(result.isError).not.toBe(true)
    const value = (decodeMcpToolResult(result) as { value: { reservationState: string; executionId: string;
      closure: { quotaReclaimed: boolean } } }).value
    expect(value).toMatchObject({ reservationState: 'reclaimed', executionId: ticket.executionId,
      closure: { quotaReclaimed: true } })
    const readback = await operator.callTool({ name: 'source_preparation_get',
      arguments: { workspaceId, operationId: ticket.operationId } })
    expect(decodeMcpToolResult(readback)).toEqual(value)
    const replay = await operator.callTool({ name: 'source_preparation_reconcile', arguments: command })
    expect(decodeMcpToolResult(replay)).toMatchObject({ value, replayed: true })
    const refreshed = await operator.callTool({ name: 'source_preparation_reconcile',
      arguments: { ...command, commandId: randomUUID() } })
    expect(refreshed.isError, JSON.stringify(refreshed)).not.toBe(true)
    const refreshedValue = (decodeMcpToolResult(refreshed) as { value: typeof value }).value
    expect(refreshedValue).toMatchObject({ reservationState: 'reclaimed', executionId: ticket.executionId })
    expect(refreshedValue.closure).not.toEqual(value.closure)
    expect(decodeMcpToolResult((await operator.callTool({ name: 'source_preparation_reconcile', arguments: command }))))
      .toMatchObject({ value, replayed: true })
    expect((await f.jobs.getExecution(f.principal, workspaceId, ticket.executionId)).acceptedSpec).toEqual(execution.acceptedSpec)
    const persisted = (await database.pool.query<{ owner: { identity: { expiresAt: string } }; status: string }>(
      'select owner,status from source_preparation_reconciliations where operation_id=$1', [ticket.operationId])).rows[0]!
    expect(persisted.status).toBe('closed')
    expect(Date.parse(persisted.owner.identity.expiresAt) - Date.now()).toBeLessThanOrEqual(execution.acceptedSpec.policy.cleanupTimeoutMs)
  })

  it('automatically releases a timed-out claim after CI rebound source on the installed quota root', async () => {
    const f = await queuedFixture('verification')
    const path = join(directory, 'rebound-quota-runtime.json')
    await writeFile(path, JSON.stringify({ schemaVersion: 2,
      root: { ...root, binding: { ...root.binding, bindingRevision: 2,
        snapshotId: randomUUID(), manifestDigest: '9'.repeat(64) } },
      descriptor: { quotaPool: verificationQuota!.pool } }), { mode: 0o600 })
    sourceQuotaConfiguration = { path, ownerUid: process.getuid!() }
    interruptSourceTransfer = true
    try {
      const ticket = await f.enqueue()
      await expect(f.jobs.wakeQueue()).rejects.toMatchObject({ code: 'SOURCE_TRANSFER_PENDING' })
      await database.pool.query("update job_preparations set created_at=now()-interval '1 hour' where execution_id=$1",
        [ticket.executionId])
      await expect(f.jobs.wakeQueue()).rejects.toMatchObject({ code: 'JOB_PREPARATION_TIMEOUT' })
      await f.jobs.wakeQueue()
      expect(await f.jobs.getQueueTicket(f.principal, workspaceId, ticket.id))
        .toMatchObject({ state: 'terminal', terminalReason: 'timed_out', cleanupStatus: 'complete' })
      expect((await database.pool.query('select 1 from job_computer_selections where execution_id=$1 and released_at is null',
        [ticket.executionId])).rowCount).toBe(0)
      expect((await database.pool.query('select 1 from job_executions where id=$1', [ticket.executionId])).rowCount).toBe(0)
      const operator = await client(writer.token)
      const read = await operator.callTool({ name: 'source_preparation_get',
        arguments: { workspaceId, operationId: ticket.operationId } })
      expect(read.isError).not.toBe(true)
      expect(decodeMcpToolResult(read)).toMatchObject({ reservationState: 'retained', closure: {
        materializationId: null, admissionClosed: true, childrenClosed: true, claimReleased: true,
      } })
      const denied = await client(reader.token)
      await expectMcpAccessDenied(denied.callTool({ name: 'source_preparation_reconcile',
        arguments: { workspaceId, operationId: ticket.operationId, commandId: randomUUID() } }))
      interruptSourceTransfer = false
      const next = await f.enqueue()
      await f.jobs.wakeQueue()
      expect((await f.jobs.getQueueTicket(f.principal, workspaceId, next.id)).executionId).toBe(next.executionId)
      expect(f.delivered).toEqual([next.executionId])
      expect((await database.pool.query<{ materialization: string; reservation: string; computer_released: boolean }>(
        `select m.state as materialization,r.state as reservation,s.released_at is not null as computer_released
          from source_execution_materializations m join source_storage_reservations r
            on r.reservation_id=m.reservation_id
          join job_computer_selections s on s.operation_id=m.operation_id
          where m.execution_id=$1`, [next.executionId])).rows[0])
        .toEqual({ materialization: 'closed', reservation: 'reclaimed', computer_released: true })
    } finally {
      sourceQuotaConfiguration = undefined
      interruptSourceTransfer = false
    }
  })

  it.each(['cancelled', 'authorization_revoked', 'timed_out'] as const)(
    'recovers %s preparation through worker closure after a service restart', async reason => {
      const f = await queuedFixture()
      let resume!: () => void
      let entered!: () => void
      const paused = new Promise<void>(resolve => { resume = resolve })
      const preparing = new Promise<void>(resolve => { entered = resolve })
      f.pausePreparation(async () => { entered(); await paused })
      const ticket = await f.enqueue()
      const pending = f.jobs.wakeQueue()
      await Promise.race([preparing, pending.then(() => {
        throw new Error('Queue settled before source preparation entered')
      })])
      expect(await f.jobs.getQueueTicket(f.principal, workspaceId, ticket.id))
        .toMatchObject({ state: 'claimed', executionId: ticket.executionId })
      allowPreparationClosure = false
      try {
        await expect(sources.closeQueuedPreparation(ticket)).rejects.toMatchObject({ code: 'SOURCE_PREPARATION_ACTIVE' })
        const current = await f.jobs.getQueueTicket(f.principal, workspaceId, ticket.id)
        if (reason === 'cancelled') {
          await f.jobs.cancelQueued(f.principal, 'mcp', workspaceId, { commandId: randomUUID(),
            ticketId: ticket.id, expectedRevision: current.revision })
        } else if (reason === 'authorization_revoked') {
          await access.revoke(f.principal.id)
        } else {
          await database.pool.query("update job_preparations set created_at=now()-interval '1 hour' where execution_id=$1",
            [ticket.executionId])
        }
      } finally { resume() }
      await expect(pending).rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
      expect((await database.pool.query<{ record: { state: string; terminalReason: string } }>(
        'select record from job_admission_queue where id=$1', [ticket.id])).rows[0]!.record)
        .toMatchObject({ state: 'terminal', terminalReason: reason })
      expect((await database.pool.query('select 1 from job_computer_selections where execution_id=$1 and released_at is null',
        [ticket.executionId])).rowCount).toBe(1)
      await f.jobs.closeQueue()
      await f.dispatch.close()
      f.pausePreparation()
      allowPreparationClosure = true
      const restarted = f.create()
      await restarted.jobs.wakeQueue()
      expect((await database.pool.query('select 1 from job_computer_selections where execution_id=$1 and released_at is null',
        [ticket.executionId])).rowCount).toBe(0)
      expect((await database.pool.query<{ status: string; closure: unknown }>(
        'select status,closure from source_preparation_reconciliations where operation_id=$1',
        [ticket.operationId])).rows[0]).toMatchObject({ status: 'closed', closure: expect.objectContaining({
          executionId: ticket.executionId, attemptId: ticket.attemptId, operationId: ticket.operationId,
        }) })
      expect(f.delivered).toEqual([])
      const next = await f.enqueue(restarted.jobs, writer.principal)
      await restarted.jobs.wakeQueue()
      expect((await restarted.jobs.getQueueTicket(writer.principal, workspaceId, next.id)).state).toBe('accepted')
    })
  it.each(['cancelled', 'timed_out'] as const)(
    'reclaims partially materialized verification preparation after %s and restart', async reason => {
      const f = await queuedFixture('verification')
      let resume!: () => void
      let entered!: () => void
      const paused = new Promise<void>(resolve => { resume = resolve })
      const preparing = new Promise<void>(resolve => { entered = resolve })
      f.pausePreparation(async () => { entered(); await paused })
      const ticket = await f.enqueue()
      const pending = f.jobs.wakeQueue()
      await preparing
      allowPreparationClosure = false
      try {
        const current = await f.jobs.getQueueTicket(f.principal, workspaceId, ticket.id)
        if (reason === 'cancelled') {
          await f.jobs.cancelQueued(f.principal, 'mcp', workspaceId, {
            commandId: randomUUID(), ticketId: ticket.id, expectedRevision: current.revision,
          })
        } else {
          await database.pool.query("update job_preparations set created_at=now()-interval '1 hour' where execution_id=$1",
            [ticket.executionId])
        }
      } finally { resume() }
      await expect(pending).rejects.toMatchObject({ code: 'source-reconciliation-unconfirmed' })
      expect((await database.pool.query('select 1 from job_computer_selections where execution_id=$1 and released_at is null',
        [ticket.executionId])).rowCount).toBe(1)
      await f.jobs.closeQueue()
      await f.dispatch.close()
      allowPreparationClosure = true
      f.pausePreparation()
      const restarted = f.create()
      await restarted.jobs.wakeQueue()
      expect((await database.pool.query('select 1 from job_computer_selections where execution_id=$1 and released_at is null',
        [ticket.executionId])).rowCount).toBe(0)
      expect((await database.pool.query<{ status: string; closure: unknown }>(
        'select status,closure from source_preparation_reconciliations where operation_id=$1', [ticket.operationId]))
        .rows[0]).toMatchObject({ status: 'closed', closure: expect.objectContaining({
          executionId: ticket.executionId, attemptId: ticket.attemptId, operationId: ticket.operationId,
        }) })
      expect(f.delivered).toEqual([])
      const sql = await database.pool.connect()
      try {
        await beginTransaction(sql)
        const claim = await f.placement.claim(sql, f.principal, f.definition, {
          executionId: randomUUID(), attemptId: randomUUID(), operationId: randomUUID(),
        })
        expect(claim.spec).toMatchObject({ verification: { suite: 'unit' } })
        await rollbackTransaction(sql)
      } finally { sql.release() }
    })

})
