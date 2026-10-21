import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { JobAdmissionResultSchema, JobPendingAdmissionSchema, JobQueueTicketSchema } from '@foreman-code/contracts/job-admission'
import { JobExecutionSchema } from '@foreman-code/contracts/jobs'
import { JobAuthoringChoicesRecordSchema, JobDefinitionRecordSchema, AutoVerificationJobSpecSchema,
  jobPolicyRequirementsRecord } from '@foreman-code/contracts/job-verification'
import { JOB_VERIFICATION_APPROVAL_LIFETIME_MS } from '@foreman-code/contracts/job-verification-policy'
import { JobVerificationProfileSchema, jobRuntimeProfilePolicy } from '@foreman-code/contracts/job-verification-runtime'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { JobService } from '../src/modules/jobs/service.js'
import { JobWorkerService } from '../src/modules/jobs/worker.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { buildQueueFixture } from './helpers/buildComputerFixture.js'
import { DomainError } from '../src/modules/errors.js'
import { buildComputerTarget } from '../src/modules/settings/buildComputers.js'
import { verificationJobsMcpFixture } from './helpers/verificationJobsMcpFixture.js'

/** Real PostgreSQL, authenticated HTTP/MCP, receipts and live revocation. No physical launch claim. */
describe.skipIf(!postgresEnabled)('authenticated job persistence and denied MCP parity',()=>{
  let database:Awaited<ReturnType<typeof agent3Database>>,app:ReturnType<typeof buildApp>,address:string
  let access:PostgresAccessService,jobs:JobService,worker:JobWorkerService
  let writer:Awaited<ReturnType<PostgresAccessService['issue']>>,reader:Awaited<ReturnType<PostgresAccessService['issue']>>
  let services: OperatorServices
  let workspaceId: string
  let queue: Awaited<ReturnType<typeof buildQueueFixture>>
  const clients:Client[]=[]
  beforeAll(async()=>{
    database=await agent3Database()
    access=new PostgresAccessService(database.pool)
    workspaceId = randomUUID()
    await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
      [workspaceId, JSON.stringify({ id: workspaceId, name: 'Scoped queue persistence' })])
    writer=await access.issue({name:'Job writer fixture',audience:'operator',expiresAt:new Date(Date.now()+3600000),grants:[
      {actions:['job_definitions:read','job_definitions:write','jobs:start','jobs:read','jobs:cancel','job_logs:read','job_artifacts:read','capabilities:read'],scope:{workspaceIds:[workspaceId]}},
      {actions:['settings:read','settings:update'],scope:{}},
    ]})
    queue = await buildQueueFixture(database.pool, writer.principal, { workspaceId })
    queue.online()
    jobs = queue.jobs
    const commands = queue.commands
    reader=await access.issue({name:'Job reader fixture',audience:'operator',expiresAt:new Date(Date.now()+3600000),grants:[{actions:['job_definitions:read','jobs:read','job_logs:read','job_artifacts:read','capabilities:read'],scope:{workspaceIds:[workspaceId]}}]})
    worker=new JobWorkerService(database.pool,{require:async()=>{},verifyPublication:async()=>{}})
    services = { jobs, commands, workflows: new WorkflowManagementService(database.pool, commands),
    } as unknown as OperatorServices
    app=buildApp({readiness:{database:{ping:async()=>{}},checkpoints:{ping:async()=>{}}},operator:{access,services}})
    address=await app.listen({host:'127.0.0.1',port:0})
  },60000)
  afterAll(async()=>{await Promise.allSettled(clients.map(client=>client.close()));await app?.close();await jobs?.closeQueue();await database?.close()})
  const root=()=>`/api/management/workspaces/${workspaceId}/jobs`
  async function connect(token:string) {const client=new Client({name:'job-tests',version:'1'});clients.push(client);await client.connect(new StreamableHTTPClientTransport(new URL('/mcp',address),{requestInit:{headers:{Authorization:`Bearer ${token}`}}}));return client}
  it('persists accepted version after edits/restart, replays one command, conflicts changed payload, and matches MCP readback',async()=>{
    const saved=await app.inject({method:'POST',url:`${root()}/definitions`,headers:{authorization:`Bearer ${writer.token}`},payload:{commandId:randomUUID(),expectedRevision:null,name:'Version one',spec:queue.computers[0]!.candidate.spec}})
    expect(saved.statusCode).toBe(200);const definition=saved.json().definition
    const command={commandId:randomUUID(),definitionId:definition.id,expectedRevision:1}
    const started=await app.inject({method:'POST',url:`${root()}/executions`,headers:{authorization:`Bearer ${writer.token}`},payload:command})
    expect(started.statusCode).toBe(200)
    const admission = started.json().admission
    expect(['pending-admission', 'accepted']).toContain(admission.kind)
    await jobs.wakeQueue()
    const ticketId = admission.kind === 'accepted' ? admission.ticketId : admission.ticket.id
    const ticket = await jobs.getQueueTicket(reader.principal, workspaceId, ticketId)
    const execution = await jobs.getExecution(reader.principal, workspaceId, ticket.executionId)
    const client=await connect(writer.token)
    const replay=await client.callTool({name:'job_start',arguments:{workspaceId,...command}})
    expect(replay.isError).not.toBe(true);expect(decodeMcpToolResult(replay)).toEqual({admission:{kind:'accepted',ticketId,executionId:execution.id}})
    const edited=await app.inject({method:'POST',url:`${root()}/definitions`,headers:{authorization:`Bearer ${writer.token}`},payload:{commandId:randomUUID(),id:definition.id,expectedRevision:1,name:'Version two',spec:{...queue.computers[0]!.candidate.spec,argv:['node','different.mjs']}}})
    expect(edited.statusCode).toBe(200)
    const historic=await client.callTool({name:'job_definition_version_get',arguments:{workspaceId,definitionId:definition.id,versionId:definition.versionId}})
    expect(decodeMcpToolResult(historic)).toEqual({definition})
    const historicHttp=await app.inject({method:'GET',url:`${root()}/definitions/${definition.id}/versions/${definition.versionId}`,headers:{authorization:`Bearer ${reader.token}`}})
    expect(historicHttp.statusCode).toBe(200);expect(historicHttp.json()).toEqual({definition})
    const foreignVersion=await client.callTool({name:'job_definition_version_get',arguments:{workspaceId:'foreign',definitionId:definition.id,versionId:definition.versionId}})
    expect(foreignVersion.isError).toBe(true);expect(JSON.stringify(foreignVersion.content)).toContain('ACCESS_DENIED')
    const conflict=await client.callTool({name:'job_start',arguments:{workspaceId,...command,expectedRevision:2}})
    expect(conflict.isError).toBe(true);expect(JSON.stringify(conflict.content)).toContain('COMMAND_ID_CONFLICT')
    const read=await client.callTool({name:'job_get',arguments:{workspaceId,executionId:execution.id}})
    expect(decodeMcpToolResult(read)).toEqual({execution})
    const fresh=await jobs.repository.execution(database.pool,workspaceId,execution.id)
    expect(fresh.acceptedSpec.definitionRevision).toBe(1);expect(fresh.acceptedSpec.argv).toEqual(queue.computers[0]!.candidate.spec.argv)
    expect(Number((await database.pool.query('select count(*) from job_executions where workspace_id=$1',[workspaceId])).rows[0].count)).toBe(1)
    const fenced={attemptId:execution.attemptId,owner:execution.owner}
    const chunk={executionId:execution.id,attemptId:execution.attemptId,sequence:1,stream:'stdout' as const,text:'🙂',byteSize:4,createdAt:new Date().toISOString()}
    expect(await worker.appendLog(workspaceId,execution.id,fenced,chunk)).toEqual({persistedSequence:1,truncated:false})
    expect(await worker.appendLog(workspaceId,execution.id,fenced,chunk)).toEqual({persistedSequence:1,truncated:false})
    await expect(worker.appendLog(workspaceId,execution.id,fenced,{...chunk,sequence:3})).rejects.toMatchObject({code:'JOB_LOG_GAP'})
    await worker.settleProcess(workspaceId,execution.id,fenced,{process:{phase:'terminal',outcome:'build_failed',exitCode:7,signal:null,processStopped:true},startedAt:new Date().toISOString(),finishedAt:new Date().toISOString()})
    const result=await jobs.getExecution(reader.principal,workspaceId,execution.id)
    expect(result.process.exitCode).toBe(7);expect(result.process.outcome).toBe('build_failed');expect(result.transport).toBe('connected')
    await queue.complete(execution.id)
  })
  it.each([
    { phase: 'terminal', transport: 'offline' },
    { phase: 'terminal', transport: 'unknown' },
    { phase: 'running', transport: 'offline' },
    { phase: 'running', transport: 'unknown' },
  ] as const)('preserves $phase process facts with $transport transport through authenticated HTTP/MCP reads', async ({ phase, transport }) => {
    const definition = await queue.save(queue.computers[0]!.candidate.spec)
    const admission = await jobs.enqueue(writer.principal, 'http', workspaceId, {
      commandId: randomUUID(), definitionId: definition.id, expectedRevision: definition.revision,
    })
    if (admission.kind === 'retained-execution') throw new Error('Expected a new queued Job')
    await jobs.wakeQueue()
    const ticketId = admission.kind === 'accepted' ? admission.ticketId : admission.ticket.id
    const ticket = await jobs.getQueueTicket(writer.principal, workspaceId, ticketId)
    const execution = await jobs.getExecution(writer.principal, workspaceId, ticket.executionId)
    try {
      const finishedAt = phase === 'terminal' ? new Date().toISOString() : null
      const observed = await worker.settleProcess(workspaceId, execution.id, {
        attemptId: execution.attemptId, owner: execution.owner,
      }, {
        process: { phase, outcome: phase === 'terminal' ? 'succeeded' : null,
          exitCode: phase === 'terminal' ? 0 : null, signal: null, processStopped: phase === 'terminal' },
        startedAt: execution.createdAt, finishedAt,
      })
      const persisted = { ...observed, transport }
      await jobs.repository.putExecution(database.pool, persisted)
      const url = `${root()}/executions/${execution.id}`
      const input = { workspaceId, executionId: execution.id }
      const client = await connect(reader.token)
      for (let read = 0; read < 2; read++) {
        const http = await app.inject({ method: 'GET', url,
          headers: { authorization: `Bearer ${reader.token}` } })
        expect(http.statusCode).toBe(200)
        expect(http.json()).toEqual({ execution: persisted })
        const mcp = await client.callTool({ name: 'job_get', arguments: input })
        expect(mcp.isError).not.toBe(true)
        expect(decodeMcpToolResult(mcp)).toEqual({ execution: persisted })
      }
      const denied = await access.issue({ name: 'Job reader outside this workspace', audience: 'operator',
        expiresAt: new Date(Date.now() + 3600000), grants: [
          { actions: ['jobs:read'], scope: { workspaceIds: ['foreign-workspace'] } },
        ] })
      const deniedHttp = await app.inject({ method: 'GET', url,
        headers: { authorization: `Bearer ${denied.token}` } })
      expect(deniedHttp.statusCode).toBe(403)
      const deniedMcp = await (await connect(denied.token)).callTool({ name: 'job_get', arguments: input })
      expect(deniedMcp.isError).toBe(true)
      expect(JSON.stringify(deniedMcp.content)).toContain('ACCESS_DENIED')
      const restarted = queue.createService()
      try {
        expect(await restarted.getExecution(reader.principal, workspaceId, execution.id)).toEqual(persisted)
      } finally {
        await restarted.closeQueue()
      }
    } finally {
      await queue.complete(execution.id)
    }
  })
  it('retains a timed-out source attempt through queued HTTP/MCP retries and resumes only its original identity',async()=>{
    const saved=await app.inject({method:'POST',url:`${root()}/definitions`,headers:{authorization:`Bearer ${writer.token}`},payload:{commandId:randomUUID(),expectedRevision:null,name:'Retained preparation',spec:queue.computers[0]!.candidate.spec}})
    expect(saved.statusCode).toBe(200)
    const command={commandId:randomUUID(),definitionId:saved.json().definition.id,expectedRevision:1}
    const error=new DomainError('SOURCE_REPOSITORY_TIMEOUT','Private source preparation timed out.',503,{retryable:true})
    const originalAccept = queue.accept.getMockImplementation()!
    queue.accept.mockRejectedValue(error)
    const client=await connect(writer.token)
    try {
      const http=await app.inject({method:'POST',url:`${root()}/executions`,headers:{authorization:`Bearer ${writer.token}`},payload:command})
      expect(http.statusCode).toBe(200)
      expect(http.json().admission.kind).toBe('pending-admission')
      await expect(jobs.wakeQueue()).rejects.toMatchObject({code:error.code,details:{retryable:true}})
      const ticketId = http.json().admission.ticket.id
      const retained=(await database.pool.query('select execution_id,attempt_id,operation_id from job_preparations where principal_id=$1 and command_id=$2',[writer.principal.id,command.commandId])).rows
      expect(retained).toHaveLength(1)
      const mcp=await client.callTool({name:'job_start',arguments:{workspaceId,...command}})
      expect(mcp.isError).not.toBe(true)
      const pending = z.object({ admission: JobPendingAdmissionSchema }).parse(decodeMcpToolResult(mcp))
      expect(pending.admission).toMatchObject({kind:'pending-admission',ticket:{id:ticketId,state:'claimed'}})
      await expect(jobs.wakeQueue()).rejects.toMatchObject({code:error.code})
      expect((await database.pool.query('select execution_id,attempt_id,operation_id from job_preparations where principal_id=$1 and command_id=$2',[writer.principal.id,command.commandId])).rows).toEqual(retained)
      expect((await database.pool.query('select id from job_executions where id=$1',[retained[0].execution_id])).rows).toHaveLength(0)
      const calls = queue.accept.mock.calls.length
      const denied=await (await connect(reader.token)).callTool({name:'job_start',arguments:{workspaceId,...command}})
      expect(denied.isError).toBe(true)
      expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
      expect(queue.accept).toHaveBeenCalledTimes(calls)
      queue.accept.mockImplementation(originalAccept)
      await jobs.wakeQueue()
      const resumed=await client.callTool({name:'job_start',arguments:{workspaceId,...command}})
      expect(resumed.isError).not.toBe(true)
      const accepted = z.object({ admission: JobAdmissionResultSchema }).parse(decodeMcpToolResult(resumed))
      expect(accepted.admission).toEqual({kind:'accepted',ticketId,executionId:retained[0].execution_id})
      const read=await client.callTool({name:'job_get',arguments:{workspaceId,executionId:retained[0].execution_id}})
      expect(read.isError).not.toBe(true)
      const { execution } = z.object({ execution: JobExecutionSchema }).parse(decodeMcpToolResult(read))
      expect(execution).toMatchObject({id:retained[0].execution_id,attemptId:retained[0].attempt_id,operationId:retained[0].operation_id})
      expect((await database.pool.query('select result from management_command_receipts where principal_id=$1 and command_id=$2',[writer.principal.id,command.commandId])).rows).toHaveLength(1)
    } finally {queue.accept.mockImplementation(originalAccept)}
  })
  it('denies read-only MCP writes, wrong workspace and revoked live authority without probing source',async()=>{
    const client=await connect(reader.token)
    const denied=await client.callTool({name:'job_start',arguments:{workspaceId,commandId:randomUUID(),definitionId:'unprobed',expectedRevision:1}})
    expect(denied.isError).toBe(true);expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    const foreign=await app.inject({method:'GET',url:'/api/management/workspaces/foreign/jobs/definitions',headers:{authorization:`Bearer ${writer.token}`}})
    expect(foreign.statusCode).toBe(403)
    await database.pool.query('update management_principals set revoked_at=clock_timestamp() where id=$1',[reader.principal.id])
    await expect(jobs.listDefinitions(reader.principal,workspaceId)).rejects.toMatchObject({code:'AUTH_REVOKED'})
  })
})

