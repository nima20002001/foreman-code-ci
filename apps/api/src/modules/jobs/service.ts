import { JobInitiatingAgentSchema, type JobInitiatingAgent } from '@foreman-code/contracts/jobs'
import { withTransaction } from '../../infrastructure/transaction.js'
import { jobDigest } from './digest.js'
import { componentLogger } from '../diagnostics/logger.js'
import { requireJobPreparationDeadline } from './preparationDeadline.js'
import { JobWorkflowExecutionReferenceSchema } from '@foreman-code/contracts/job-workflow'
import { AcceptedWorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { jobSpecDigests } from '@foreman-code/contracts/jobs-node'
import type { RunInput } from '@foreman-code/contracts'
import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { z } from 'zod'
import { JobArtifactSchema, JobLogPageSchema, JobStartSchema, type JobStart } from '@foreman-code/contracts/jobs'
import {
  JobAcceptedSpecRecordSchema,
  JobDefinitionSaveRecordSchema,
  JobDefinitionRecordSchema,
  JobDefinitionSpecRecordSchema,
  JobExecutionRecordSchema,
  WorkflowJobListInputSchema,
  isAutoJobSpecRecord,
  type ResolvedJobDefinitionSpecRecord,
  type JobDefinitionRecord,
  type JobDefinitionSaveRecord,
  type JobDefinitionSpecRecord,
  type JobExecutionRecord,
  type PreparedJobSpecRecord,
} from '@foreman-code/contracts/job-verification'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization, type AuthorizedResource } from '../access/policy.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { jobCanWait, releaseUnstartedJobComputer, type JobComputerSelection,
  type JobPreparationIdentity } from './computerSelection.js'
import { jobPlacementRequest } from './placementRequest.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { JobRepository, type JobSql } from './repository.js'
import type { JobArtifactPort, JobDispatchPort, JobPreparationPort } from './ports.js'
import type { JobQueueConfiguration } from './ports.js'
import type { CiRuntimeProvisioner } from './ciRuntimeProvisioner.js'
import { JobQueuePreparation } from './preparation.js'
import { JobQueueTicketSchema, JobQueuedStartSchema, JobQueueCancelSchema, JobQueueLimitsSchema,
  JobAdmissionResultSchema, JobQueueListInputSchema, JobQueuePageSchema,
  JobLaunchValidationInputSchema, JobLaunchValidationSchema,
  jobQueueHasExecution, type JobQueueTicket } from '@foreman-code/contracts/job-admission'
import { JobResourceRequestSchema } from '@foreman-code/contracts/job-verification-policy'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { acceptVerificationSpec } from './verificationAcceptance.js'
import type { PostgresJobCancellationRecovery } from './cancellationRecovery.js'
import type { JobCancellationRecoveryApply } from '@foreman-code/contracts/job-cancellation-recovery'

