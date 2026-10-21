import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { logArchive } from '../../../scripts/verification-reports.mjs'
import { integrationEnvironmentCapabilities, partitionIntegrationCapabilities, partitionUnitCapabilities }
  from '../../../scripts/integration-capabilities.mjs'
import { integrationReport } from '../../../scripts/test-integration.mjs'
import { AutoJobDefinitionSpecSchema, JobArtifactReadOutputSchema, jobPolicyRequirements } from '@foreman-code/contracts/jobs'
import { execFileSync } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createFixtureSchema, dropFixtureSchema, removeFixtureDirectory } from './helpers/testResources.js'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import pg from 'pg'
import Fastify, { type FastifyInstance } from 'fastify'
import { McpServer } from '@modelcontextprotocol/server'
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { JobExecutionRecordSchema, type JobExecutionRecord, VerificationJobExecutionSchema,
  JobVerificationReportSchema } from '@foreman-code/contracts/job-verification'
import { JobRuntimeApprovalRecordSchema, JobRuntimeQualificationReadRecordSchema }
  from '@foreman-code/contracts/job-verification-runtime'
import { verificationJobLifecycle } from '@foreman-code/contracts/job-verification-policy'
import { verificationFixture } from './helpers/jobVerificationFixture.js'
import { verificationRuntimeFixture } from './helpers/verificationRuntimeFixture.js'
import { qualificationReportFixture } from './helpers/qualificationReportFixture.js'
import { fileStorageMigration } from '../src/infrastructure/fileStorageMigration.js'
import { fileToolsMigration } from '../src/modules/files/tools/migration.js'
import { jobArtifactStorageMigration } from '../src/infrastructure/jobArtifactStorageMigration.js'
import { jobArtifactXmlMigration } from '../src/infrastructure/jobArtifactXmlMigration.js'
import { JobPublicationAuthority } from '../src/modules/jobs/authority.js'
import { JobService } from '../src/modules/jobs/service.js'
import { createCanonicalJobArtifactPort } from '../src/modules/files/jobs/factory.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { registerJobRoutes } from '../src/routes/jobs.js'
import { registerJobTools, unavailableJobToolCall } from '../src/mcp/operator/tools/jobs.js'
import { registerJobRuntimeTools, unavailableJobRuntimeToolCall } from '../src/mcp/operator/tools/jobRuntimeProfiles.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { createQualificationReportPublisher } from '../src/modules/jobs/qualificationReports.js'
import { publishFailedQualification } from '../src/modules/jobs/qualificationExecution.js'
import { JobRuntimeProfiles } from '../src/modules/jobs/runtimeProfiles.js'
import type { PostgresSourceService } from '../src/modules/sources/service.js'
import { jobDigest } from '../src/modules/jobs/digest.js'
import { DomainError } from '../src/modules/errors.js'
import { jobExecution, jobSpec } from './helpers/jobFixture.js'
const databaseUrl=process.env.TEST_DATABASE_URL
const digest=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex')
/** Root-only fixture: real canonical storage/ledger, live grants, actual CI HTTP and SDK MCP tools.
 * Qualified W07/container launch remains a separate real-device acceptance gate. */