describe.skipIf(!postgresEnabled)('verification Job authenticated MCP authoring', () => {
  it('reads mixed templates, saves and queues the ordinary suite, preserves restart readback and denies readers', async () => {
    const f = await verificationJobsMcpFixture()
    const workspaceId = f.retained.workspaceId
    let jobs = f.createJobs()
    const services = { commands: f.retained.commands, jobs, jobRuntimeProfiles: f.profiles } as OperatorServices
    const createApp = () => buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access: f.access, services } })
    let app = createApp()
    let address = ''
    const clients: Client[] = []
    const connect = async (token: string) => {
      const client = new Client({ name: 'Verification authoring parity', version: '1' })
      clients.push(client)
      await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { Authorization: `Bearer ${token}` } },
      }))
      return client
    }
    try {
      address = await app.listen({ host: '127.0.0.1', port: 0 })
      const writer = await connect(f.writer.token)
      const readonly = await connect(f.reader.token)
      const profileResult = await writer.callTool({ name: 'job_runtime_profile_save', arguments: {
        workspaceId, commandId: randomUUID(), expectedRevision: null, name: 'Offline unit profile', spec: {
          rootId: f.retained.root.binding.rootId, bindingRevision: f.retained.root.binding.bindingRevision,
          resources: f.seed.spec.verification.resources, policy: jobPolicyRequirementsRecord(f.seed.spec.policy),
          suites: ['unit'], approvalConfig: { approvalLifetimeMs: JOB_VERIFICATION_APPROVAL_LIFETIME_MS },
        },
      } })
      expect(profileResult.isError, JSON.stringify(profileResult.content)).not.toBe(true)
      const profile = z.object({ profile: JobVerificationProfileSchema }).parse(decodeMcpToolResult(profileResult)).profile
      const getChoices = async () => {
        const result = await writer.callTool({ name: 'job_choices_get', arguments: { workspaceId } })
        expect(result.isError, JSON.stringify(result.content)).not.toBe(true)
        return JobAuthoringChoicesRecordSchema.parse(decodeMcpToolResult(result))
      }
      const choices = await getChoices()
      expect(choices.policies).toContainEqual(f.retained.spec.policy)
      expect(choices.autoPolicies?.some(item => 'schemaVersion' in item.policy && item.policy.schemaVersion === 2)).toBe(true)
      const template = choices.verificationTemplates!.find(item => item.profileId === profile.id)!
      expect(template).toMatchObject({ suite: 'unit', ready: false,
        resources: profile.spec.resources, maxUnitWorkers: 1 })
      const spec = AutoVerificationJobSpecSchema.parse({ target: { kind: 'auto' }, source: choices.sources[0],
        policy: template.policy, limits: template.resources.limits, argv: template.argv, inputs: [], outputs: template.outputs,
        verification: { suite: template.suite, resources: template.resources,
          parameters: template.parameters, credentialRefs: [] } })
      const validation = await writer.callTool({ name: 'job_validate', arguments: { workspaceId, spec } })
      expect(decodeMcpToolResult(validation)).toEqual({ valid: true, reasons: [], sideEffects: false })
      const saveInput = { workspaceId, commandId: randomUUID(), expectedRevision: null,
        name: 'Repository unit', spec }
      const saved = await writer.callTool({ name: 'job_definition_save', arguments: saveInput })
      expect(saved.isError, JSON.stringify(saved.content)).not.toBe(true)
      const definition = z.object({ definition: JobDefinitionRecordSchema }).parse(decodeMcpToolResult(saved)).definition
      expect(definition).toMatchObject({ schemaVersion: 2, spec })
      const historic = await writer.callTool({ name: 'job_definition_version_get', arguments: {
        workspaceId, definitionId: definition.id, versionId: definition.versionId,
      } })
      expect(decodeMcpToolResult(historic)).toEqual({ definition })
      const deniedSave = await readonly.callTool({ name: 'job_definition_save', arguments: {
        ...saveInput, commandId: randomUUID(),
      } })
      expect(deniedSave.isError).toBe(true)

      const editableResult = await writer.callTool({ name: 'job_definition_save', arguments: {
        ...saveInput, commandId: randomUUID(), name: 'Editable repository unit',
      } })
      expect(editableResult.isError, JSON.stringify(editableResult.content)).not.toBe(true)
      const editable = z.object({ definition: JobDefinitionRecordSchema })
        .parse(decodeMcpToolResult(editableResult)).definition
      const editedLimits = { ...spec.limits, cpuLimit: spec.limits.cpuLimit + 1,
        memoryBytes: spec.limits.memoryBytes * 2 }
      const editedSpec = AutoVerificationJobSpecSchema.parse({ ...spec, limits: editedLimits,
        policy: { ...spec.policy, executionTimeoutMs: spec.policy.executionTimeoutMs + 1000 },
        verification: { ...spec.verification,
          resources: { ...spec.verification.resources, limits: editedLimits } } })
      const editedValidation = await writer.callTool({ name: 'job_validate', arguments: {
        workspaceId, spec: editedSpec,
      } })
      expect(decodeMcpToolResult(editedValidation)).toEqual({ valid: true, reasons: [], sideEffects: false })
      const editInput = { workspaceId, commandId: randomUUID(), id: editable.id,
        expectedRevision: editable.revision, name: editable.name, spec: editedSpec }
      const deniedEdit = await readonly.callTool({ name: 'job_definition_save', arguments: editInput })
      expect(deniedEdit.isError).toBe(true)
      const editedResult = await writer.callTool({ name: 'job_definition_save', arguments: editInput })
      expect(editedResult.isError, JSON.stringify(editedResult.content)).not.toBe(true)
      const edited = z.object({ definition: JobDefinitionRecordSchema }).parse(decodeMcpToolResult(editedResult)).definition
      expect(edited).toMatchObject({ id: editable.id, revision: 2, spec: editedSpec })
      const editRetry = await writer.callTool({ name: 'job_definition_save', arguments: editInput })
      expect(decodeMcpToolResult(editRetry)).toEqual({ definition: edited })
      const editedReadback = await readonly.callTool({ name: 'job_definition_get', arguments: {
        workspaceId, definitionId: editable.id,
      } })
      expect(decodeMcpToolResult(editedReadback)).toEqual({ definition: edited })
      const originalReadback = await readonly.callTool({ name: 'job_definition_version_get', arguments: {
        workspaceId, definitionId: editable.id, versionId: editable.versionId,
      } })
      expect(decodeMcpToolResult(originalReadback)).toEqual({ definition: editable })
      const command = { workspaceId, commandId: randomUUID(), definitionId: definition.id,
        expectedRevision: definition.revision }
      const deniedStart = await readonly.callTool({ name: 'job_start', arguments: command })
      expect(deniedStart.isError).toBe(true)
      expect(await jobs.listQueue(f.writer.principal, workspaceId)).toHaveLength(0)

      // Qualification metadata is the fixture boundary; no physical suite pass is asserted here.
      const qualified = await f.qualify(profile)
      expect((await f.database.pool.query(
        'select record from job_runtime_profile_versions where profile_id=$1 and revision=$2',
        [profile.id, profile.revision])).rows).toEqual([{ record: profile }])
      const qualifiedTemplate = (await getChoices()).verificationTemplates!.find(item => item.profileId === profile.id)!
      expect(qualifiedTemplate).toMatchObject({ ready: true, maxUnitWorkers: 12 })
      expect(qualified.measurement!.suites[0]!.maxUnitWorkers).toBe(16)
      await f.runtime.buildComputers.update(f.writer.principal, 'http', { commandId: randomUUID(), expectedRevision: 0,
        target: buildComputerTarget(choices.targets[0]!.target), buildEnabled: true, buildPriority: 100 })
      const fixedSpec = { source: spec.source, argv: spec.argv, inputs: spec.inputs, outputs: spec.outputs,
        target: choices.targets[0]!.target, policy: jobRuntimeProfilePolicy(qualified),
        verification: { ...spec.verification, parameters: { ...spec.verification.parameters, unitWorkers: 16 } } }
      const tooManyWorkers = await writer.callTool({ name: 'job_validate', arguments: { workspaceId, spec: fixedSpec } })
      expect(decodeMcpToolResult(tooManyWorkers)).toEqual({ valid: false, reasons: ['JOB_SUITE_UNQUALIFIED'], sideEffects: false })

      const started = await writer.callTool({ name: 'job_start', arguments: command })
      expect(started.isError, JSON.stringify(started.content)).not.toBe(true)
      const pending = z.object({ admission: JobPendingAdmissionSchema }).parse(decodeMcpToolResult(started)).admission
      await jobs.wakeQueue()
      const queued = await writer.callTool({ name: 'job_queue_get', arguments: { workspaceId, ticketId: pending.ticket.id } })
      const ticket = z.object({ ticket: JobQueueTicketSchema }).parse(decodeMcpToolResult(queued)).ticket
      expect(ticket).toMatchObject({ state: 'waiting', waitingReasons: ['busy'], definition,
        resources: template.resources, reservationId: null })
      for (const client of clients.splice(0)) await client.close()
      await app.close()
      await jobs.closeQueue()
      jobs = f.createJobs()
      services.jobs = jobs
      app = createApp()
      address = await app.listen({ host: '127.0.0.1', port: 0 })
      const restarted = await connect(f.writer.token)
      const restartedDefinition = await restarted.callTool({ name: 'job_definition_get', arguments: {
        workspaceId, definitionId: edited.id,
      } })
      expect(decodeMcpToolResult(restartedDefinition)).toEqual({ definition: edited })
      const read = await restarted.callTool({ name: 'job_queue_get', arguments: { workspaceId, ticketId: ticket.id } })
      expect(decodeMcpToolResult(read)).toEqual({ ticket })
      const replay = await restarted.callTool({ name: 'job_start', arguments: command })
      expect(decodeMcpToolResult(replay)).toEqual({ admission: { kind: 'pending-admission', ticket } })
      const cancelled = await restarted.callTool({ name: 'job_queue_cancel', arguments: { workspaceId,
        commandId: randomUUID(), ticketId: ticket.id, expectedRevision: ticket.revision } })
      const cancelledTicket = z.object({ ticket: JobQueueTicketSchema }).parse(decodeMcpToolResult(cancelled)).ticket
      expect(cancelledTicket).toMatchObject({ state: 'terminal', terminalReason: 'cancelled', definition,
        resources: template.resources })
      expect(await jobs.getQueueTicket(f.writer.principal, workspaceId, ticket.id)).toEqual(cancelledTicket)
      expect(await jobs.getDefinition(f.writer.principal, workspaceId, definition.id)).toEqual(definition)
    } finally {
      for (const client of clients) await client.close()
      await app.close()
      await jobs.closeQueue()
      await f.runtime.close()
      await f.database.close()
    }
  }, 60_000)
})
