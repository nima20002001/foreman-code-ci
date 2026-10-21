import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { JobLogChunkSchema, type JobLogChunk } from '@foreman-code/contracts/jobs'
import {
  JobDefinitionRecordSchema,
  JobExecutionRecordSchema,
  WorkflowJobPageSchema,
  type WorkflowJobListInput,
  ResolvedJobDefinitionSpecRecordSchema,
  type JobDefinitionRecord,
  type JobExecutionRecord,
} from '@foreman-code/contracts/job-verification'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { DomainError } from '../errors.js'
import { JobQueueTicketSchema, type JobQueueTicket } from '@foreman-code/contracts/job-admission'
export type JobSql = GraphSqlClient

export class JobRepository {
  async runScope(sql: JobSql, workspaceId: string, runId: string) {
    const row = (await sql.query<{ workflow_id: string }>(
      'select workflow_id from runs where workspace_id=$1 and id=$2', [workspaceId, runId])).rows[0]
    return row ? { workflowId: row.workflow_id, runId } : {}
  }
  async initiatingExecutionScope(sql: JobSql, workspaceId: string, executionId: string) {
    const row = (await sql.query<{ workflow_id: string; run_id: string }>(`select r.workflow_id,e.run_id
      from harness_executions e join runs r on r.id=e.run_id
      where r.workspace_id=$1 and e.id=$2`, [workspaceId, executionId])).rows[0]
    return row ? { workflowId: row.workflow_id, runId: row.run_id } : {}
  }
  async queueTicketScope(sql: JobSql, workspaceId: string, id: string) {
    const row = (await sql.query<{ record: unknown }>(
      'select record from job_admission_queue where workspace_id=$1 and id=$2', [workspaceId, id])).rows[0]
    if (!row) return {}
    const ticket = JobQueueTicketSchema.parse(row.record)
    if (ticket.id !== id || ticket.workspaceId !== workspaceId) {
      throw new DomainError('JOB_SCOPE_CONFLICT', 'The queued Job scope conflicts with persistence.', 409)
    }
    for (const origin of [ticket.workflow, ticket.initiatingAgent]) {
      if (!origin) continue
      const scope = await this.runScope(sql, workspaceId, origin.runId)
      if (scope.workflowId === origin.workflowId) return scope
    }
    return {}
  }
  async queueTicket(sql: JobSql, workspaceId: string, id: string, lock = false): Promise<JobQueueTicket> {
    const row = (await sql.query<{ record: unknown }>(
      `select record from job_admission_queue where workspace_id=$1 and id=$2${lock ? ' for update' : ''}`,
      [workspaceId, id],
    )).rows[0]
    if (!row) throw new DomainError('JOB_QUEUE_NOT_FOUND', 'The queued Job was not found in this workspace.', 404)
    const ticket = JobQueueTicketSchema.parse(row.record)
    if (ticket.workspaceId !== workspaceId || ticket.id !== id) {
      throw new DomainError('JOB_SCOPE_CONFLICT', 'The queued Job scope conflicts with persistence.', 409)
    }
    return ticket
  }
  async putQueueTicket(sql: JobSql, ticket: JobQueueTicket): Promise<JobQueueTicket> {
    const current = await this.queueTicket(sql, ticket.workspaceId, ticket.id, true)
    if (current.revision !== ticket.revision) {
      throw new DomainError('REVISION_CONFLICT', 'The queued Job changed since it was read.', 409)
    }
    if (canonicalJson(current) === canonicalJson(ticket)) return current
    const value = JobQueueTicketSchema.parse({ ...ticket, revision: ticket.revision + 1 })
    const result = await sql.query(`update job_admission_queue set record=$3::jsonb
      where workspace_id=$1 and id=$2 and (record->>'revision')::bigint=$4`,
    [value.workspaceId, value.id, JSON.stringify(value), ticket.revision])
    if (result.rowCount !== 1) throw new DomainError('REVISION_CONFLICT', 'The queued Job changed since it was read.', 409)
    return value
  }
  async queuePosition(sql: JobSql, ticket: JobQueueTicket): Promise<JobQueueTicket> {
    const selection = (await sql.query<{
      spec: unknown; root: unknown; attempt_id: string; operation_id: string; definition_version_id: string;
    }>(`select s.spec,s.attempt_id,s.operation_id,s.definition_version_id,b.record as root
      from job_computer_selections s join source_root_bindings b on b.workspace_id=s.workspace_id
        and b.record->>'attestationId'=s.spec #>> '{target,destination,attestationId}'
      where s.workspace_id=$1 and s.execution_id=$2`, [ticket.workspaceId, ticket.executionId])).rows[0]
    let selectedComputer: JobQueueTicket['selectedComputer'] = null
    if (selection) {
      if (selection.attempt_id !== ticket.attemptId || selection.operation_id !== ticket.operationId
        || selection.definition_version_id !== ticket.definition.versionId) {
        throw new DomainError('JOB_COMPUTER_SELECTION_CONFLICT', 'The reserved computer belongs to another request.', 409)
      }
      const spec = ResolvedJobDefinitionSpecRecordSchema.parse(selection.spec)
      const root = SourceRootRecordSchema.parse(selection.root)
      if (root.binding.workspaceId !== ticket.workspaceId
        || root.selection.rootPolicyId !== spec.target.destination.rootPolicyId
        || canonicalJson(root.selection.hostRef) !== canonicalJson(spec.target.hostRef)
        || canonicalJson(root.registration) !== canonicalJson(spec.target.registration)
        || root.binding.canonicalPath !== spec.target.destination.canonicalProjectRoot
        || root.source.snapshotId !== spec.source.snapshotId || root.source.manifestDigest !== spec.source.manifestDigest) {
        throw new DomainError('JOB_COMPUTER_SELECTION_CONFLICT', 'The reserved root differs from its selected computer.', 409)
      }
      selectedComputer = { target: spec.target, rootId: root.binding.rootId,
        bindingRevision: root.binding.bindingRevision, profileId: spec.policy.isolationPolicyId,
        profileRevision: spec.policy.isolationPolicyRevision }
    }
    const cleanup = (await sql.query<{ finished: boolean; occupied: boolean }>(`select
      ($3='terminal' or exists(select 1 from job_executions e where e.id=$2 and e.workspace_id=$1
        and e.record #>> '{process,phase}'='terminal')) as finished,
      (exists(select 1 from job_computer_selections s where s.execution_id=$2 and s.workspace_id=$1
          and s.released_at is null)
        or exists(select 1 from source_execution_materializations m where m.execution_id=$2
          and m.workspace_id=$1 and m.state<>'closed')
        or exists(select 1 from source_storage_reservations r where r.owner_kind='materialization'
          and r.owner_id=$4 and r.state in ('preparing','owned','uncertain'))
        or exists(select 1 from source_preparation_reconciliations c where c.operation_id=$4
          and c.workspace_id=$1 and c.status<>'closed')) as occupied`,
    [ticket.workspaceId, ticket.executionId, ticket.state, ticket.operationId])).rows[0]!
    let cleanupStatus: JobQueueTicket['cleanupStatus'] = 'none'
    if (cleanup.finished && ticket.reservationId) cleanupStatus = cleanup.occupied ? 'pending' : 'complete'
    const projected = { ...ticket, selectedComputer, cleanupStatus }
    if (!['waiting', 'blocked'].includes(ticket.state)) return { ...projected, queuePosition: null }
    const row = (await sql.query<{ position: string }>(`select count(*)::text as position
      from job_admission_queue where workspace_id=$1 and enqueue_sequence<=$2::bigint
      and record->>'state' in ('waiting','blocked')`, [ticket.workspaceId, ticket.enqueueSequence])).rows[0]!
    return JobQueueTicketSchema.parse({ ...projected, queuePosition: Number(row.position) })
  }
  async pendingQueue(sql: JobSql, workspaceId?: string): Promise<JobQueueTicket[]> {
    const rows = await sql.query<{ record: unknown }>(`select record from job_admission_queue
      where record->>'state' in ('waiting','blocked','claimed')
      ${workspaceId ? 'and workspace_id=$1' : ''} order by enqueue_sequence`,
    workspaceId ? [workspaceId] : [])
    return rows.rows.map(row => JobQueueTicketSchema.parse(row.record))
  }
  async finishQueueTicket(sql: JobSql, ticket: JobQueueTicket,
    reason: NonNullable<JobQueueTicket['terminalReason']>, now: string): Promise<JobQueueTicket> {
    const finished = { ...ticket }
    delete finished.sourceCapacityWait
    return this.putQueueTicket(sql, { ...finished, state: 'terminal', terminalReason: reason,
      finishedAt: now, waitingReasons: [], queuePosition: null, estimatedStartAt: null })
  }
  async finishCompletedQueueTickets(sql: JobSql): Promise<void> {
    await sql.query(`with completed as (
      select q.id,e.record->'finishedAt' as finished_at
      from job_admission_queue q join job_executions e on e.id=q.execution_id and e.workspace_id=q.workspace_id
      where q.record->>'state'='accepted' and e.record #>> '{process,phase}'='terminal'
        and e.record #> '{process,processStopped}'='true'::jsonb
        and e.record->>'publication' not in ('pending','collecting')
        and e.record->>'finishedAt' is not null
      order by q.enqueue_sequence limit 100 for update of q skip locked
    ) update job_admission_queue q set record=(q.record-'sourceCapacityWait') || jsonb_build_object(
      'state','terminal','terminalReason','completed','finishedAt',completed.finished_at,
      'waitingReasons','[]'::jsonb,'queuePosition',null,'estimatedStartAt',null,
      'revision',(q.record->>'revision')::bigint+1)
      from completed where q.id=completed.id`)
  }
  async definition(sql: JobSql, workspaceId: string, id: string, lock = false): Promise<JobDefinitionRecord> {
    const row = (await sql.query<{ record: unknown }>(`select record from job_definitions where workspace_id=$1 and id=$2${lock ? ' for update' : ''}`, [workspaceId,id])).rows[0]
    if (!row) throw new DomainError('JOB_DEFINITION_NOT_FOUND', 'The job definition was not found in this workspace.', 404)
    const definition = JobDefinitionRecordSchema.parse(row.record)
    if (definition.id !== id || definition.workspaceId !== workspaceId) throw new DomainError('JOB_SCOPE_CONFLICT','Job definition scope conflicts with persistence.',409)
    return definition
  }
  async version(sql:JobSql,workspaceId:string,versionId:string,definitionId:string):Promise<JobDefinitionRecord> {
    const row=(await sql.query<{record:unknown}>('select record from job_definition_versions where workspace_id=$1 and id=$2 and definition_id=$3 for share',[workspaceId,versionId,definitionId])).rows[0]
    if(!row)throw new DomainError('JOB_DEFINITION_VERSION_NOT_FOUND','The exact immutable job definition version is missing.',404)
    const value=JobDefinitionRecordSchema.parse(row.record)
    if(value.workspaceId!==workspaceId||value.id!==definitionId||value.versionId!==versionId)throw new DomainError('JOB_VERSION_PIN_CONFLICT','The persisted job version has conflicting scope.',409)
    return value
  }
  async execution(sql: JobSql, workspaceId: string, id: string, lock = false): Promise<JobExecutionRecord> {
    const row = (await sql.query<{ record: unknown; accepted_spec: unknown }>(`select record,accepted_spec from job_executions where workspace_id=$1 and id=$2${lock ? ' for update' : ''}`, [workspaceId,id])).rows[0]
    if (!row) throw new DomainError('JOB_NOT_FOUND', 'The execution was not found in this workspace.', 404)
    const execution = JobExecutionRecordSchema.parse(row.record)
    if (execution.id !== id || execution.workspaceId !== workspaceId || canonicalJson(execution.acceptedSpec) !== canonicalJson(row.accepted_spec)) throw new DomainError('JOB_SCOPE_CONFLICT','Job acceptance conflicts with persistence.',409)
    return execution
  }
  async workflowExecutions(sql: JobSql, workspaceId: string, workflowId: string,
    input: WorkflowJobListInput) {
    const limit = input.limit ?? 50
    const rows = await sql.query<{ record: unknown; name: string }>(`
      select e.record, v.record->>'name' as name
      from job_executions e
      join job_definition_versions v on v.id=e.definition_version_id and v.workspace_id=e.workspace_id
      where e.workspace_id=$1 and exists (
        select 1 from runs r where r.workspace_id=e.workspace_id and r.workflow_id=$2
          and ((r.id=e.record #>> '{workflow,runId}' and e.record #>> '{workflow,workflowId}'=$2)
            or (r.id=e.record #>> '{initiatingAgent,runId}'
              and e.record #>> '{initiatingAgent,workflowId}'=$2))
      ) and ($3::timestamptz is null
        or ((e.record->>'createdAt')::timestamptz, e.id)<($3::timestamptz, $4::text))
      order by (e.record->>'createdAt')::timestamptz desc, e.id desc limit $5`,
    [workspaceId, workflowId, input.cursor?.createdAt ?? null, input.cursor?.id ?? null, limit + 1])
    const items = rows.rows.slice(0, limit).map(row => ({
      name: row.name,
      execution: JobExecutionRecordSchema.parse(row.record),
    }))
    const last = items.at(-1)?.execution
    const nextCursor = rows.rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null
    return WorkflowJobPageSchema.parse({ workspaceId, workflowId, items, nextCursor })
  }
  async executionScope(sql: JobSql, workspaceId: string, executionId: string) {
    const row = (await sql.query<{ record: unknown }>(
      'select record from job_executions where workspace_id=$1 and id=$2', [workspaceId, executionId])).rows[0]
    if (!row) return {}
    const execution = JobExecutionRecordSchema.parse(row.record)
    if (execution.id !== executionId || execution.workspaceId !== workspaceId) {
      throw new DomainError('JOB_SCOPE_CONFLICT', 'The job scope conflicts with persistence.', 409)
    }
    for (const origin of [execution.workflow, execution.initiatingAgent]) {
      if (!origin) continue
      const run = await sql.query('select id from runs where workspace_id=$1 and workflow_id=$2 and id=$3',
        [workspaceId, origin.workflowId, origin.runId])
      if (run.rows.length) return { workflowId: origin.workflowId, runId: origin.runId }
    }
    return {}
  }
  async putExecution(sql: JobSql, value: JobExecutionRecord): Promise<void> {
    const execution = JobExecutionRecordSchema.parse(value)
    await sql.query('update job_executions set record=$3::jsonb where workspace_id=$1 and id=$2',[execution.workspaceId, execution.id, JSON.stringify(execution)])
  }
  async logs(sql: JobSql, executionId: string, after: number, limit: number) {
    const rows = await sql.query<{ sequence: string; attempt_id: string; stream: string; text: string; byte_size: number; created_at: Date }>(
      'select sequence::text,attempt_id,stream,text,byte_size,created_at from job_log_chunks where execution_id=$1 and sequence>$2 order by sequence limit $3', [executionId,after,limit])
    return rows.rows.map(row => JobLogChunkSchema.parse({executionId, attemptId: row.attempt_id, sequence:Number(row.sequence), stream:row.stream, text:row.text, byteSize:row.byte_size, createdAt:row.created_at.toISOString()}))
  }
}
export function sameLog(left: JobLogChunk, right: JobLogChunk): boolean { return canonicalJson(left) === canonicalJson(right) }
