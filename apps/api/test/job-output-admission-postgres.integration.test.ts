import { readUntil } from './helpers/observableCondition.js'
import { buildComputersMigration } from '../src/infrastructure/buildComputersMigration.js'
import { buildComputerRoleMigration } from '../src/infrastructure/buildComputerRoleMigration.js'
import { buildComputerPriorityMigration } from '../src/infrastructure/buildComputerPriorityMigration.js'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './helpers/testResources.js'
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import Fastify, {type FastifyInstance} from 'fastify'
import { beforeAll, afterAll, describe, it, expect } from 'vitest'
import { deviceIdentityMigration } from '../src/modules/devices/migration.js'
import { pairingProof, publicKeyFingerprint } from '@foreman-code/contracts/device-identity-node'
import { PostgresDeviceAccessService } from '../src/modules/devices/access.js'
import { DeviceEndpoint } from '../src/modules/devices/deviceEndpoint.js'
import { signMainIdentityProof } from '../src/modules/devices/mainIdentity.js'
import { deviceNegotiationHash } from '../src/modules/devices/deviceApplicationChannel.js'
import { fileStorageMigration } from '../src/infrastructure/fileStorageMigration.js'
import { fileToolsMigration } from '../src/modules/files/tools/migration.js'
import { jobArtifactStorageMigration } from '../src/infrastructure/jobArtifactStorageMigration.js'
import { jobOutputAdmissionMigration } from '../src/infrastructure/jobOutputAdmissionMigration.js'
import { jobRunCleanupMigration } from '../src/infrastructure/jobRunCleanupMigration.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { JobPublicationAuthority } from '../src/modules/jobs/authority.js'
import { PostgresJobDispatch } from '../src/modules/jobs/dispatch.js'
import { JobOwnership } from '../src/modules/jobs/ownership.js'
import { createAdmittedJobOutputs } from '../src/modules/files/jobs/admittedFactory.js'
import { registerJobOutputMetadataEndpoints } from '../src/modules/files/jobs/outputEndpoints.js'
import { WorkerJobOutputReceiver } from '../src/modules/files/jobs/outputChannel.js'
import { outputTransferContext } from '../src/modules/files/jobs/outputAdmission.js'
import { ResumableByteTransferSender } from '../src/modules/byte-transfer/sender.js'
import { sourceMaterializationDigest } from '../src/modules/sources/bindingHash.js'
import { DomainError } from '../src/modules/errors.js'
import { jobExecution, jobSpec } from './helpers/jobFixture.js'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { SourceMaterializationRecord } from '@foreman-code/contracts/source-admission'
import type { JobSql } from '../src/modules/jobs/repository.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
const databaseUrl=process.env.TEST_DATABASE_URL,schema=`job_output_${randomUUID().replaceAll('-','')}`
const hash=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex')
function queue() {
  const values:string[]=[],waiters:((value:IteratorResult<string>)=>void)[]=[];let ended=false
  return {push(value:string){const waiter=waiters.shift();if(waiter)waiter({value,done:false});else values.push(value)},
    end(){ended=true;for(const waiter of waiters.splice(0))waiter({value:undefined,done:true})},
    async next():Promise<IteratorResult<string>>{if(values.length)return {value:values.shift()!,done:false};if(ended)return {value:undefined,done:true};return new Promise(resolve=>waiters.push(resolve))},
    async consume(onMessage:(text:string)=>void,signal:AbortSignal){while(!signal.aborted){const result=await this.next();if(result.done)return;onMessage(result.value)}},
    [Symbol.asyncIterator](){return this}}
}
/** Root-only DB contract fixture. Pairing, current W07 session, actual main PostgreSQL
 * ownership and B sender/receiver are real; source/native observations are explicit
 * fixture facts, not a claim of physical laptop/container acceptance. */