export { jobDigest } from './digest.js'
function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input)
  if (!result.success) throw new DomainError('INVALID_REQUEST','The request does not match the job contract.',400)
  return result.data
}
export class JobService {
  runtimePreparation?: Pick<CiRuntimeProvisioner, 'prepareForTicket' | 'recover' | 'close'>
  readonly repository = new JobRepository()
  private readonly workerExecution: WorkerExecutionPolicy
  private readonly queuePreparation: JobQueuePreparation | undefined
  private queueTimer: ReturnType<typeof setInterval> | undefined
  private queueWake: Promise<Promise<void>[]> | undefined
  private queueRescanRequested = false
  private queueClosing = false
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly ports: {
      placement?: JobComputerSelection
      preparation: JobPreparationPort
      dispatch: JobDispatchPort
      artifacts: JobArtifactPort
      workerExecution?: WorkerExecutionPolicy
      cancellationRecovery?: PostgresJobCancellationRecovery
      queue?: JobQueueConfiguration
      refreshRuntimeMetadata?(): void
      closePreparation?(ticket: JobQueueTicket): Promise<void>
    },
    private readonly clock: () => Date = () => new Date()) {
    this.workerExecution = ports.workerExecution ?? new WorkerExecutionPolicy()
    if (ports.queue && ports.placement) {
      this.queuePreparation = new JobQueuePreparation(pool, {
        configuration: ports.queue,
        placement: ports.placement,
        prepare: (principal, definition, ticket) => this.prepareDefinition(pool, principal, definition, ticket),
        admit: async (sql, principal, definition, prepared, ticket) => {
          const ready = await ports.preparation.validate(sql, principal, definition.workspaceId,
            await this.resolvedDefinition(sql, definition, ticket), { queued: true })
          if (!ready.valid) throw new DomainError('JOB_NOT_READY', 'Job authority changed during preparation.',
            409, { reasons: ready.reasons })
          return this.admitPrepared(sql, principal, definition, null, null, prepared, ticket)
        },
        wake: execution => this.wakeAccepted(execution),
        prepareRuntime: ticket => this.runtimePreparation?.prepareForTicket(ticket) ?? Promise.resolve(),
        ...(ports.closePreparation ? { closePreparation: ports.closePreparation } : {}),
      }, clock)
    }
  }
  private async wakeAccepted(execution:JobExecutionRecord):Promise<void> {
    try {await this.ports.dispatch.wake(execution.id)} catch(error) {
      if(error instanceof DomainError)throw error
      componentLogger('jobs').error({ err: error, executionId: execution.id }, 'Job dispatch or reconciliation failed')
      throw new DomainError('JOB_DISPATCH_PENDING','The accepted Job could not be delivered or reconciled. Read its persisted state and retry the original command; execution may have begun.',503,
        {retryable:true,executionId:execution.id,attemptId:execution.attemptId,operationId:execution.operationId}, { cause: error })
    }
  }
  private async authorize(sql: pg.PoolClient, principal: ManagementPrincipal, workspaceId: string,
    action: ManagementAction, scope: AuthorizedResource = {}) {
    const live = await readLiveManagementPrincipal(sql, principal.id)
    requireAuthorization(live, action, { ...scope, workspaceId })
    return live
  }
  private async read<T>(principal: ManagementPrincipal, workspaceId: string, action: ManagementAction,
    work: (sql: pg.PoolClient, live: ManagementPrincipal) => Promise<T>,
    source: 'http' | 'mcp' = 'http', scope: AuthorizedResource = {}): Promise<T> {
    try {
      requireAuthorization(principal, action, { ...scope, workspaceId })
    } catch (error) {
      await this.commands.recordDenied(principal.id, source, action, workspaceId)
      throw error
    }
    return withTransaction(this.pool, async (sql) => {
      const live = await this.authorize(sql, principal, workspaceId, action, scope)
      const result = await work(sql, live)
      await this.authorize(sql, principal, workspaceId, action, scope)
      return result
    })
  }
  private async readExecution<T>(principal: ManagementPrincipal, workspaceId: string, executionId: string,
    action: ManagementAction, work: (sql: pg.PoolClient, live: ManagementPrincipal) => Promise<T>,
    source: 'http' | 'mcp' = 'http'): Promise<T> {
    const scope = await this.repository.executionScope(this.pool, workspaceId, executionId)
    return this.read(principal, workspaceId, action, async (sql, live) => {
      const persistedScope = await this.repository.executionScope(sql, workspaceId, executionId)
      if (canonicalJson(scope) !== canonicalJson(persistedScope)) {
        throw new DomainError('JOB_SCOPE_CONFLICT', 'The job workflow relationship changed during the read.', 409)
      }
      return work(sql, live)
    }, source, scope)
  }
  private async command<T>(principal:ManagementPrincipal, source:'http'|'mcp', workspaceId:string, action:ManagementAction,
    commandId:string, operation:string, payload:unknown, perform:(sql:pg.PoolClient,live:ManagementPrincipal)=>Promise<T>):Promise<T> {
    try { requireAuthorization(principal,action,{workspaceId}) } catch(error) {
      await this.commands.recordDenied(principal.id,source,operation,workspaceId); throw error
    }
    let live = principal
    return (await this.commands.execute({principal,source,commandId,operation,targetKey:workspaceId,payload,
      authorize:async sql => { live = await this.authorize(sql,principal,workspaceId,action) },
      perform:async sql => { await lockActiveWorkspace(sql,workspaceId); const value=await perform(sql,live); await this.authorize(sql,principal,workspaceId,action); return value },
    })).value
  }
  choices(principal:ManagementPrincipal,workspaceId:string,source:'http'|'mcp'='http') {
    return this.read(principal,workspaceId,'job_definitions:read',(sql,live)=>this.ports.preparation.choices(sql,live,workspaceId),source)
  }
  readArtifact(principal:ManagementPrincipal,workspaceId:string,id:string,fileId:string,revisionId:string,source:'http'|'mcp'='http') {
    return this.readExecution(principal,workspaceId,id,'job_artifacts:read',async(sql,live)=>{
      await this.repository.execution(sql,workspaceId,id)
      const result=await this.ports.artifacts.read(sql,live,workspaceId,id,fileId,revisionId,source)
      const artifact=JobArtifactSchema.parse(result.artifact)
      if(artifact.executionId!==id||artifact.fileId!==fileId||artifact.revisionId!==revisionId||artifact.state!=='available'
        ||result.bytes.length!==artifact.byteSize||createHash('sha256').update(result.bytes).digest('hex')!==artifact.sha256) {
        throw new DomainError('JOB_ARTIFACT_INVALID','The exact artifact bytes are missing, expired or corrupt.',409)
      }
      return {artifact,bytes:result.bytes}
    },source)
  }
  async readArtifactPage(principal: ManagementPrincipal, workspaceId: string, executionId: string,
    input: { fileId: string; revisionId: string; offset: number; limit: number }) {
    const value = await this.readArtifact(principal, workspaceId, executionId, input.fileId, input.revisionId, 'mcp')
    if (input.offset > value.bytes.length) {
      throw new DomainError('INVALID_REQUEST', 'Artifact offset exceeds the revision size.', 400)
    }
    const end = Math.min(value.bytes.length, input.offset + input.limit)
    return {
      artifact: value.artifact,
      encoding: 'base64' as const,
      content: value.bytes.subarray(input.offset, end).toString('base64'),
      offset: input.offset,
      nextOffset: end < value.bytes.length ? end : null,
    }
  }
  listDefinitions(principal:ManagementPrincipal, workspaceId:string,source:'http'|'mcp'='http') {
    return this.read(principal,workspaceId,'job_definitions:read',async sql => (await sql.query<{record:unknown}>('select record from job_definitions where workspace_id=$1 order by id limit 100',[workspaceId])).rows.map(row=>JobDefinitionRecordSchema.parse(row.record)),source)
  }
  getDefinition(principal:ManagementPrincipal,workspaceId:string,id:string,source:'http'|'mcp'='http') {
    return this.read(principal,workspaceId,'job_definitions:read',sql=>this.repository.definition(sql,workspaceId,id),source)
  }
  readLogTail(principal: ManagementPrincipal, workspaceId: string, executionId: string) {
    return this.readExecution(principal, workspaceId, executionId, 'job_logs:read', async sql => {
      await this.repository.execution(sql, workspaceId, executionId)
      const rows = (await sql.query<{ text: string }>(`select text from job_log_chunks
        where execution_id=$1 order by sequence desc limit 33`, [executionId])).rows
      const bytes = Buffer.from(rows.slice(0, 32).reverse().map(row => row.text).join(''), 'utf8')
      return { text: bytes.subarray(Math.max(0, bytes.length - 32768)).toString('utf8'),
        truncated: rows.length > 32 || bytes.length > 32768 }
    }, 'mcp')
  }
  getDefinitionVersion(principal:ManagementPrincipal,workspaceId:string,definitionId:string,versionId:string,source:'http'|'mcp'='http') {
    return this.read(principal,workspaceId,'job_definitions:read',sql=>this.repository.version(sql,workspaceId,versionId,definitionId),source)
  }
  async getWorkflowExecutionReference(principal: ManagementPrincipal, workspaceId: string, runId: string,
    nodeExecutionId: string, source: 'http' | 'mcp' = 'http') {
    const scope = await this.repository.runScope(this.pool, workspaceId, runId)
    return this.read(principal, workspaceId, 'jobs:read', async sql => {
      const persistedScope = await this.repository.runScope(sql, workspaceId, runId)
      if (canonicalJson(scope) !== canonicalJson(persistedScope)) {
        throw new DomainError('JOB_SCOPE_CONFLICT', 'The job Run relationship changed during the read.', 409)
      }
      const row = (await sql.query<{ reference: unknown; job_execution_id: string }>(
        `select reference,job_execution_id from workflow_job_executions
          where run_id=$1 and node_execution_id=$2 for share`, [runId, nodeExecutionId])).rows[0]
      if (!row) {
        throw new DomainError('JOB_WORKFLOW_REFERENCE_NOT_FOUND', 'The persisted Run job relationship is missing.', 404)
      }
      const reference = JobWorkflowExecutionReferenceSchema.parse(row.reference)
      const runRow = (await sql.query<{ record: unknown }>(
        'select record from runs where id=$1 and workspace_id=$2 for share', [runId, workspaceId])).rows[0]
      const run = AcceptedWorkflowRunV3Schema.parse(runRow?.record)
      const execution = await this.repository.execution(sql, workspaceId, row.job_execution_id)
      const runMatches = run.id === runId && run.workspaceId === workspaceId && run.workflowId === scope.workflowId
      const referenceMatches = reference.workspaceId === workspaceId && reference.runId === runId
        && reference.nodeExecutionId === nodeExecutionId && reference.jobExecutionId === execution.id
        && reference.workflowId === run.workflowId && reference.workflowVersionId === run.workflowVersionId
      const executionMatches = execution.workflow?.runId === runId && execution.workflow.nodeId === reference.nodeId
        && execution.workflow.nodeExecutionId === nodeExecutionId && execution.workflow.workflowId === reference.workflowId
      if (!runMatches || !referenceMatches || !executionMatches) {
        throw new DomainError('JOB_WORKFLOW_PIN_CONFLICT', 'The persisted job relationship differs from its Run and execution.', 409)
      }
      return reference
    }, source, scope)
  }
  async saveDefinition(principal:ManagementPrincipal,source:'http'|'mcp',workspaceId:string,raw:JobDefinitionSaveRecord) {
    const input = parse(JobDefinitionSaveRecordSchema,raw)
    return this.command(principal,source,workspaceId,'job_definitions:write',input.commandId,'job.definition.save',input,async(sql,live)=>{
      const old = input.id ? await this.repository.definition(sql,workspaceId,input.id,true) : null
      if ((old?.revision ?? null) !== input.expectedRevision) throw new DomainError('REVISION_CONFLICT','The job definition changed since it was read.',409)
      const checked = await this.ports.preparation.validate(sql,live,workspaceId,input.spec)
      if (!checked.valid) throw new DomainError('JOB_NOT_READY','Job source, target or isolation is not authorized and ready.',409,{reasons:checked.reasons})
      const now=this.clock().toISOString()
      const value:JobDefinitionRecord=JobDefinitionRecordSchema.parse({schemaVersion:'verification' in input.spec ? 2 : 1,id:old?.id??randomUUID(),workspaceId,name:input.name,revision:(old?.revision??0)+1,versionId:randomUUID(),spec:input.spec,createdAt:old?.createdAt??now,updatedAt:now})
      await sql.query(`insert into job_definitions(id,workspace_id,revision,version_id,record,updated_by) values($1,$2,$3,$4,$5::jsonb,$6)
        on conflict(id) do update set revision=excluded.revision,version_id=excluded.version_id,record=excluded.record,updated_by=excluded.updated_by`,[value.id,workspaceId,value.revision,value.versionId,JSON.stringify(value),live.id])
      await sql.query('insert into job_definition_versions(id,definition_id,workspace_id,revision,record) values($1,$2,$3,$4,$5::jsonb)',[value.versionId,value.id,workspaceId,value.revision,JSON.stringify(value)])
      return value
    })
  }
  validate(principal:ManagementPrincipal,workspaceId:string,raw:JobDefinitionSpecRecord,source:'http'|'mcp'='http') {
    const spec=parse(JobDefinitionSpecRecordSchema,raw)
    return this.read(principal,workspaceId,'job_definitions:read',async (sql,live) => {
      const checked = await this.ports.preparation.validate(sql,live,workspaceId,spec)
      if (checked.valid && !isAutoJobSpecRecord(spec) && this.ports.placement) return this.ports.placement.validateFixed(sql, spec)
      return checked
    },source)
  }
  validateLaunch(principal: ManagementPrincipal, workspaceId: string, raw: unknown, source: 'http' | 'mcp' = 'http') {
    const input = parse(JobLaunchValidationInputSchema, raw)
    return this.read(principal, workspaceId, 'jobs:start', async (sql, live) => {
      const configuration = this.queueConfiguration()
      const definition = await this.repository.definition(sql, workspaceId, input.definitionId)
      if (definition.revision !== input.expectedRevision) {
        throw new DomainError('REVISION_CONFLICT', 'The job definition changed since it was read.', 409)
      }
      const resources = JobResourceRequestSchema.parse(await configuration.resources(sql, definition))
      const spec = jobPlacementRequest(definition.spec, {
        placementOverride: input.placementOverride,
        limits: resources.limits,
      })
      const checked = await this.ports.preparation.validate(sql, live, workspaceId, spec)
      const mayWait = checked.reasons.length > 0 && checked.reasons.every(jobCanWait)
      if (!checked.valid && !mayWait) {
        return JobLaunchValidationSchema.parse({ ...checked, canQueue: false })
      }
      try {
        const readiness = await this.ports.placement!.validateRequest(sql, live, workspaceId,
          spec, input.placementOverride)
        return JobLaunchValidationSchema.parse({ ...readiness, valid: checked.valid && readiness.valid,
          reasons: [...new Set([...checked.reasons, ...readiness.reasons])] })
      } catch (error) {
        if (!(error instanceof DomainError) || error.status !== 409) throw error
        return JobLaunchValidationSchema.parse({ valid: false, canQueue: jobCanWait(error.code),
          reasons: [error.code], sideEffects: false })
      }
    }, source)
  }
  private async transaction<T>(work:(sql:pg.PoolClient)=>Promise<T>):Promise<T> {
    return withTransaction(this.pool, work)
  }
  private queueConfiguration(): JobQueueConfiguration {
    const configuration = this.ports.queue
    if (!configuration || !this.queuePreparation) {
      throw new DomainError('JOB_QUEUE_UNAVAILABLE', 'Starting build Jobs requires owner-reviewed queue configuration on Main.', 503)
    }
    const review = z.object({ reviewedByPrincipalId: z.string().min(1), reviewedAt: z.iso.datetime(),
      decisionDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict()
    if (!Number.isSafeInteger(configuration.revision) || configuration.revision < 1
      || !review.safeParse(configuration.review).success) {
      throw new DomainError('JOB_QUEUE_REVIEW_REQUIRED', 'The queue configuration requires owner review.', 409)
    }
    JobQueueLimitsSchema.parse(configuration.limits)
    return configuration
  }
  async enqueue(principal: ManagementPrincipal, source: 'http' | 'mcp', workspaceId: string, raw: unknown,
    options: { runtimePreparation?: ManagementPrincipal; initiatingAgent?: JobInitiatingAgent | undefined } = {}) {
    const input = parse(JobQueuedStartSchema, raw)
    const initiatingAgent = options.initiatingAgent ? JobInitiatingAgentSchema.parse(options.initiatingAgent) : undefined
    const payload = initiatingAgent ? { ...input, initiatingAgent } : input
    const historical = await this.read(principal, workspaceId, 'jobs:start', async sql =>
      (await sql.query(`select 1 from job_preparations p
        where p.principal_id=$1 and p.command_id=$2 and p.workspace_id=$3
        and not exists(select 1 from job_admission_queue q where q.execution_id=p.execution_id)`,
      [principal.id, input.commandId, workspaceId])).rows.length > 0, source)
    if (historical) {
      const execution = await this.start(principal, source, workspaceId, parse(JobStartSchema, input))
      return JobAdmissionResultSchema.parse({ kind: 'retained-execution', execution })
    }
    const result = await this.command(principal, source, workspaceId, 'jobs:start', input.commandId,
      'job.enqueue', payload, async (sql, live) => {
        const configuration = this.queueConfiguration()
        await sql.query('select pg_advisory_xact_lock(810038,hashtext($1))', ['job-admission-order'])
        const original = (await sql.query<{ execution_id: string }>(
          'select execution_id from job_preparations where principal_id=$1 and command_id=$2',
          [live.id, input.commandId])).rows[0]
        if (original) {
          throw new DomainError('COMMAND_ID_CONFLICT', 'This command already owns a build preparation.', 409,
            { executionId: original.execution_id })
        }
        const definition = await this.repository.definition(sql, workspaceId, input.definitionId, true)
        if (definition.revision !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'The job definition changed since it was read.', 409)
        }
        const counts = (await sql.query<{ principal: string; workspace: string }>(`select
          count(*) filter(where principal_id=$1)::text as principal,
          count(*) filter(where workspace_id=$2)::text as workspace from job_admission_queue
          where record->>'state' in ('waiting','blocked','claimed')`, [live.id, workspaceId])).rows[0]!
        if (Number(counts.principal) >= configuration.limits.maxPendingPerPrincipal
          || Number(counts.workspace) >= configuration.limits.maxPendingPerWorkspace) {
          throw new DomainError('JOB_QUEUE_LIMIT', 'The pending Job limit has been reached. Wait or cancel a queued Job.', 409)
        }
        const resources = JobResourceRequestSchema.parse(await configuration.resources(sql, definition))
        const sequence = (await sql.query<{ sequence: string }>(
          "select nextval('job_admission_queue_sequence')::text as sequence")).rows[0]!.sequence
        const now = this.clock()
        const placementOverride = input.placementOverride ?? null
        const placement = placementOverride ?? (isAutoJobSpecRecord(definition.spec)
          ? { kind: 'auto' as const } : { kind: 'explicit' as const, target: definition.spec.target })
        const ticket = JobQueueTicketSchema.parse({ schemaVersion: 1, id: randomUUID(), workspaceId,
          revision: 1, commandId: input.commandId, commandDigest: jobDigest(payload), principalId: live.id,
          definition, executionId: randomUUID(), attemptId: randomUUID(), operationId: randomUUID(),
          workflow: null,
          ...(options.runtimePreparation ? { runtimePreparation: options.runtimePreparation } : {}),
          ...(initiatingAgent ? { initiatingAgent } : {}),
          gateId: null, placement, placementOverride, resources, enqueueSequence: sequence,
          enqueuedAt: now.toISOString(), deadlineAt: new Date(now.getTime() + definition.spec.policy.queueTimeoutMs).toISOString(),
          state: 'waiting', waitingReasons: [], compatibleTargetCount: 0, queuePosition: 1, estimatedStartAt: null,
          reservationId: null, cancelRequestedAt: null, terminalReason: null, finishedAt: null })
        await sql.query(`insert into job_admission_queue
          (id,workspace_id,principal_id,command_id,execution_id,enqueue_sequence,record)
          values($1,$2,$3,$4,$5,$6::bigint,$7::jsonb)`,
        [ticket.id, workspaceId, live.id, input.commandId, ticket.executionId, sequence, JSON.stringify(ticket)])
        return { ticketId: ticket.id }
      })
    this.requestQueueWake()
    return this.read(principal, workspaceId, 'jobs:start', async sql => this.admissionResult(
      await this.repository.queuePosition(sql, await this.repository.queueTicket(sql, workspaceId, result.ticketId))), source)
  }
  async getQueueTicket(principal: ManagementPrincipal, workspaceId: string, id: string, source: 'http' | 'mcp' = 'http') {
    const scope = await this.repository.queueTicketScope(this.pool, workspaceId, id)
    return this.read(principal, workspaceId, 'jobs:read', async sql => {
      const persistedScope = await this.repository.queueTicketScope(sql, workspaceId, id)
      if (canonicalJson(scope) !== canonicalJson(persistedScope)) {
        throw new DomainError('JOB_SCOPE_CONFLICT', 'The queued Job relationship changed during the read.', 409)
      }
      return this.repository.queuePosition(sql, await this.repository.queueTicket(sql, workspaceId, id))
    }, source, scope)
  }
  async getAdmission(principal: ManagementPrincipal, workspaceId: string, id: string, source: 'http' | 'mcp' = 'http') {
    return this.admissionResult(await this.getQueueTicket(principal, workspaceId, id, source))
  }
  private admissionResult(ticket: JobQueueTicket) {
    if (jobQueueHasExecution(ticket)) return JobAdmissionResultSchema.parse({ kind: 'accepted',
      ticketId: ticket.id, executionId: ticket.executionId })
    return JobAdmissionResultSchema.parse({ kind: 'pending-admission', ticket })
  }
  listQueue(principal: ManagementPrincipal, workspaceId: string, source: 'http' | 'mcp' = 'http') {
    return this.listQueuePage(principal, workspaceId, {}, source).then(page => page.tickets)
  }
  async listQueuePage(principal: ManagementPrincipal, workspaceId: string, raw: unknown,
    source: 'http' | 'mcp' = 'http') {
    const input = parse(JobQueueListInputSchema, raw)
    const originScope = input.initiatingExecutionId
      ? await this.repository.initiatingExecutionScope(this.pool, workspaceId, input.initiatingExecutionId) : {}
    const scope = input.workflowId ? { ...originScope, workflowId: input.workflowId } : originScope
    return this.read(principal, workspaceId, 'jobs:read', async sql => {
      if (input.initiatingExecutionId) {
        const persistedScope = await this.repository.initiatingExecutionScope(sql, workspaceId,
          input.initiatingExecutionId)
        if (canonicalJson(originScope) !== canonicalJson(persistedScope)) {
          throw new DomainError('JOB_SCOPE_CONFLICT', 'The initiating Agent relationship changed during the read.', 409)
        }
        if (input.workflowId && originScope.workflowId && input.workflowId !== originScope.workflowId) {
          throw new DomainError('JOB_SCOPE_CONFLICT', 'The initiating Agent belongs to another workflow.', 409)
        }
      }
      if (input.workflowId) {
        const workflow = await sql.query('select id from workflows where workspace_id=$1 and id=$2',
          [workspaceId, input.workflowId])
        if (!workflow.rows.length) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not found.', 404)
      }
      const originFilter = `($2::text is null or q.record #>> '{initiatingAgent,executionId}'=$2)
        and ($3::text is null or exists(select 1 from runs r where r.workspace_id=q.workspace_id
          and r.workflow_id=$3 and ($4::text is null or r.id=$4)
          and ((r.id=q.record #>> '{workflow,runId}' and r.workflow_id=q.record #>> '{workflow,workflowId}')
            or (r.id=q.record #>> '{initiatingAgent,runId}'
              and r.workflow_id=q.record #>> '{initiatingAgent,workflowId}'))))`
      const filters = [workspaceId, input.initiatingExecutionId ?? null, scope.workflowId ?? null,
        originScope.runId ?? null]
      const active = `(q.record->>'state' in ('waiting','blocked','claimed') or
        (q.record->>'state'='accepted' and exists(select 1 from job_executions e where e.id=q.execution_id
          and (e.record #>> '{process,phase}'<>'terminal'
            or e.record #> '{process,processStopped}'<>'true'::jsonb
            or e.record->>'publication' in ('pending','collecting')
            or exists(select 1 from source_execution_materializations m
              where m.operation_id=e.operation_id and m.state<>'closed')
            or exists(select 1 from job_computer_selections s
              where s.execution_id=e.id and s.released_at is null))))
        or exists(select 1 from job_computer_selections s where s.execution_id=q.execution_id
          and s.workspace_id=q.workspace_id and s.released_at is null)
        or exists(select 1 from source_execution_materializations m where m.execution_id=q.execution_id
          and m.workspace_id=q.workspace_id and m.state<>'closed')
        or exists(select 1 from source_storage_reservations r where r.owner_kind='materialization'
          and r.owner_id=q.record->>'operationId' and r.state in ('preparing','owned','uncertain'))
        or exists(select 1 from source_preparation_reconciliations c where c.operation_id=q.record->>'operationId'
          and c.workspace_id=q.workspace_id and c.status<>'closed'))`
      const rows = (await sql.query<{ record: unknown }>(`select q.record from job_admission_queue q
        where q.workspace_id=$1 and ${originFilter}
          and ${active} order by q.enqueue_sequence`, filters)).rows
      const history = (await sql.query<{ record: unknown }>(`select q.record from job_admission_queue q
        where q.workspace_id=$1 and ${originFilter}
          and not ${active}
          and ($5::bigint is null or q.enqueue_sequence<$5::bigint)
        order by q.enqueue_sequence desc limit $6`,
      [...filters, input.historyBeforeSequence ?? null, input.historyLimit + 1])).rows
      const hasMore = history.length > input.historyLimit
      const historyTickets = history.slice(0, input.historyLimit).map(row => JobQueueTicketSchema.parse(row.record))
      const tickets: JobQueueTicket[] = []
      for (const row of rows) tickets.push(await this.repository.queuePosition(sql, JobQueueTicketSchema.parse(row.record)))
      for (const ticket of historyTickets) tickets.push(await this.repository.queuePosition(sql, ticket))
      return JobQueuePageSchema.parse({ tickets,
        nextHistoryCursor: hasMore ? historyTickets.at(-1)!.enqueueSequence : null })
    }, source, scope)
  }
  async cancelQueued(principal: ManagementPrincipal, source: 'http' | 'mcp', workspaceId: string, raw: unknown) {
    const input = parse(JobQueueCancelSchema, raw)
    await this.command(principal, source, workspaceId, 'jobs:cancel', input.commandId, 'job.queue.cancel', input,
      async (sql, live) => {
        const ticket = await this.repository.queueTicket(sql, workspaceId, input.ticketId, true)
        if (ticket.revision !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'The queued Job changed since it was read.', 409)
        }
        if (ticket.state === 'terminal') return { ticketId: ticket.id }
        ticket.cancelRequestedAt ??= this.clock().toISOString()
        if (['waiting', 'blocked'].includes(ticket.state)) {
          await this.repository.finishQueueTicket(sql, ticket, 'cancelled', this.clock().toISOString())
        } else {
          if (ticket.state === 'accepted') {
            const execution = await this.repository.execution(sql, workspaceId, ticket.executionId, true)
            if (execution.process.phase !== 'terminal') {
              await this.ports.dispatch.cancel(sql, execution, input.commandId, live)
              execution.cancelRequestedAt ??= ticket.cancelRequestedAt
              execution.updatedAt = this.clock().toISOString()
              await this.repository.putExecution(sql, execution)
            }
          }
          await this.repository.putQueueTicket(sql, ticket)
        }
        return { ticketId: ticket.id }
      })
    const readTicket = () => this.read(principal, workspaceId, 'jobs:cancel', async sql =>
      this.repository.queuePosition(sql, await this.repository.queueTicket(sql, workspaceId, input.ticketId)), source)
    const ticket = await readTicket()
    if (ticket.state === 'accepted') {
      await this.wakeAccepted(await this.read(principal, workspaceId, 'jobs:cancel',
        sql => this.repository.execution(sql, workspaceId, ticket.executionId), source))
    }
    return readTicket()
  }
  async wakeQueue(): Promise<void> {
    if (!this.queuePreparation) return Promise.resolve()
    this.queueConfiguration()
    this.ports.refreshRuntimeMetadata?.()
    if (this.queueWake) {
      this.queueRescanRequested = true
    } else if (!this.queueClosing) {
      const preparation = this.queuePreparation
      this.queueWake = (async () => {
        const tasks = new Set<Promise<void>>()
        do {
          this.queueRescanRequested = false
          await this.runtimePreparation?.recover()
          for (const task of await preparation.scan()) tasks.add(task)
        } while (this.queueRescanRequested && !this.queueClosing)
        return [...tasks]
      })().finally(() => { this.queueWake = undefined })
    }
    const tasks = await this.queueWake
    await this.queuePreparation.waitForWork(tasks)
  }
  requestQueueWake(): void {
    if (this.queueClosing) return
    void this.wakeQueue().catch(error => componentLogger('jobs').error({ err: error }, 'Job queue rescan failed'))
  }
  startQueueRecovery(): void {
    this.queueConfiguration()
    if (this.queueTimer) return
    this.queueClosing = false
    const rescan = () => this.requestQueueWake()
    this.queueTimer = setInterval(rescan, 1000)
    this.queueTimer.unref()
    rescan()
  }
  async closeQueue(): Promise<void> {
    if (this.queueTimer) clearInterval(this.queueTimer)
    this.queueTimer = undefined
    this.queueClosing = true
    const tasks = await this.queueWake
    await this.queuePreparation?.waitForWork(tasks)
    await this.runtimePreparation?.close()
  }
  async start(principal:ManagementPrincipal,source:'http'|'mcp',workspaceId:string,raw:JobStart) {
    const input=parse(JobStartSchema,raw)
    try {requireAuthorization(principal,'jobs:start',{workspaceId})} catch(error) {
      await this.commands.recordDenied(principal.id,source,'job.start',workspaceId);throw error
    }
    const existingStart = await this.read(principal, workspaceId, 'jobs:start', async sql => {
      const row = (await sql.query<{ queued: boolean; preparing: boolean }>(`select
        exists(select 1 from job_admission_queue where principal_id=$1 and command_id=$2) as queued,
        exists(select 1 from job_preparations where principal_id=$1 and command_id=$2) as preparing`,
      [principal.id, input.commandId])).rows[0]!
      return row
    }, source)
    if (existingStart.queued || this.ports.queue && !existingStart.preparing) {
      throw new DomainError('JOB_QUEUE_START_REQUIRED', 'Use queued admission to start build Jobs.', 409)
    }
    let allocatedIdentity: JobPreparationIdentity | undefined
    let admission:{kind:'existing';execution:JobExecutionRecord}|{kind:'prepared';definition:JobDefinitionRecord;spec:PreparedJobSpecRecord;identity:{executionId:string;attemptId:string;operationId:string}}|undefined
    const result=await this.commands.execute({principal,source,commandId:input.commandId,operation:'job.start',targetKey:workspaceId,payload:input,dedicatedConnection:true,
      authorize:sql=>this.authorize(sql,principal,workspaceId,'jobs:start').then(()=>undefined),
      prepare:async()=>{
        const reserved=await this.transaction(async sql=>{
          const live=await this.authorize(sql,principal,workspaceId,'jobs:start');await lockActiveWorkspace(sql,workspaceId)
          const existing=(await sql.query<{execution_id:string;attempt_id:string;operation_id:string;definition:unknown}>('select execution_id,attempt_id,operation_id,definition from job_preparations where principal_id=$1 and command_id=$2 for update',[live.id,input.commandId])).rows[0]
          if(existing) {
            const definition=JobDefinitionRecordSchema.parse(existing.definition)
            if(definition.workspaceId!==workspaceId||definition.id!==input.definitionId||definition.revision!==input.expectedRevision)throw new DomainError('COMMAND_ID_CONFLICT','This job preparation command is bound to another saved revision.',409)
            return {definition,principal:live,identity:{executionId:existing.execution_id,attemptId:existing.attempt_id,operationId:existing.operation_id}}
          }
          const definition=await this.repository.definition(sql,workspaceId,input.definitionId,true)
          if(definition.revision!==input.expectedRevision)throw new DomainError('REVISION_CONFLICT','The job definition changed since it was read.',409)
          const identity={executionId:randomUUID(),attemptId:randomUUID(),operationId:randomUUID()}
          await sql.query('insert into job_preparations(execution_id,attempt_id,operation_id,workspace_id,definition_version_id,principal_id,command_id,definition) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)',[identity.executionId,identity.attemptId,identity.operationId,workspaceId,definition.versionId,live.id,input.commandId,JSON.stringify(definition)])
          await this.resolveDefinition(sql, live, definition, identity)
          return {definition,principal:live,identity}
        })
        allocatedIdentity = reserved.identity
        const existing=await this.transaction(async sql=>{
          await this.authorize(sql,principal,workspaceId,'jobs:start')
          const row=(await sql.query<{record:unknown}>('select record from job_executions where id=$1',[reserved.identity.executionId])).rows[0]
          return row?JobExecutionRecordSchema.parse(row.record):null
        })
        if(existing){admission={kind:'existing',execution:existing};return}
        // Only immutable source/byte preparation crosses this gap; no SQL row locks or launch right.
        const spec=await this.prepareDefinition(this.pool,reserved.principal,reserved.definition,reserved.identity)
        admission={kind:'prepared',definition:reserved.definition,identity:reserved.identity,spec}
      },
      perform:async sql=>{
          if(!admission)throw new DomainError('JOB_PREPARATION_MISSING','The actual job admission preparation is missing.',409)
          if(admission.kind==='existing')return admission.execution
          const {definition,identity,spec}=admission
          const live=await this.authorize(sql,principal,workspaceId,'jobs:start');await lockActiveWorkspace(sql,workspaceId)
          await requireJobPreparationDeadline(sql,'manual',identity.executionId,definition.spec.policy.preparationTimeoutMs,this.clock().getTime())
          const current=await this.repository.definition(sql,workspaceId,input.definitionId,true)
          if(current.versionId!==definition.versionId)throw new DomainError('REVISION_CONFLICT','The job definition changed during preparation.',409)
          const resolved = await this.resolvedDefinition(sql, definition, identity)
          const ready=await this.ports.preparation.validate(sql,live,workspaceId,resolved)
          if(!ready.valid)throw new DomainError('JOB_NOT_READY','Job authority changed during preparation.',409,{reasons:ready.reasons})
          const execution=await this.admitPrepared(sql,live,definition,null,null,spec,identity)
          await this.authorize(sql,principal,workspaceId,'jobs:start');return execution
      }}).catch(async error => {
        if (this.ports.placement && allocatedIdentity) {
          const identity = allocatedIdentity
          await this.transaction(sql => releaseUnstartedJobComputer(sql, identity))
        }
        throw error
      })
    const execution=JobExecutionRecordSchema.parse(result.value)
    await this.wakeAccepted(execution)
    return this.read(principal,workspaceId,'jobs:start',sql=>this.repository.execution(sql,workspaceId,execution.id),source)
  }
  async resolveDefinition(sql: JobSql, principal: ManagementPrincipal, definition: JobDefinitionRecord,
    identity: JobPreparationIdentity): Promise<ResolvedJobDefinitionSpecRecord> {
    if (this.ports.placement) return this.ports.placement.reserve(sql, principal, definition, identity)
    if (isAutoJobSpecRecord(definition.spec)) {
      throw new DomainError('JOB_AUTO_UNAVAILABLE', 'Automatic build selection is unavailable.', 503)
    }
    this.workerExecution.requireEnabled(definition.spec.target.hostRef)
    return definition.spec
  }
  private async resolvedDefinition(sql: JobSql, definition: JobDefinitionRecord, identity: JobPreparationIdentity) {
    if (this.ports.placement) return this.ports.placement.prepare(sql, definition, identity)
    if (isAutoJobSpecRecord(definition.spec)) throw new DomainError('JOB_AUTO_UNAVAILABLE', 'Automatic build selection is unavailable.', 503)
    return definition.spec
  }
  async prepareDefinition(sql:JobSql,principal:ManagementPrincipal,definition:JobDefinitionRecord,identity:JobPreparationIdentity) {
    const resolved = await this.resolvedDefinition(sql, definition, identity)
    this.workerExecution.requireEnabled(resolved.target.hostRef)
    const prepared = await this.ports.preparation.accept(sql,principal,definition.workspaceId,resolved,identity)
    const selection = await this.ports.placement?.selection(sql, identity)
    return selection ? { ...prepared, computerSelection: selection } : prepared
  }
  /** Workflow adapter calls inside its own accepted-node transaction; no Operator token enters a build. */
  async admit(sql:JobSql,principal:ManagementPrincipal,definition:JobDefinitionRecord,workflow:JobExecutionRecord['workflow'],workflowInput:RunInput|null=null):Promise<JobExecutionRecord> {
    if((workflow===null)!==(workflowInput===null))throw new DomainError('JOB_INPUT_BINDING_MISSING','A workflow job requires its exact accepted input snapshot.',409)
    const id=workflow?.nodeExecutionId??randomUUID(),attemptId=randomUUID(),operationId=randomUUID()
    await this.resolveDefinition(sql, principal, definition, {executionId:id,attemptId,operationId})
    const spec=await this.prepareDefinition(sql,principal,definition,{executionId:id,attemptId,operationId})
    return this.admitPrepared(sql,principal,definition,workflow,workflowInput,spec,{executionId:id,attemptId,operationId})
  }
  /** Same admission writer after a workflow driver performs source I/O outside the Run-owner transaction. */
  async admitPrepared(
    sql: JobSql,
    principal: ManagementPrincipal,
    definition: JobDefinitionRecord,
    workflow: JobExecutionRecord['workflow'],
    workflowInput: RunInput | null,
    spec: PreparedJobSpecRecord,
    identity: JobPreparationIdentity & { initiatingAgent?: JobInitiatingAgent | undefined },
  ): Promise<JobExecutionRecord> {
    this.workerExecution.requireEnabled(spec.target.hostRef)
    if((workflow===null)!==(workflowInput===null)||workflow&&workflow.nodeExecutionId!==identity.executionId)throw new DomainError('JOB_INPUT_BINDING_MISSING','The prepared job must match its exact workflow execution and input.',409)
    const {executionId:id,attemptId,operationId}=identity
    const request=await this.resolvedDefinition(sql, definition, identity)
    const computerSelection = await this.ports.placement?.selection(sql, identity)
    if (canonicalJson(computerSelection ?? null) !== canonicalJson(spec.computerSelection ?? null)) {
      throw new DomainError('JOB_COMPUTER_SELECTION_CONFLICT', 'Preparation changed its original computer selection.', 409)
    }
    const {materializationId:_materialization,materializationDigest:_digest,...source}=spec.source
    void _materialization;void _digest
    const selection=(target:ResolvedJobDefinitionSpecRecord['target'])=>({mainId:target.mainId,hostRef:target.hostRef,registration:target.registration,mainInstallationId:target.mainInstallationId,
      rootPolicyId:target.destination.rootPolicyId,rootPolicyRevision:target.destination.rootPolicyRevision,locationRevision:target.destination.locationRevision})
    if(canonicalJson(source)!==canonicalJson(request.source)||canonicalJson(selection(spec.target))!==canonicalJson(selection(request.target))
      ||canonicalJson({argv:spec.argv,inputs:spec.inputs,policy:spec.policy,outputs:spec.outputs,relativeCwd:spec.relativeCwd??null,verification:'verification' in spec?spec.verification:null})!==canonicalJson({argv:request.argv,inputs:request.inputs,policy:request.policy,outputs:request.outputs,relativeCwd:request.relativeCwd??null,verification:'verification' in request?request.verification:null})) {
      throw new DomainError('JOB_ACCEPTANCE_PIN_CONFLICT','Preparation cannot change the saved source selection, command, policy or target authority.',409)
    }
    const acceptedSpec = 'verification' in spec
      ? await acceptVerificationSpec(sql, { definition, spec, workflowInput, executionId: id, attemptId, operationId })
      : JobAcceptedSpecRecordSchema.parse({...spec,workflowInput,definitionId:definition.id,definitionRevision:definition.revision,definitionVersionId:definition.versionId,
        ...jobSpecDigests(spec,workflowInput)})
    const now=this.clock().toISOString()
    const binding=await this.ports.dispatch.accept(sql,{workspaceId:definition.workspaceId,executionId:id,attemptId,operationId,spec:acceptedSpec,workflow,principal})
    const execution=JobExecutionRecordSchema.parse({schemaVersion:'verification' in acceptedSpec ? 2 : 1,id,workspaceId:definition.workspaceId,acceptedSpec,...binding,workflow,
      ...(identity.initiatingAgent ? { initiatingAgent: identity.initiatingAgent } : {}),
      process:{phase:'queued',outcome:null,exitCode:null,signal:null,processStopped:false},transport:'unknown',publication:'pending',
      startedAt:null,finishedAt:null,lastSeenAt:null,resultIssue:null,cancelRequestedAt:null,createdAt:now,updatedAt:now})
    await sql.query('insert into job_executions(id,workspace_id,definition_version_id,operation_id,attempt_id,record,accepted_spec,accepted_by) values($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)',[id,definition.workspaceId,definition.versionId,execution.operationId,execution.attemptId,JSON.stringify(execution),JSON.stringify(acceptedSpec),principal.id])
    await this.ports.preparation.adoptFinalBinding(sql,principal,execution)
    return execution
  }
  getExecution(principal:ManagementPrincipal,workspaceId:string,id:string,source:'http'|'mcp'='http') {
    return this.readExecution(principal,workspaceId,id,'jobs:read',sql=>this.repository.execution(sql,workspaceId,id),source)
  }
  listExecutions(principal:ManagementPrincipal,workspaceId:string,source:'http'|'mcp'='http') {
    return this.read(principal,workspaceId,'jobs:read',async sql=>(await sql.query<{record:unknown}>('select record from job_executions where workspace_id=$1 order by id desc limit 100',[workspaceId])).rows.map(row=>JobExecutionRecordSchema.parse(row.record)),source)
  }
  listWorkflowExecutions(principal: ManagementPrincipal, workspaceId: string, workflowId: string,
    raw: unknown, source: 'http' | 'mcp' = 'http') {
    const input = parse(WorkflowJobListInputSchema, raw)
    return this.read(principal, workspaceId, 'jobs:read', async sql => {
      const workflow = await sql.query('select id from workflows where workspace_id=$1 and id=$2',
        [workspaceId, workflowId])
      if (!workflow.rows.length) throw new DomainError('WORKFLOW_NOT_FOUND', 'Workflow not found.', 404)
      return this.repository.workflowExecutions(sql, workspaceId, workflowId, input)
    }, source, { workflowId })
  }
  private recovery() {
    if (!this.ports.cancellationRecovery) throw new DomainError('JOB_RECOVERY_UNAVAILABLE', 'Job cleanup recovery is unavailable.', 503)
    return this.ports.cancellationRecovery
  }
  proposeCancellationRecovery(principal: ManagementPrincipal, source: 'http' | 'mcp', input: unknown) {
    return this.recovery().propose(principal, source, input)
  }
  getCancellationRecovery(principal: ManagementPrincipal, input: unknown) {
    return this.recovery().get(principal, input)
  }
  approveCancellationRecovery(principal: ManagementPrincipal, source: 'http' | 'mcp', input: unknown) {
    return this.recovery().approve(principal, source, input)
  }
  async cancel(principal:ManagementPrincipal,source:'http'|'mcp',workspaceId:string,id:string,commandId:string,
    recovery?: JobCancellationRecoveryApply) {
    parse(z.string().min(1),commandId)
    if (recovery) return this.recovery().apply(principal, source, workspaceId, id, commandId, recovery)
    await this.command(principal,source,workspaceId,'jobs:cancel',commandId,'job.cancel',{id},async(sql,live)=>{
      const execution=await this.repository.execution(sql,workspaceId,id,true)
      if(execution.process.phase!=='terminal') {
        await this.ports.dispatch.cancel(sql,execution,commandId,live)
        execution.cancelRequestedAt??=this.clock().toISOString(); execution.updatedAt=this.clock().toISOString()
        await this.repository.putExecution(sql,execution)
      }
      return {executionId:id}
    })
    await this.wakeAccepted(await this.read(principal,workspaceId,'jobs:cancel',sql=>this.repository.execution(sql,workspaceId,id),source))
    return this.read(principal,workspaceId,'jobs:cancel',sql=>this.repository.execution(sql,workspaceId,id),source)
  }
  readLogs(principal:ManagementPrincipal,workspaceId:string,id:string,afterSequence:number,limit:number,source:'http'|'mcp'='http') {
    parse(z.number().int().nonnegative(),afterSequence); parse(z.number().int().min(1).max(100),limit)
    return this.readExecution(principal,workspaceId,id,'job_logs:read',async sql=>{
      await this.repository.execution(sql,workspaceId,id)
      const chunks=await this.repository.logs(sql,id,afterSequence,limit)
      const row=(await sql.query<{log_truncated:boolean}>('select log_truncated from job_executions where id=$1',[id])).rows[0]!
      return JobLogPageSchema.parse({chunks,nextCursor:chunks.at(-1)?.sequence??afterSequence,truncated:row.log_truncated,gap:null})
    },source)
  }
  listArtifacts(principal:ManagementPrincipal,workspaceId:string,id:string,source:'http'|'mcp'='http') {
    return this.readExecution(principal,workspaceId,id,'job_artifacts:read',async(sql,live)=>{
      await this.repository.execution(sql,workspaceId,id)
      return this.ports.artifacts.list(sql,live,workspaceId,id)
    },source)
  }
}