describe.skipIf(!databaseUrl).each(['fixed', 'auto', 'verification'] as const)('CI canonical artifact authenticated persistence (%s)', placementMode=>{
  const schema=`ci_artifacts_${randomUUID().replaceAll('-','')}`
  let admin:pg.Pool,pool:pg.Pool,root:string,app:FastifyInstance
  let address: string
  const clients: Client[] = []
  let artifacts:ReturnType<typeof createCanonicalJobArtifactPort>
  let jobRuntimeProfiles: JobRuntimeProfiles | undefined
  let execution: JobExecutionRecord = jobExecution()
  const ownerToken=`fixture-owner-${randomUUID()}`,deniedToken=`fixture-denied-${randomUUID()}`
  let data: Buffer = Buffer.from('{"build":"passed"}')
  const outputPath = 'dist/report.json'
  beforeAll(async()=>{
    const url=new URL(databaseUrl!)
    if(!['postgres:','postgresql:'].includes(url.protocol)||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!/test/i.test(url.pathname))throw new Error('Explicit owned loopback TEST_DATABASE_URL required.')
    admin=new pg.Pool({connectionString:databaseUrl});await createFixtureSchema(admin, schema)
    pool=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`})
    await pool.query(`create table operator_conversations(id text primary key);
      create table management_principals(id text primary key,name text,audience text,agent_id text,token_hash text,grants jsonb,expires_at timestamptz,revoked_at timestamptz,delegated_from text);
      create table management_audit(principal_id text,source text,action text,target_key text,outcome text,details jsonb);
      create table job_executions(id text primary key,workspace_id text,record jsonb,accepted_spec jsonb,accepted_by text);
      create table job_definition_versions(id text primary key,workspace_id text,definition_id text,record jsonb);
      create table runs(id text primary key,workspace_id text,workflow_id text);
      create table job_fixture_owner(grant_id text primary key,epoch text,revoked boolean,root_valid boolean);
      insert into job_fixture_owner values('grant-fixture','1',false,true);`)
    await pool.query(fileStorageMigration.sql);await pool.query(fileToolsMigration.sql);await pool.query(jobArtifactStorageMigration.sql)
    await pool.query(jobArtifactXmlMigration.sql)
    for(const [id,token,actions] of [['owner',ownerToken,['jobs:start','job_artifacts:read']],['denied',deniedToken,['jobs:read']]] as const){
      await pool.query("insert into management_principals values($1,$1,'operator',null,$2,$3::jsonb,'2099-01-01',null,null)",[id,digest(token),JSON.stringify([{actions,scope:{workspaceIds:[execution.workspaceId]}}])])
    }
    execution.process={phase:'terminal',outcome:'succeeded',exitCode:0,signal:null,processStopped:true};execution.finishedAt=execution.createdAt
    execution = JobExecutionRecordSchema.parse({ ...execution, acceptedSpec: { ...execution.acceptedSpec,
      outputs: [{path:outputPath,required:true,mediaType:'application/json'}] } })
    if (placementMode === 'verification') {
      const facts = verificationFixture()
      const runtime = verificationRuntimeFixture()
      execution = VerificationJobExecutionSchema.parse({ ...execution, schemaVersion: 2,
        acceptedSpec: { ...execution.acceptedSpec, schemaVersion: 2, policy: facts.spec.policy,
          resourcePolicyRevision: runtime.spec.resourcePolicyRevision,
          resourcePolicyDigest: runtime.spec.resourcePolicyDigest,
          runtimeApprovalId: runtime.spec.runtimeApprovalId,
          runtimeApprovalRevision: runtime.spec.runtimeApprovalRevision,
          verification: facts.spec.verification, profile: facts.profile, reservationId: randomUUID(),
          lifecycle: verificationJobLifecycle(new Date().toISOString(), facts.spec.policy), outputs: [{ path: outputPath, required: true,
            mediaType: 'application/json', kind: 'suite-summary', maxBytes: 4096 }] } })
      const spec = execution.acceptedSpec
      data = Buffer.from(JSON.stringify(JobVerificationReportSchema.parse({ schemaVersion: 1,
        commit: spec.source.commit, manifestDigest: spec.source.manifestDigest,
        definitionVersionId: spec.definitionVersionId, suite: spec.verification.suite,
        executionId: execution.id, attemptId: execution.attemptId, target: spec.target,
        profile: spec.profile, resources: spec.verification.resources, parameters: spec.verification.parameters,
        startedAt: execution.createdAt, finishedAt: execution.finishedAt,
        totals: { total: 1, passed: 1, failed: 0, skipped: 0 }, firstPassFailed: 0,
        expectedPortions: 1, completedPortions: 1, disallowedSkipped: 0, completeness: 'complete', outcome: 'passed',
      })))
    }
    if (placementMode === 'auto') execution = JobExecutionRecordSchema.parse({ ...execution, acceptedSpec: { ...execution.acceptedSpec,
      computerSelection: { mode: 'auto', buildPriority: 100, settingsRevision: 1 } } })
    await pool.query('insert into job_executions values($1,$2,$3::jsonb,$4::jsonb,$5)',[execution.id,execution.workspaceId,JSON.stringify(execution),JSON.stringify(execution.acceptedSpec),'owner'])
    const definition={schemaVersion:execution.schemaVersion,id:execution.acceptedSpec.definitionId,workspaceId:execution.workspaceId,name:'Original',revision:execution.acceptedSpec.definitionRevision,versionId:execution.acceptedSpec.definitionVersionId,spec:placementMode === 'auto' ? AutoJobDefinitionSpecSchema.parse({ ...jobSpec(),
      outputs: execution.acceptedSpec.outputs, target: { kind: 'auto' }, policy: jobPolicyRequirements(jobSpec().policy),
      limits: { cpuLimit: 1, memoryBytes: 67108864, diskBytes: 8388608, pidsLimit: 32 } })
      : placementMode === 'verification' ? { ...verificationFixture().spec,
        target: execution.acceptedSpec.target, source: jobSpec().source, outputs: execution.acceptedSpec.outputs }
      : {...jobSpec(),outputs:execution.acceptedSpec.outputs},createdAt:execution.createdAt,updatedAt:execution.createdAt}
    await pool.query('insert into job_definition_versions values($1,$2,$3,$4::jsonb)',[definition.versionId,definition.workspaceId,definition.id,JSON.stringify(definition)])
    if (placementMode === 'verification') {
      await pool.query(`create table workspaces(id text primary key,archived_at timestamptz);
        create table job_runtime_profiles(id text primary key,workspace_id text,record jsonb);
        create table job_runtime_qualification_approvals(id uuid primary key,workspace_id text,record jsonb,
          measurement jsonb,run_result jsonb,native_admission jsonb,run_command_id text,run_principal_id text);
        create table management_command_receipts(principal_id text,operation text,command_id text,target_key text,
          input_hash text,result jsonb,primary key(principal_id,operation,command_id));
        create table job_definitions(id text primary key,workspace_id text,revision bigint,version_id text,
          record jsonb,updated_by text);
        alter table job_definition_versions add column revision bigint;
        alter table job_executions add column definition_version_id text,add column operation_id text,add column attempt_id text;`)
    }
    root=await mkdtemp(join(process.env.FOREMAN_CODE_TEST_ROOT!,'.ci-artifact-db-'))
    const authority=new JobPublicationAuthority({require:async(sql,job,fence)=>{
      const r=(await sql.query<{epoch:string;revoked:boolean}>('select epoch,revoked from job_fixture_owner where grant_id=$1 for share',[fence.owner.grantId])).rows[0]
      if(!r||r.revoked||r.epoch!==fence.owner.epoch||job.attemptId!==fence.attemptId)throw new DomainError('JOB_OWNER_REVOKED','Owner denied.',403)
    }},{revalidateAccepted:async sql=>{const r=(await sql.query<{root_valid:boolean}>('select root_valid from job_fixture_owner for share')).rows[0];if(r?.root_valid!==true)throw new DomainError('JOB_AUTHORITY_CHANGED','Accepted fixture root is unavailable.',409)}})
    artifacts=createCanonicalJobArtifactPort({pool,storageRoot:root,authority,reader:{open:async()=>Readable.from([data])}})
    const commands=new PostgresCommandCoordinator(pool)
    const jobs=new JobService(pool,commands,{preparation:{} as never,dispatch:{} as never,artifacts})
    app=Fastify();app.decorateRequest('operatorPrincipal',undefined)
    app.addHook('onRequest',async request=>{const token=/^Bearer (.+)$/.exec(request.headers.authorization??'')?.[1];request.operatorPrincipal=await new PostgresAccessService(pool).authenticate(token)})
    app.setErrorHandler((error,_request,reply)=>{void reply.code(error instanceof DomainError?error.status:500).send({error:error instanceof DomainError?error.code:'ERROR'})})
    registerJobRoutes(app,jobs)
    app.post('/mcp',async(request,reply)=>{
      const server=new McpServer({name:'ci-artifact-fixture',version:'1'})
      const context={principal:request.operatorPrincipal!,services:{jobs,commands,
        ...(jobRuntimeProfiles ? { jobRuntimeProfiles } : {})}}
      const unavailable=await unavailableJobToolCall(context,request.body)
        ?? await unavailableJobRuntimeToolCall(context,request.body)
      if(unavailable)return reply.send(unavailable)
      registerJobTools(server,context)
      registerJobRuntimeTools(server,context)
      const transport=new NodeStreamableHTTPServerTransport({sessionIdGenerator:undefined})
      reply.raw.once('close',()=>{void Promise.allSettled([transport.close(),server.close()])})
      await server.connect(transport);reply.hijack();await transport.handleRequest(request.raw,reply.raw,request.body)
    })
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  })
  afterAll(async()=>{await Promise.allSettled(clients.map(client=>client.close()));await app?.close();await pool?.end();if(root)await removeFixtureDirectory(root);if(admin){try{await dropFixtureSchema(admin, schema)}finally{await admin.end()}}})
  it('finalizes and adopts one exact standalone artifact, then authenticates HTTP/MCP readback and denial',async()=>{
    const input={workspaceId:execution.workspaceId,executionId:execution.id,attemptId:execution.attemptId,owner:execution.owner,
      commandId:'ci-output-command',path:outputPath,mediaType:'application/json' as const,sha256:digest(data),byteSize:data.length}
    const publication=await artifacts.publishAccepted(input),replay=await artifacts.publishAccepted(input,'mcp')
    expect(replay.artifact).toEqual(publication.artifact);expect(replay.replayed).toBe(true)
    await artifacts.verifyRequiredOutputs(pool,execution)
    const p=publication.artifact,base=`/api/management/workspaces/${execution.workspaceId}/jobs/executions/${execution.id}/artifacts`
    const listed=await app.inject({method:'GET',url:base,headers:{authorization:`Bearer ${ownerToken}`}})
    expect(listed.json().artifacts).toEqual([p])
    const read=await app.inject({method:'GET',url:`${base}/${p.fileId}/revisions/${p.revisionId}/content`,headers:{authorization:`Bearer ${ownerToken}`}})
    expect(read.rawPayload).toEqual(data);expect(read.headers['x-artifact-sha256']).toBe(p.sha256)
    const denied=await app.inject({method:'GET',url:base,headers:{authorization:`Bearer ${deniedToken}`}})
    expect(denied.statusCode).toBe(403)
    const ownerClient = new Client({ name: 'artifact-owner', version: '1' })
    clients.push(ownerClient)
    await ownerClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${ownerToken}` } },
    }))
    const artifactArguments = { workspaceId: execution.workspaceId, executionId: execution.id,
      fileId: p.fileId, revisionId: p.revisionId }
    const result = await ownerClient.callTool({ name: 'job_artifact_read', arguments: artifactArguments })
    expect(decodeMcpToolResult(result)).toMatchObject({ artifact: p, content: data.toString('base64') })
    const deniedClient = new Client({ name: 'artifact-reader', version: '1' })
    clients.push(deniedClient)
    await deniedClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      requestInit: { headers: { authorization: `Bearer ${deniedToken}` } },
    }))
    const deniedRpc = await deniedClient.callTool({ name: 'job_artifact_read', arguments: artifactArguments })
    expect(deniedRpc.isError).toBe(true)
    const counts=(await pool.query(`select (select count(*) from file_tool_publications)::int as publications,(select count(*) from file_allocations where state='finalized')::int as allocations,(select count(*) from files where scope_kind='job_execution' and conversation_id is null and run_id is null and agent_id is null)::int as explicit_scopes`)).rows[0]
    expect(counts).toEqual({publications:1,allocations:1,explicit_scopes:1})
    const stored=JobExecutionRecordSchema.parse((await pool.query('select record from job_executions where id=$1',[execution.id])).rows[0].record)
    expect(stored.workflow).toBe(null)
    expect(stored.acceptedSpec.computerSelection).toEqual(execution.acceptedSpec.computerSelection)
    await pool.query('update job_fixture_owner set revoked=true')
    await expect(artifacts.publishAccepted(input)).rejects.toMatchObject({code:'JOB_OWNER_REVOKED'})
    await pool.query("update files set state='expired' where file_id=$1",[p.fileId])
    const expired=await app.inject({method:'GET',url:`${base}/${p.fileId}/revisions/${p.revisionId}/content`,headers:{authorization:`Bearer ${ownerToken}`}})
    expect(expired.statusCode).toBe(410)
  })
  it('publishes repetitive generated logs through canonical storage and reads persisted bytes', async () => {
    await pool.query('update job_fixture_owner set revoked=false')
    const logPath = '.logs/verification/logs.tar.gz'
    const output = { path: logPath, required: true, mediaType: 'application/gzip' as const,
      ...(execution.schemaVersion === 2 ? { kind: 'logs-archive' as const, maxBytes: 65536 } : {}) }
    const job = JobExecutionRecordSchema.parse({ ...execution, id: randomUUID(), attemptId: randomUUID(),
      acceptedSpec: { ...execution.acceptedSpec,
        policy: { ...execution.acceptedSpec.policy, maxOutputBytes: 128 * 1024 },
        outputs: execution.schemaVersion === 2 ? [...execution.acceptedSpec.outputs, output] : [output] } })
    await pool.query('insert into job_executions values($1,$2,$3::jsonb,$4::jsonb,$5)',
      [job.id, job.workspaceId, JSON.stringify(job), JSON.stringify(job.acceptedSpec), 'owner'])
    const parts = join(root, `logs-${job.id}`)
    await mkdir(parts)
    await writeFile(join(parts, 'repetitive.log'), 'same line\n'.repeat(100000))
    const original = data
    data = logArchive(parts, 65536)
    try {
      const published = await artifacts.publishAccepted({ workspaceId: job.workspaceId,
        executionId: job.id, attemptId: job.attemptId, owner: job.owner, commandId: randomUUID(),
        path: logPath, mediaType: 'application/gzip', sha256: digest(data), byteSize: data.length })
      const owner = await new PostgresAccessService(pool).authenticate(ownerToken)
      const read = await artifacts.read(pool, owner!, job.workspaceId, job.id,
        published.artifact.fileId, published.artifact.revisionId, 'mcp')
      expect(read.bytes).toEqual(data)
    } finally { data = original }
  })
  it('reads retained CI artifacts with workflow-scoped HTTP and MCP grants and denies other workflows', async () => {
    await pool.query('update job_fixture_owner set revoked=false')
    const workflowId = randomUUID()
    const runId = randomUUID()
    const job = JobExecutionRecordSchema.parse({ ...execution, id: randomUUID(), attemptId: randomUUID(),
      initiatingAgent: { workflowId, runId, agentId: randomUUID(), executionId: randomUUID() } })
    await pool.query('insert into runs values($1,$2,$3)', [runId, job.workspaceId, workflowId])
    await pool.query('insert into job_executions values($1,$2,$3::jsonb,$4::jsonb,$5)',
      [job.id, job.workspaceId, JSON.stringify(job), JSON.stringify(job.acceptedSpec), 'owner'])
    const allowedToken = randomUUID()
    const blockedToken = randomUUID()
    for (const [token, allowedWorkflow] of [[allowedToken, workflowId], [blockedToken, randomUUID()]] as const) {
      await pool.query("insert into management_principals values($1,$1,'operator',null,$2,$3::jsonb,'2099-01-01',null,null)",
        [randomUUID(), digest(token), JSON.stringify([{ actions: ['job_artifacts:read'],
          scope: { workspaceIds: [job.workspaceId], workflowIds: [allowedWorkflow] } }])])
    }
    const original = data
    if (placementMode === 'verification') {
      data = Buffer.from(JSON.stringify({ ...JSON.parse(data.toString()), executionId: job.id, attemptId: job.attemptId }))
    }
    try {
      const published = await artifacts.publishAccepted({ workspaceId: job.workspaceId, executionId: job.id,
        attemptId: job.attemptId, owner: job.owner, commandId: randomUUID(), path: outputPath,
        mediaType: 'application/json', sha256: digest(data), byteSize: data.length })
      const base = `/api/management/workspaces/${job.workspaceId}/jobs/executions/${job.id}/artifacts`
      const input = { workspaceId: job.workspaceId, executionId: job.id,
        fileId: published.artifact.fileId, revisionId: published.artifact.revisionId }
      const url = `${base}/${input.fileId}/revisions/${input.revisionId}/content`
      for (const [token, allowed] of [[allowedToken, true], [blockedToken, false]] as const) {
        const client = new Client({ name: 'scoped-artifact-reader', version: '1' })
        clients.push(client)
        await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
          requestInit: { headers: { authorization: `Bearer ${token}` } },
        }))
        const http = await app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } })
        const mcp = await client.callTool({ name: 'job_artifact_read', arguments: input })
        const list = await client.callTool({ name: 'job_artifacts_list',
          arguments: { workspaceId: job.workspaceId, executionId: job.id } })
        expect(http.statusCode).toBe(allowed ? 200 : 403)
        if (allowed) {
          expect(http.rawPayload).toEqual(data)
          expect(mcp.isError).not.toBe(true)
          expect(decodeMcpToolResult(mcp)).toMatchObject({ artifact: published.artifact, content: data.toString('base64') })
          expect(decodeMcpToolResult(list)).toEqual({ artifacts: [published.artifact] })
          const firstResult = await client.callTool({ name: 'job_artifact_read',
            arguments: { ...input, offset: 0, limit: 4 } })
          expect(firstResult.isError).not.toBe(true)
          const first = JobArtifactReadOutputSchema.parse(decodeMcpToolResult(firstResult))
          expect(first).toMatchObject({ artifact: published.artifact, offset: 0, nextOffset: 4 })
          const lastResult = await client.callTool({ name: 'job_artifact_read',
            arguments: { ...input, offset: first.nextOffset } })
          expect(lastResult.isError).not.toBe(true)
          const last = JobArtifactReadOutputSchema.parse(decodeMcpToolResult(lastResult))
          expect(last).toMatchObject({ artifact: published.artifact, offset: 4, nextOffset: null })
          expect(Buffer.concat([Buffer.from(first.content, 'base64'), Buffer.from(last.content, 'base64')])).toEqual(data)
        } else {
          expect(mcp.isError).toBe(true)
          expect(list.isError).toBe(true)
        }
      }
    } finally {
      data = original
    }
  })
  if (placementMode === 'verification') {
  it('retains unavailable runtime capabilities through authenticated MCP after report cleanup', async () => {
    await pool.query('update job_fixture_owner set revoked=false')
    const isolatedEnvironment = await integrationEnvironmentCapabilities({
      FOREMAN_CODE_VERIFICATION_ENVIRONMENT: 'isolated-job-v1',
    })
    const environment = {
      ...isolatedEnvironment,
      capabilities: {
        ...isolatedEnvironment.capabilities,
        nativeCgroupDelegation: false,
        testDatabaseStartup: false,
      },
    }
    const selected = [
      'apps/api/test/local-human-native.integration.test.ts',
      'apps/api/test/test-database-startup.integration.test.ts',
      'apps/api/test/computer-workflow-save.regression-directories.integration.test.ts',
      'apps/api/test/computer-workflow-save.regression-reservation-cleanup-preparing.integration.test.ts',
      'apps/api/test/computer-workflow-save.regression-reservation-cleanup-completed.integration.test.ts',
      'apps/api/test/remote-review-production-defaults.integration.test.ts',
      'apps/api/test/remote-review-production-delivery.integration.test.ts',
      'apps/api/test/remote-review-production-entry-recovery.integration.test.ts',
      'apps/api/test/remote-review-production-main-crash.integration.test.ts',
      'apps/api/test/remote-review-expired-receipt-recovery.integration.test.ts',
      'apps/api/test/remote-review-main-recovery.integration.test.ts',
      'apps/api/test/remote-review-production-reserved-decision.integration.test.ts',
      'apps/api/test/remote-review-production-worker-crash.integration.test.ts',
      'apps/api/test/worker-chat-profile-qualification.integration.test.ts',
      'apps/api/test/worker-profile-requalification-main-restart.integration.test.ts',
      'apps/api/test/worker-profile-requalification-worker-reconnect.integration.test.ts',
      'apps/api/test/worker-profile-requalification-failed-check.integration.test.ts',
    ]
    const { runnable, unavailable } = partitionIntegrationCapabilities(selected, environment)
    expect(runnable).toEqual([])
    const diagnostics = integrationReport(selected, unavailable, [], {
      startedAt: execution.createdAt,
      finishedAt: execution.finishedAt!,
      diagnostic: false,
      processStopped: true,
      environment,
    })
    const path = '.logs/verification/logs.tar.gz'
    const output = { path, required: true, mediaType: 'application/gzip' as const,
      kind: 'logs-archive' as const, maxBytes: 65536 }
    const job = VerificationJobExecutionSchema.parse({ ...execution, id: randomUUID(), attemptId: randomUUID(),
      acceptedSpec: { ...execution.acceptedSpec,
        policy: { ...execution.acceptedSpec.policy, maxOutputBytes: 128 * 1024 },
        outputs: [...execution.acceptedSpec.outputs, output] } })
    await pool.query('insert into job_executions values($1,$2,$3::jsonb,$4::jsonb,$5)',
      [job.id, job.workspaceId, JSON.stringify(job), JSON.stringify(job.acceptedSpec), 'owner'])
    const parts = join(root, `capability-reports-${job.id}`)
    await mkdir(parts)
    await writeFile(join(parts, 'summary.json'), JSON.stringify(diagnostics))
    const unit = partitionUnitCapabilities(['apps/api/test/native-guardian-outcome.test.ts'], environment)
    await writeFile(join(parts, 'unit.json'), JSON.stringify({ environment, ...unit }))
    const archive = logArchive(parts, output.maxBytes)
    const original = data
    data = archive
    let published
    try {
      published = await artifacts.publishAccepted({ workspaceId: job.workspaceId, executionId: job.id,
        attemptId: job.attemptId, owner: job.owner, commandId: randomUUID(), path,
        mediaType: output.mediaType, sha256: digest(archive), byteSize: archive.length })
    } finally {
      data = original
      await rm(parts, { recursive: true })
    }
    const input = { workspaceId: job.workspaceId, executionId: job.id,
      fileId: published.artifact.fileId, revisionId: published.artifact.revisionId }
    const denied = new Client({ name: 'denied capability report reader', version: '1' })
    clients.push(denied)
    await denied.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { authProvider: { token: async () => deniedToken } }))
    const listInput = { workspaceId: job.workspaceId, executionId: job.id }
    expect((await denied.callTool({ name: 'job_artifacts_list', arguments: listInput })).isError).toBe(true)
    expect((await denied.callTool({ name: 'job_artifact_read', arguments: input })).isError).toBe(true)
    const owner = new Client({ name: 'capability report reader', version: '1' })
    clients.push(owner)
    await owner.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { authProvider: { token: async () => ownerToken } }))
    const listed = await owner.callTool({ name: 'job_artifacts_list', arguments: listInput })
    expect(listed.isError, JSON.stringify(listed.content)).not.toBe(true)
    expect(decodeMcpToolResult(listed)).toMatchObject({ artifacts: [published.artifact] })
    const result = await owner.callTool({ name: 'job_artifact_read', arguments: input })
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
    const retained = JobArtifactReadOutputSchema.parse(decodeMcpToolResult(result))
    const bytes = Buffer.from(retained.content, 'base64')
    expect(bytes).toEqual(archive)
    const summary = JSON.parse(execFileSync('tar', ['-xzOf', '-', 'logs/0-summary.json'], {
      input: bytes, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    }))
    expect(summary).toEqual(diagnostics)
    expect(summary.files.map((entry: { file: string }) => entry.file)).toEqual(selected)
    const retainedUnit = JSON.parse(execFileSync('tar', ['-xzOf', '-', 'logs/1-unit.json'], {
      input: bytes, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    }))
    expect(retainedUnit).toEqual({ environment, ...unit })
    expect(retainedUnit.unavailable).toEqual([{
      file: 'apps/api/test/native-guardian-outcome.test.ts', code: null, complete: false,
      requiredCapabilities: ['nativeCgroupDelegation'],
      reason: 'Runtime lacks required capabilities: nativeCgroupDelegation',
    }])
    expect(summary).toMatchObject({ environment: { runtime: 'isolated-job',
      capabilities: { nativeCgroupDelegation: false, dockerCompose: false, installedWorkerHost: false } },
      outcome: 'incomplete', completeness: 'partial', expectedPortions: selected.length, completedPortions: 0,
      totals: { total: 0, passed: 0, failed: 0, skipped: 0 },
      files: [
        { complete: false, requiredCapabilities: ['nativeCgroupDelegation'] },
        { complete: false, requiredCapabilities: ['testDatabaseStartup'] },
        ...selected.slice(2).map(file => ({ file, complete: false, requiredCapabilities: ['installedWorkerHost'] })),
      ] })
  })
  it.each([7, 0])('reads reports after a failed qualification with command exit %i over MCP after cleanup', async exitCode => {
    const f = qualificationReportFixture()
    const candidate = f.candidate
    const profile = candidate.profile
    const workspaceId = profile.workspaceId
    const failure = exitCode === 0 ? new Error('Container inspection interrupted after the suite completed.') : undefined
    const report = { ...f.report, terminal: { ...f.report.terminal,
      outcome: exitCode === 0 ? 'succeeded' as const : 'build_failed' as const, exitCode } }
    const failed = exitCode === 0 ? 0 : 1
    const summary = JobVerificationReportSchema.parse({ schemaVersion: 1, ...report.context.identity,
      startedAt: report.startedAt, finishedAt: report.terminal.finishedAt,
      totals: { total: 1, passed: 1 - failed, failed, skipped: 0 }, firstPassFailed: failed,
      expectedPortions: 1, completedPortions: 1, disallowedSkipped: 0, completeness: 'complete',
      outcome: exitCode === 0 ? 'passed' : 'failed' })
    const workload = join(root, 'failed-qualification-workload')
    await mkdir(workload)
    await writeFile(join(workload, 'worker.log'), failure ? 'Unit checks passed before container inspection.\n'
      : 'approved_root_not_persistent: worker persistence test failed\n')
    const reports = new Map([
      ['summary.json', Buffer.from(JSON.stringify(summary))],
      ['junit.xml', Buffer.from(`<testsuites tests="1" failures="${failed}">`
        + `<testsuite name="worker" tests="1" failures="${failed}"><testcase name="persistent root">`
        + (failed ? '<failure>approved_root_not_persistent</failure>' : '')
        + '</testcase></testsuite></testsuites>')],
      ['vitest.json', Buffer.from(JSON.stringify({ success: failed === 0, numFailedTests: failed }))],
      ['logs.tar.gz', logArchive(workload, report.context.limits.logsArchiveBytes)],
    ])
    const approval = JobRuntimeApprovalRecordSchema.parse({ schemaVersion: 2, id: candidate.approvalId,
      qualificationId: candidate.qualificationId, workspaceId, profileId: profile.id, profileRevision: 1,
      fingerprint: candidate.fingerprint, fingerprintDigest: jobDigest(candidate.fingerprint),
      requestedByPrincipalId: 'owner', status: 'captured', expiresAt: report.context.identity.profile.approvalExpiresAt,
      requestedAt: new Date(Date.parse(report.context.identity.profile.approvalExpiresAt)
        - candidate.fingerprint.approvalConfig.approvalLifetimeMs).toISOString() })
    await pool.query('insert into workspaces values($1,null) on conflict do nothing', [workspaceId])
    await pool.query('insert into job_runtime_profiles values($1,$2,$3::jsonb)',
      [profile.id, workspaceId, JSON.stringify({ ...profile, status: 'captured' })])
    await pool.query('insert into job_runtime_qualification_approvals(id,workspace_id,record) values($1,$2,$3::jsonb)',
      [approval.id, workspaceId, JSON.stringify(approval)])
    await pool.query('update management_principals set grants=$2::jsonb where id=$1', ['owner', JSON.stringify([
      { actions: ['job_definitions:read', 'job_definitions:write', 'jobs:start', 'job_artifacts:read'],
        scope: { workspaceIds: [workspaceId, execution.workspaceId] } },
    ])])
    const publish = createQualificationReportPublisher({ pool, storageRoot: root })
    let qualificationRuns = 0
    jobRuntimeProfiles = new JobRuntimeProfiles(pool, new PostgresCommandCoordinator(pool), {} as PostgresSourceService, {
      capture: async () => { throw new Error('This fixture does not capture a runtime') },
      revalidate: async () => ({ ready: false, reasons: ['Unqualified fixture'] }),
      run: async () => {
        qualificationRuns++
        try {
          return await publishFailedQualification({ suite: 'unit', exitCode, stderr: '', ...(failure ? { failure } : {}),
            closeContainer: async () => true,
            publish: async () => {
              for (const [name, bytes] of reports) {
                await publish(candidate, { ...report, path: `.logs/verification/${name}` as typeof report.path,
                  sha256: digest(bytes), byteSize: bytes.length }, bytes, async () => {})
              }
              return summary
            } })
        } catch (error) {
          if (!(error instanceof Error)) throw error
          return { outcome: 'denied', closure: 'confirmed', reasons: [error.message] }
        } finally { await rm(workload, { recursive: true }) }
      },
    })
    const owner = new Client({ name: 'qualification diagnostic reader', version: '1' })
    clients.push(owner)
    await owner.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { authProvider: { token: async () => ownerToken } }))
    const run = { workspaceId, approvalId: approval.id, commandId: randomUUID() }
    const completed = await owner.callTool({ name: 'job_runtime_qualification_run', arguments: run })
    expect(completed.isError, JSON.stringify(completed.content)).not.toBe(true)
    expect(decodeMcpToolResult(completed)).toMatchObject({ profile: { status: 'failed', measurement: null } })
    await expect(readFile(join(workload, 'worker.log'))).rejects.toMatchObject({ code: 'ENOENT' })
    const status = await owner.callTool({ name: 'job_runtime_qualification_get',
      arguments: { workspaceId, approvalId: approval.id } })
    const retained = JobRuntimeQualificationReadRecordSchema.parse(decodeMcpToolResult(status))
    expect(retained.readiness).toMatchObject({ ready: false,
      reasons: [expect.stringContaining(`Reports: Job ${summary.executionId}.`)] })
    expect(retained.readiness.reasons[0]).toContain(`exit ${exitCode}`)
    if (failure) expect(retained.readiness.reasons[0]).toContain(failure.message)
    const executionId = /Reports: Job ([^.]+)\./.exec(retained.readiness.reasons[0]!)![1]!
    const list = await owner.callTool({ name: 'job_artifacts_list', arguments: { workspaceId, executionId } })
    expect(list.isError, JSON.stringify(list.content)).not.toBe(true)
    const saved = (decodeMcpToolResult(list) as { artifacts: Array<{ path: string; fileId: string; revisionId: string }> }).artifacts
    expect(saved).toHaveLength(4)
    for (const artifact of saved) {
      const result = await owner.callTool({ name: 'job_artifact_read', arguments: { workspaceId, executionId,
        fileId: artifact.fileId, revisionId: artifact.revisionId } })
      expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
      const read = JobArtifactReadOutputSchema.parse(decodeMcpToolResult(result))
      expect(Buffer.from(read.content, 'base64')).toEqual(reports.get(artifact.path.split('/').at(-1)!))
    }
    const replay = await owner.callTool({ name: 'job_runtime_qualification_run', arguments: run })
    expect(decodeMcpToolResult(replay)).toEqual(decodeMcpToolResult(completed))
    expect(qualificationRuns).toBe(1)
    const denied = new Client({ name: 'denied qualification reader', version: '1' })
    clients.push(denied)
    await denied.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
      { authProvider: { token: async () => deniedToken } }))
    for (const request of [
      { name: 'job_runtime_qualification_run', arguments: run },
      { name: 'job_runtime_qualification_get', arguments: { workspaceId, approvalId: approval.id } },
      { name: 'job_artifacts_list', arguments: { workspaceId, executionId } },
      { name: 'job_artifact_read', arguments: { workspaceId, executionId,
        fileId: saved[0]!.fileId, revisionId: saved[0]!.revisionId } },
    ]) expect((await denied.callTool(request)).isError).toBe(true)
  })
  it('publishes JUnit XML and reads the retained bytes through authenticated MCP', async () => {
    await pool.query('update job_fixture_owner set revoked=false')
    const path = '.logs/verification/junit.xml'
    const output = { path, required: true, mediaType: 'application/xml' as const, kind: 'junit' as const, maxBytes: 4096 }
    const job = VerificationJobExecutionSchema.parse({ ...execution, id: randomUUID(), attemptId: randomUUID(),
      acceptedSpec: { ...execution.acceptedSpec,
        policy: { ...execution.acceptedSpec.policy, maxOutputBytes: 8192 },
        outputs: [...execution.acceptedSpec.outputs, output] } })
    await pool.query('insert into job_executions values($1,$2,$3::jsonb,$4::jsonb,$5)',
      [job.id, job.workspaceId, JSON.stringify(job), JSON.stringify(job.acceptedSpec), 'owner'])
    const original = data
    data = Buffer.from('<?xml version="1.0"?><testsuites tests="1" failures="0"/>')
    try {
      const published = await artifacts.publishAccepted({ workspaceId: job.workspaceId, executionId: job.id,
        attemptId: job.attemptId, owner: job.owner, commandId: randomUUID(), path,
        mediaType: 'application/xml', sha256: digest(data), byteSize: data.length })
      const client = new Client({ name: 'XML artifact reader', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => ownerToken } }))
      const read = await client.callTool({ name: 'job_artifact_read', arguments: {
        workspaceId: job.workspaceId, executionId: job.id, fileId: published.artifact.fileId,
        revisionId: published.artifact.revisionId,
      } })
      expect(read.isError, JSON.stringify(read.content)).not.toBe(true)
      expect(Buffer.from((decodeMcpToolResult(read) as { content: string }).content, 'base64')).toEqual(data)
      const denied = new Client({ name: 'denied XML artifact reader', version: '1' })
      clients.push(denied)
      await denied.connect(new StreamableHTTPClientTransport(new URL('/mcp', address),
        { authProvider: { token: async () => deniedToken } }))
      expect((await denied.callTool({ name: 'job_artifact_read', arguments: {
        workspaceId: job.workspaceId, executionId: job.id, fileId: published.artifact.fileId,
        revisionId: published.artifact.revisionId,
      } })).isError).toBe(true)
    } finally { data = original }
  })
  it.each(['commit', 'attempt', 'failed', 'skipped', 'partial', 'oversized'] as const)(
    'rejects persisted verification %s reports despite exit zero', async change => {
      await pool.query('update job_fixture_owner set revoked=false')
      const job = VerificationJobExecutionSchema.parse({ ...execution, id: randomUUID(), attemptId: randomUUID() })
      await pool.query('insert into job_executions values($1,$2,$3::jsonb,$4::jsonb,$5)',
        [job.id, job.workspaceId, JSON.stringify(job), JSON.stringify(job.acceptedSpec), 'owner'])
      const report = { ...JSON.parse(data.toString()), executionId: job.id, attemptId: job.attemptId }
      if (change === 'commit') report.commit = 'c'.repeat(40)
      if (change === 'attempt') report.attemptId = 'another-attempt'
      if (change === 'failed') {
        report.totals = { total: 1, passed: 0, failed: 1, skipped: 0 }
        report.outcome = 'failed'
      }
      if (change === 'skipped') {
        report.totals = { total: 1, passed: 0, failed: 0, skipped: 1 }
        report.disallowedSkipped = 1
        report.outcome = 'incomplete'
      }
      if (change === 'partial') {
        report.completeness = 'partial'
        report.completedPortions = 0
        report.outcome = 'incomplete'
      }
      const bytes = Buffer.from(JSON.stringify(report))
      const originalBytes = data
      data = bytes
      const request = { workspaceId: job.workspaceId, executionId: job.id, attemptId: job.attemptId,
        owner: job.owner, commandId: randomUUID(), path: outputPath, mediaType: 'application/json' as const,
        sha256: digest(bytes), byteSize: bytes.length }
      try {
        if (change === 'oversized') {
          job.acceptedSpec.outputs[0]!.maxBytes = bytes.length - 1
          await pool.query('update job_executions set record=$2::jsonb,accepted_spec=$3::jsonb where id=$1',
            [job.id, JSON.stringify(job), JSON.stringify(job.acceptedSpec)])
          await expect(artifacts.reserveAccepted(request, 'mcp')).rejects.toMatchObject({ code: 'JOB_OUTPUT_SPEC_MISMATCH' })
          expect((await pool.query('select count(*)::int as count from files where job_execution_id=$1', [job.id]))
            .rows[0].count).toBe(0)
        } else {
          const result = await artifacts.publishAccepted(request, 'mcp')
          await expect(artifacts.verifyRequiredOutputs(pool, job))
            .rejects.toMatchObject({ code: 'JOB_REQUIRED_OUTPUT_CORRUPT' })
          const owner = await new PostgresAccessService(pool).authenticate(ownerToken)
          const read = await artifacts.read(pool, owner!, job.workspaceId, job.id,
            result.artifact.fileId, result.artifact.revisionId, 'mcp')
          expect(read.bytes).toEqual(bytes)
        }
      } finally { data = originalBytes }
    })

  }
})