describe.skipIf(!databaseUrl)('main-issued authenticated job output transfer receipts',()=>{
  let admin:pg.Pool,pool:pg.Pool,storage:string,staging:string,endpoint:DeviceEndpoint,ownership:JobOwnership|undefined
  let actual:ReturnType<typeof createAdmittedJobOutputs>,access:PostgresDeviceAccessService,binding:DeviceSessionBinding,credential:string,endpointTask:Promise<void>
  let app:FastifyInstance,address:string,mcpClient:Client|undefined,incoming:ReturnType<typeof queue>,outgoing:ReturnType<typeof queue>
  const job=jobExecution(),body=Buffer.from('{"actual":"canonical"}'),mainId=randomUUID(),operatorToken=`fixture-${randomUUID()}`
  beforeAll(async()=>{
    const url=new URL(databaseUrl!)
    if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/test/i.test(url.pathname))throw new Error('Explicit owned loopback TEST_DATABASE_URL required.')
    admin=new pg.Pool({connectionString:databaseUrl});await createFixtureSchema(admin, schema)
    pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`})
    await pool.query(`create table workspaces(id text primary key);insert into workspaces values('workspace-fixture');
      create table application_installation(singleton boolean primary key,id text);create table operator_conversations(id text primary key);
      create table management_principals(id text primary key,name text,audience text,agent_id text,token_hash text,grants jsonb,expires_at timestamptz,revoked_at timestamptz,delegated_from text);
      create table management_command_receipts(principal_id text,operation text,command_id text,target_key text,input_hash text,result jsonb,primary key(principal_id,operation,command_id));
      create table management_audit(principal_id text,source text,action text,target_key text,outcome text,details jsonb);
      create table job_executions(id text primary key,workspace_id text,record jsonb,accepted_spec jsonb,accepted_by text);
      create table job_definition_versions(id text primary key,workspace_id text,definition_id text,record jsonb);
      create table job_dispatch_intents(execution_id text primary key,workspace_id text not null,intent jsonb,last_receipt jsonb,receipt_sequence bigint,owner_id text,owner_fence text,cancel_command_id text,cancel_principal_id text,cancel_action text check(cancel_action in ('jobs:cancel','runs:stop')));
      create table source_root_catalog(root_id uuid primary key,current_binding_revision bigint);
      create table source_root_bindings(root_id uuid,binding_revision bigint,workspace_id text,record jsonb);
      create table workspace_root_policies(root_policy_id text,root_policy_revision bigint,workspace_id text,revoked_at timestamptz);
      create table source_execution_materializations(materialization_id uuid,workspace_id text,execution_id text,attempt_id text,record jsonb,state text);
      create table source_snapshots(workspace_id text,snapshot_id uuid,approved_source_id uuid,manifest_digest text,record jsonb,availability text);`)
    await pool.query(jobRunCleanupMigration.sql)
    await pool.query(buildComputersMigration.sql)
    await pool.query(buildComputerRoleMigration.sql)
    await pool.query(buildComputerPriorityMigration.sql)
    await pool.query('insert into application_installation values(true,$1)',[mainId])
    await pool.query("insert into management_principals values('owner','Owner','operator',null,$1,$2::jsonb,'2099-01-01',null,null)",[hash(operatorToken),JSON.stringify([{actions:['settings:read','settings:update','jobs:start','job_artifacts:read'],scope:{}}])])
    await pool.query(deviceIdentityMigration.sql);await pool.query(fileStorageMigration.sql);await pool.query(fileToolsMigration.sql);await pool.query(jobArtifactStorageMigration.sql);await pool.query(jobOutputAdmissionMigration.sql)
    access=new PostgresDeviceAccessService(pool,mainId)
    const actor=await new PostgresAccessService(pool).authenticate(operatorToken),workerKeys=generateKeyPairSync('ed25519'),workerPublic=workerKeys.publicKey.export({type:'spki',format:'pem'}).toString(),workerInstallationId=randomUUID()
    const grant=await access.createPairingGrant(actor,{workerInstallationId,publicKey:workerPublic,expectedFingerprint:publicKeyFingerprint(workerPublic),scopes:['connect','heartbeat'],commandId:randomUUID()})
    const unsigned={mainId,workerInstallationId,publicKey:workerPublic,grant:grant.grant,requestId:randomUUID()}
    const paired=await access.pair({...unsigned,signature:sign(null,Buffer.from(pairingProof(unsigned)),workerKeys.privateKey).toString('base64url')});credential=paired.credential
    const mainKeys=generateKeyPairSync('ed25519'),mainPublic=mainKeys.publicKey.export({type:'spki',format:'pem'}).toString(),identity={mainId,publicKey:mainPublic,privateKey:mainKeys.privateKey.export({type:'pkcs8',format:'pem'}).toString(),publicKeyFingerprint:publicKeyFingerprint(mainPublic)}
    job.id=randomUUID();job.attemptId=randomUUID();job.operationId=randomUUID();job.owner={grantId:randomUUID(),epoch:'1'}
    job.acceptedSpec.target={...job.acceptedSpec.target,mainId,hostRef:{kind:'device',mainId,deviceId:paired.registration.deviceId},registration:{workerInstallationId,keyRevision:1,authorizationRevision:1}}
    job.acceptedSpec.outputs=[{path:'dist/report.json',mediaType:'application/json',required:true}];job.process={phase:'terminal',outcome:'succeeded',exitCode:0,signal:null,processStopped:true};job.finishedAt=job.createdAt
    const root={version:1 as const,mainId,deviceId:paired.registration.deviceId,workerInstallationId,workspaceId:job.workspaceId,rootId:randomUUID(),bindingRevision:1,locationRevision:1,canonicalPath:'/fixture/approved/private',filesystem:{device:'1',inode:'2',mountId:'3'},accessMode:'exclusive-write' as const,snapshotId:job.acceptedSpec.source.snapshotId,manifestDigest:job.acceptedSpec.source.manifestDigest}
    const material:SourceMaterializationRecord={receipt:{version:1,materializationId:randomUUID(),binding:root,placementHash:hash('source'),executionId:job.id,attemptId:job.attemptId,keyRevision:1,authorizationRevision:1,verifiedManifestDigest:root.manifestDigest,verifiedEntries:0,verifiedBytes:0,verifiedAt:job.createdAt,localTreeIdentity:{device:'1',inode:'4',mountId:'3'}},rootPolicyId:job.acceptedSpec.target.destination.rootPolicyId,rootPolicyRevision:'1',operationId:job.operationId,reservationId:randomUUID(),sourceBindingHash:hash('source'),finalDispatchBindingHash:job.acceptedSpec.bindingHash,state:'prepared'}
    job.acceptedSpec.source.materializationId=material.receipt.materializationId;job.acceptedSpec.source.materializationDigest=sourceMaterializationDigest(material)
    await pool.query('insert into job_executions values($1,$2,$3::jsonb,$4::jsonb,$5)',[job.id,job.workspaceId,JSON.stringify(job),JSON.stringify(job.acceptedSpec),'owner'])
    await pool.query('insert into job_definition_versions values($1,$2,$3,$4::jsonb)',[job.acceptedSpec.definitionVersionId,job.workspaceId,job.acceptedSpec.definitionId,JSON.stringify({schemaVersion:1,id:job.acceptedSpec.definitionId,workspaceId:job.workspaceId,name:'Original',revision:1,versionId:job.acceptedSpec.definitionVersionId,spec:{...jobSpec(),target:job.acceptedSpec.target,outputs:job.acceptedSpec.outputs},createdAt:job.createdAt,updatedAt:job.createdAt})])
    await pool.query('insert into source_root_catalog values($1,1)',[root.rootId])
    const rootRecord={version:1,source:{approvedSourceId:job.acceptedSpec.source.approvedSourceId,snapshotId:root.snapshotId,manifestDigest:root.manifestDigest},selection:{hostRef:job.acceptedSpec.target.hostRef,rootPolicyId:material.rootPolicyId,rootPolicyRevision:'1',locationRevision:'1'},binding:root,ownerPrincipalId:'owner',authorizedByPrincipalId:'owner',registration:job.acceptedSpec.target.registration,attestationId:'fixture',attestationDigest:hash('root'),boundAt:job.createdAt}
    await pool.query('insert into source_root_bindings values($1,1,$2,$3::jsonb)',[root.rootId,job.workspaceId,JSON.stringify(rootRecord)])
    await pool.query('insert into workspace_root_policies values($1,$2,$3,null)',[material.rootPolicyId,material.rootPolicyRevision,job.workspaceId])
    await pool.query('insert into source_execution_materializations values($1,$2,$3,$4,$5::jsonb,$6)',[material.receipt.materializationId,job.workspaceId,job.id,job.attemptId,JSON.stringify(material),'closed'])
    const approved={version:1,workspaceId:job.workspaceId,ownerPrincipalId:'owner',approvedByPrincipalId:'owner',locationRevision:1,mainId,originIdentityHash:`sha256:${hash('origin')}`,approvedAt:job.createdAt,availability:'retained',manifest:{version:1,snapshotId:root.snapshotId,approvedSourceId:job.acceptedSpec.source.approvedSourceId,capturePolicy:'git-tree-v1',executablePolicy:'strip',git:{commit:job.acceptedSpec.source.commit,tree:'2'.repeat(40),objectFormat:'sha1'},entries:[],deletions:[],totalEntries:0,totalBytes:0,manifestDigest:root.manifestDigest}}
    await pool.query('insert into source_snapshots values($1,$2,$3,$4,$5::jsonb,$6)',[job.workspaceId,root.snapshotId,job.acceptedSpec.source.approvedSourceId,root.manifestDigest,JSON.stringify(approved),'retained'])
    const sourceChecks=async(sql:JobSql)=>{const r=(await sql.query<{availability:string}>('select availability from source_snapshots for share')).rows[0];if(r?.availability!=='retained')throw new DomainError('SOURCE_UNAVAILABLE','Pinned fixture source unavailable.',410)}
    const dispatch=new PostgresJobDispatch(pool,{} as never,{revalidate:sourceChecks,authorizeControl:sourceChecks,observe:async()=>{throw new Error('Receipt mutation is outside this fixture')}})
    const authority=new JobPublicationAuthority(dispatch,{revalidateAccepted:sourceChecks})
    storage=await mkdtemp(join(process.env.FOREMAN_CODE_TEST_ROOT!,'.job-admission-canonical-'));staging=await mkdtemp(join(process.env.FOREMAN_CODE_TEST_ROOT!,'job-admission-staging-'))
    endpoint=new DeviceEndpoint({mainId,appVersion:'fixture',auth:access,signMainIdentityProof:async request=>signMainIdentityProof(identity,request,'fixture'),reconcile:async()=>{},presence:()=>{},extensions:[]})
    actual=createAdmittedJobOutputs({pool,storageRoot:storage,stagingRoot:staging,endpoint,authority})
    // Build the genuine endpoint with the concrete C/B handler before handshake.
    endpoint=new DeviceEndpoint({mainId,appVersion:'fixture',auth:access,signMainIdentityProof:async request=>signMainIdentityProof(identity,request,'fixture'),reconcile:async()=>{},presence:()=>{},extensions:[{...actual.extension,handle:async(payload,context)=>actual.extension.handle!(payload,context)}]})
    actual=createAdmittedJobOutputs({pool,storageRoot:storage,stagingRoot:staging,endpoint,authority})
    incoming=queue();outgoing=queue();endpointTask=endpoint.accept({authorization:`Bearer ${credential}`},{messages:incoming,bufferedAmount:0,send:value=>outgoing.push(String(value)),close:()=>incoming.end()})
    incoming.push(JSON.stringify({type:'hello',protocolVersion:1,appVersion:'fixture',mainId,deviceId:paired.registration.deviceId,workerInstallationId,keyRevision:1,authorizationRevision:1,bootId:randomUUID(),connectionEpoch:randomUUID(),connectionGeneration:1,nonce:randomBytes(32).toString('base64url'),extensions:[{namespace:'byte-transfer-v1',version:1,role:'client',maxJsonBytes:16384,maxBinaryBytes:8192}]}))
    const welcome=JSON.parse((await outgoing.next()).value!);expect(welcome.type).toBe('welcome');expect(welcome.mainIdentityProof.request.negotiationHash).toBe(deviceNegotiationHash(welcome.capabilities.extensions))
    incoming.push(JSON.stringify({type:'ready',connectionEpoch:welcome.connectionEpoch}))
    binding = (await readUntil(
      async () => endpoint.currentBinding(paired.registration.deviceId, 'byte-transfer-v1'),
      value => value !== undefined, { timeoutMs: 10_000, description: 'the byte-transfer session binding' },
    ))!
    expect(binding).toBeDefined()
    ownership=await JobOwnership.acquire(pool,job.id,()=>{});expect(ownership).toBeDefined()
    const ownerFence=await ownership!.connection.transaction(sql=>ownership!.readFence(sql))
    const intent={schemaVersion:1,protocolVersion:1,mainId,subject:{kind:'manual-job',workspaceId:job.workspaceId,jobExecutionId:job.id,definitionId:job.acceptedSpec.definitionId},executionId:job.id,attemptId:job.attemptId,operationId:job.operationId,bindingHash:job.acceptedSpec.bindingHash,inputDigest:`sha256:${job.acceptedSpec.specDigest}`,owner:job.owner}
    const originalConnection={mainId:binding.mainId,deviceId:binding.deviceId,workerInstallationId:binding.workerInstallationId,keyRevision:binding.keyRevision,authorizationRevision:binding.authorizationRevision,bootId:binding.bootId,connectionGeneration:binding.connectionGeneration}
    const receipt={schemaVersion:1,kind:'job',intent,execution:job,connection:originalConnection,workerIncarnationId:randomUUID(),sequence:1,observedAt:job.createdAt,phase:'confirmed_terminal',entryAttempted:true,stopFence:false,native:{containerId:'fixture-original-container',supervisorIdentity:'fixture-original-supervisor',processIdentityDigest:hash('fixture-process'),startedAt:job.createdAt},controls:[],terminal:{finishedAt:job.finishedAt,closureEvidenceDigest:hash('fixture-closure'),outcome:'succeeded',exitCode:0,signal:null,processStopped:true,resultDigest:hash('fixture-result'),logGapPossible:false,logsTruncated:false,outputCollectionError:false,artifactDigests:[]},publication:'process_recorded'}
    await pool.query('insert into job_dispatch_intents(execution_id,workspace_id,intent,last_receipt,receipt_sequence,owner_id,owner_fence) values($1,$2,$3::jsonb,$4::jsonb,1,$5,$6)',[job.id,job.workspaceId,JSON.stringify(intent),JSON.stringify(receipt),ownerFence.ownerId,ownerFence.fence])
    app=Fastify();app.setErrorHandler((error,_request,reply)=>{void reply.code(error instanceof DomainError?error.status:500).send({error:error instanceof DomainError?error.code:'ERROR'})})
    registerJobOutputMetadataEndpoints(app,{access,endpoint,admission:actual.admission,artifacts:actual.artifacts})
    address=await app.listen({host:'127.0.0.1',port:0})
    const clients = await Promise.all(Array.from({ length: 3 }, () => pool.connect()))
    for (const client of clients) client.release()
    mcpClient = new Client({ name: 'job-output-fixture', version: '1.0.0' })
    await mcpClient.connect(new StreamableHTTPClientTransport(new URL('/device/mcp/job-outputs', address), {
      authProvider: { token: async () => credential },
    }))
  },60000)
  afterAll(async()=>{await mcpClient?.close();await app?.close();endpoint?.close();incoming?.end();await endpointTask?.catch(()=>{/* ignore: closing the endpoint ends its session; the test asserted its behavior already */});await actual?.receiver.close();await ownership?.release();await pool?.end();if(storage)await removeFixtureDirectory(storage);if(staging)await removeFixtureDirectory(staging);if(admin){try{await dropFixtureSchema(admin, schema)}finally{await admin.end()}}})
  it('issues persisted original main transfer through HTTP/MCP, denies Operator and publishes actual sender bytes once',async()=>{
    const input={workspaceId:job.workspaceId,executionId:job.id,attemptId:job.attemptId,owner:job.owner,commandId:randomUUID(),path:'dist/report.json',mediaType:'application/json' as const,sha256:hash(body),byteSize:body.length}
    expect((await app.inject({method:'POST',url:'/device/job-outputs/admit',headers:{authorization:`Bearer ${operatorToken}`},payload:input})).statusCode).toBe(403)
    expect((await app.inject({method:'POST',url:'/device/mcp/job-outputs',headers:{authorization:`Bearer ${operatorToken}`,accept:'application/json, text/event-stream'},payload:{jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'job_output_admit',arguments:input}}})).statusCode).toBe(403)
    const first=await app.inject({method:'POST',url:'/device/job-outputs/admit',headers:{authorization:`Bearer ${credential}`},payload:input});expect(first.statusCode).toBe(200);const intent=first.json()
    const mcp=await mcpClient!.callTool({name:'job_output_admit',arguments:input})
    expect(mcp.isError,JSON.stringify(mcp)).not.toBe(true);expect(decodeMcpToolResult(mcp)).toEqual(intent)
    const channel={request:async(_namespace:string,payload:unknown,options?:{bytes?:Uint8Array})=>actual.extension.handle!(payload,{binding,signal:AbortSignal.timeout(10000),...(options?.bytes?{bytes:options.bytes}:{})})}
    const sender=new ResumableByteTransferSender(new WorkerJobOutputReceiver(channel),{read:async(_intent,offset,length)=>body.subarray(offset,offset+length)},{current:async()=>outputTransferContext(binding),retryable:()=>false})
    const verified=await sender.send(intent,AbortSignal.timeout(10000));expect(verified.sha256).toBe(input.sha256)
    const published=await app.inject({method:'POST',url:'/device/job-outputs/publish',headers:{authorization:`Bearer ${credential}`},payload:input});expect(published.statusCode).toBe(200)
    const replay=await app.inject({method:'POST',url:'/device/job-outputs/publish',headers:{authorization:`Bearer ${credential}`},payload:input});expect(replay.json()).toEqual(published.json())
    const artifact=published.json();await withTransaction(pool,async sql=>{const principal=await new PostgresAccessService(pool).authenticate(operatorToken);expect((await actual.artifacts.read(sql,principal,job.workspaceId,job.id,artifact.fileId,artifact.revisionId)).bytes).toEqual(body)})
    const counts=(await pool.query("select (select count(*) from management_command_receipts where operation='job.output.admit')::int admissions,(select count(*) from file_tool_publications)::int publications,(select count(*) from file_allocations where state='finalized')::int allocations")).rows[0];expect(counts).toEqual({admissions:1,publications:1,allocations:1})
    await pool.query("update device_registrations set record=jsonb_set(record,'{status}','\"revoked\"'::jsonb) where id=$1",[binding.deviceId])
    await expect(actual.receiver.resolveVerifiedReceipt(intent.transferId,outputTransferContext(binding))).rejects.toMatchObject({code:'JOB_OUTPUT_DEVICE_REVOKED'})
  })
})
