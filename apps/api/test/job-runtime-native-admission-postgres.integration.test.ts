import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { randomUUID,createHash } from 'node:crypto'
import pg from 'pg'
import { Client,StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { beforeAll,afterAll,describe,it,expect } from 'vitest'
import { buildApp } from '../src/app.js'
import { registerJobRuntimeProfileRoutes } from '../src/routes/jobRuntimeProfiles.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { JobRuntimeProfiles } from '../src/modules/jobs/runtimeProfiles.js'
import { admitInstalledJobQualification } from '../src/modules/jobs/runtimeQualificationAdmission.js'
import { jobRuntimeProfilesMigration } from '../src/infrastructure/jobRuntimeProfilesMigration.js'
import { jobRuntimeNativeAdmissionMigration } from '../src/infrastructure/jobRuntimeNativeAdmissionMigration.js'
import { JobRuntimeProfileSchema,JobRuntimeFingerprintSchema,JobRuntimeApprovalSchema } from '@foreman-code/contracts/job-runtime'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { PostgresSourceService } from '../src/modules/sources/service.js'
import type { JobQualificationCandidate } from '../src/modules/jobs/qualification.js'
import { jobDigest } from '../src/modules/jobs/service.js'
import { jobSpec } from './helpers/jobFixture.js'
const uuid='11111111-1111-4111-8111-111111111111',digest='1'.repeat(64)
const principal:ManagementPrincipal={id:'runtime-reader',name:'Runtime reader',audience:'operator',grants:[{actions:['job_definitions:read','job_definitions:write'],scope:{workspaceIds:['workspace-fixture']}}],expiresAt:'2099-01-01T00:00:00.000Z',revokedAt:null}
const root=SourceRootRecordSchema.parse({version:1,source:{approvedSourceId:uuid,snapshotId:uuid,manifestDigest:digest},selection:{hostRef:{kind:'main',mainId:uuid},rootPolicyId:'root-policy',rootPolicyRevision:'1',locationRevision:'1'},binding:{version:1,mainId:uuid,deviceId:null,workerInstallationId:null,workspaceId:'workspace-fixture',rootId:uuid,bindingRevision:1,locationRevision:1,canonicalPath:'/approved',filesystem:{device:'1',inode:'2',mountId:'3'},accessMode:'exclusive-write',snapshotId:uuid,manifestDigest:digest},ownerPrincipalId:principal.id,authorizedByPrincipalId:principal.id,registration:null,attestationId:'actual-test-attestation',attestationDigest:digest,boundAt:'2026-10-01T00:00:00.000Z'})
const profile=JobRuntimeProfileSchema.parse({schemaVersion:1,id:'runtime-profile',workspaceId:'workspace-fixture',revision:1,name:'Runtime metadata',root,policy:{...jobSpec().policy,isolationPolicyId:'runtime-profile'},limits:{cpuLimit:1,memoryBytes:1024,pidsLimit:32,diskBytes:8192},specDigest:digest,status:'unqualified',measurement:null,createdAt:'2026-10-01T00:00:00.000Z',updatedAt:'2026-10-01T00:00:00.000Z'})
const fingerprint=JobRuntimeFingerprintSchema.parse({schemaVersion:1,profileId:profile.id,profileRevision:1,specDigest:digest,hostRef:root.selection.hostRef,registration:null,mainInstallationId:uuid,bootId:uuid,root,runtimeExecutable:'/usr/bin/podman',runtimeBinarySha256:digest,ociExecutable:'/usr/bin/crun',ociBinarySha256:digest,configurationDigest:digest,imageDigest:profile.policy.imageDigest,toolchainDigest:digest,limits:profile.limits})
const approval=JobRuntimeApprovalSchema.parse({schemaVersion:1,id:uuid,qualificationId:uuid,workspaceId:profile.workspaceId,profileId:profile.id,profileRevision:1,fingerprint,fingerprintDigest:digest,requestedByPrincipalId:principal.id,status:'awaiting-approval',approvedByPrincipalId:null,approvedAt:null,expiresAt:'2099-01-01T00:00:00.000Z'})


const url=process.env.TEST_DATABASE_URL
/** Real original Main row/lease and authenticated readback; no native execution or readiness claim. */
describe.skipIf(!url)('Main qualification admission PostgreSQL and authenticated MCP readback',()=>{
  let admin:pg.Pool,pool:pg.Pool,app:ReturnType<typeof buildApp>,address:string
  const schema=`runtime_admission_${randomUUID().replaceAll('-','')}`,token=randomUUID(),clients:Client[]=[]
  const approved={...approval,status:'approved' as const,fingerprintDigest:jobDigest(fingerprint),approvedByPrincipalId:principal.id,approvedAt:'2026-10-01T00:00:00.000Z'}
  beforeAll(async()=>{
    const parsed=new URL(url!)
    if(!['postgres:','postgresql:'].includes(parsed.protocol)||!['localhost','127.0.0.1','[::1]'].includes(parsed.hostname)||!parsed.pathname.toLowerCase().includes('test'))throw new Error('Explicit owned loopback TEST_DATABASE_URL required')
    admin=new pg.Pool({connectionString:url});await createFixtureSchema(admin, schema)
    pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`})
    await pool.query(`create table workspaces(id text primary key,archived_at timestamptz);
      create table application_installation(singleton boolean primary key,id text);
      create table source_root_bindings(root_id uuid,binding_revision bigint,workspace_id text,record jsonb,primary key(root_id,binding_revision));
      create table source_root_catalog(root_id uuid,workspace_id text,current_binding_revision bigint);
      create table workspace_root_policies(workspace_id text,root_policy_id text,root_policy_revision bigint,revoked_at timestamptz);
      create table management_principals(id text primary key,name text,audience text,agent_id text,token_hash text,grants jsonb,expires_at timestamptz,revoked_at timestamptz,delegated_from text);
      create table management_command_receipts(principal_id text,operation text,command_id text,target_key text,input_hash text,result jsonb,primary key(principal_id,operation,command_id));
      create table management_audit(sequence bigint generated always as identity,principal_id text,source text,action text,target_key text,outcome text,details jsonb,occurred_at timestamptz default now());`)
    await pool.query(jobRuntimeProfilesMigration.sql);await pool.query(jobRuntimeNativeAdmissionMigration.sql)
    await pool.query('insert into workspaces values($1,null)',[profile.workspaceId]);await pool.query('insert into application_installation values(true,$1)',[uuid])
    await pool.query('insert into source_root_bindings values($1,1,$2,$3::jsonb)',[uuid,profile.workspaceId,JSON.stringify(root)])
    await pool.query('insert into source_root_catalog values($1,$2,1)',[uuid,profile.workspaceId])
    await pool.query('insert into workspace_root_policies values($1,$2,1,null)',[profile.workspaceId,root.selection.rootPolicyId])
    await pool.query('insert into management_principals values($1,$2,$3,null,$4,$5::jsonb,$6,null,null)',[principal.id,principal.name,principal.audience,createHash('sha256').update(token).digest('hex'),JSON.stringify(principal.grants),principal.expiresAt])
    await pool.query('insert into job_runtime_profiles values($1,$2,1,$3,1,$4::jsonb)',[profile.id,profile.workspaceId,uuid,JSON.stringify({...profile,status:'qualifying'})])
    await pool.query('insert into job_runtime_profile_versions values($1,1,$2::jsonb)',[profile.id,JSON.stringify(profile)])
    await pool.query('insert into job_runtime_qualification_approvals(id,qualification_id,profile_id,profile_revision,workspace_id,record,run_command_id,run_principal_id,requested_by,approved_by) values($1,$1,$2,1,$3,$4::jsonb,$5,$6,$6,$6)',[uuid,profile.id,profile.workspaceId,JSON.stringify({...approved,status:'qualifying'}),'actual-command',principal.id])
    await pool.query('insert into management_command_receipts values($1,$2,$3,$4,$5,$6::jsonb)',[principal.id,'job.runtime-profile.approve','browser-receipt',profile.workspaceId,'fixture',JSON.stringify(approved)])
    const commands=new PostgresCommandCoordinator(pool),service=new JobRuntimeProfiles(pool,commands,{} as PostgresSourceService,{capture:async()=>{throw new Error('No capture in readback')},run:async()=>{throw new Error('No native entry in readback')},revalidate:async()=>({ready:false,reasons:['UNQUALIFIED']})})
    app=buildApp({readiness:{database:{ping:async()=>{}},checkpoints:{ping:async()=>{}}},operator:{access:new PostgresAccessService(pool),services:{commands,jobRuntimeProfiles:service} as OperatorServices}})
    registerJobRuntimeProfileRoutes(app,service)
    address=await app.listen({host:'127.0.0.1',port:0})
  },60000)
  afterAll(async()=>{await Promise.allSettled(clients.map(c=>c.close()));await app?.close();await pool?.end();if(admin){await dropFixtureSchema(admin, schema);await admin.end()}})
  it('reads stored profile states consistently over HTTP and authenticated MCP and denies an ungranted caller', async () => {
    const client = new Client({ name: 'profile-state-tests', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }))
    const deniedToken = randomUUID()
    await pool.query('insert into management_principals values($1,$2,$3,null,$4,$5::jsonb,$6,null,null)', [
      'runtime-denied', 'No runtime access', 'operator',
      createHash('sha256').update(deniedToken).digest('hex'), '[]', principal.expiresAt,
    ])
    const deniedClient = new Client({ name: 'denied-profile-state-tests', version: '1' })
    clients.push(deniedClient)
    await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { Authorization: `Bearer ${deniedToken}` } },
    }))
    const previous = (await pool.query<{ record: unknown }>(
      'select record from job_runtime_profiles where id=$1', [profile.id],
    )).rows[0]!.record
    try {
      for (const status of ['unqualified', 'qualified', 'failed', 'recovery-required'] as const) {
        const stored = { ...profile, status }
        await pool.query('update job_runtime_profiles set record=$2::jsonb where id=$1', [profile.id, JSON.stringify(stored)])
        const read = await client.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId: profile.workspaceId } })
        expect(read.isError).not.toBe(true)
        const response = await app.inject({ url: `/api/management/workspaces/${profile.workspaceId}/jobs/runtime-profiles`,
          headers: { authorization: `Bearer ${token}` } })
        expect(response.statusCode).toBe(200)
        expect(decodeMcpToolResult(read)).toEqual(response.json())
        expect(response.json().profiles[0]).toMatchObject({ profile: stored, ready: false, sideEffects: false })
        expect((await pool.query('select record from job_runtime_profiles where id=$1', [profile.id])).rows[0].record)
          .toEqual(stored)
      }
      const denied = await deniedClient.callTool({ name: 'job_runtime_profile_list', arguments: { workspaceId: profile.workspaceId } })
      expect(denied.isError).toBe(true)
    } finally {
      await pool.query('update job_runtime_profiles set record=$2::jsonb where id=$1', [profile.id, JSON.stringify(previous)])
    }
  })

  it('commits one exact lease, reads it over HTTP/MCP, denies foreign scope and enforces immutable storage',async()=>{
    const sql=await pool.connect()
    const input={candidate:{approvalId:uuid,qualificationId:uuid,operationId:uuid,fingerprint} as JobQualificationCandidate,runCommandId:'actual-command',runPrincipalId:principal.id,
      resolveRoot:async()=>root,readCurrent:async()=>({fingerprint,connection:null})}
    let admission
    try {await sql.query('begin');admission=await admitInstalledJobQualification(sql,input);expect(await admitInstalledJobQualification(sql,input)).toEqual(admission);await sql.query('commit')}finally{sql.release()}
    const http=await app.inject({method:'GET',url:`/api/management/workspaces/${profile.workspaceId}/jobs/runtime-qualifications/${uuid}`,headers:{authorization:`Bearer ${token}`}})
    expect(http.statusCode).toBe(200);expect(http.json().nativeAdmission).toEqual(admission);expect(http.json().measurement).toBeNull()
    const client=new Client({name:'runtime-admission-tests',version:'1'});clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',address),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}))
    const read=await client.callTool({name:'job_runtime_qualification_get',arguments:{workspaceId:profile.workspaceId,approvalId:uuid}})
    expect(read.isError).not.toBe(true);expect(decodeMcpToolResult(read)).toEqual(http.json())
    const denied=await client.callTool({name:'job_runtime_qualification_get',arguments:{workspaceId:'foreign',approvalId:uuid}})
    expect(denied.isError).toBe(true)
    await expect(pool.query('update job_runtime_qualification_approvals set native_admission=null where id=$1',[uuid])).rejects.toThrow('JOB_RUNTIME_NATIVE_ADMISSION_IMMUTABLE')
    await pool.query('update management_principals set revoked_at=now() where id=$1',[principal.id])
    await expect(admitInstalledJobQualification(pool,input)).rejects.toThrow()
    expect((await pool.query('select native_admission from job_runtime_qualification_approvals where id=$1',[uuid])).rows[0].native_admission).toEqual(admission)
  })
})
