import type { SqlQuery } from '../../infrastructure/transaction.js'
import { ActivitySnapshotV1Schema, type ActivitySnapshotV1, type ActivitySourceRevision,
  type InteractionSummary, type WorkRef, type WorkSummary, type CiActivity } from '@foreman-code/contracts'
import { REPEAT_GRAPH_LIMITS, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { RUN_ACTIVITIES_BOUNDS_SQL, RUN_ACTIVITIES_PAGE_SQL } from './activitiesSql.js'
import { readNativeActivityFacts, projectNativeActivityFacts } from './nativeActivitySnapshot.js'
import { AGENT_CI_SNAPSHOT_SQL, ciActivityFromRecord } from './agentCiSnapshot.js'
import { publicRunActivity, type ActivityReadRow } from './activityProjection.js'

type Queryable = SqlQuery
export interface RunActivityScope { workspaceId: string; workflowId: string; runId: string; workflowVersionId: string }
interface RunFact { revision: string; stopped: boolean; outcome: string; execution_state: string; started_at: string | null }
interface ExecutionFact { id: string; attempt: number; revision: string; state: string; outcome: string | null;
  continued_from_execution_id: string | null;
  started_at: string | null; created_at: string; native_session_id: string | null; harness: string | null; native_revision: string }
interface JobFact { id: string; attempt_id: string; operation_id: string; revision: string; node_id: string;
  definition_id: string; definition_revision: number; definition_version_id: string; pinned: boolean;
  phase: string; outcome: string | null; stopped: boolean; publication: string;
  started_at: string | null; finished_at: string | null; created_at: string }
interface CiFact { id: string; revision: string; execution_id: string; agent_id: string;
  node_id: string; pinned: boolean; ci: CiActivity }
interface InteractionFact { id: string; revision: string; execution_id: string; status: string; delivery: string | null;
  answer_recorded: boolean; harness: string; native_session_id: string; native_request_id: string; worker_acknowledged: boolean; acknowledgment_revision: string | null }

async function facts(sql: Queryable, scope: RunActivityScope) {
  // Both revision samples remain live; each sample shares one database snapshot.
  const result = (await sql.query<{
    run: RunFact | null; executions: ExecutionFact[]; jobs: JobFact[];
    cis: (Omit<CiFact, 'ci'> & { record: unknown })[]; interactions: InteractionFact[];
    bounds: { high_water: string; retained_from: string; observed: number }
  }>(`with run_fact as (
    select activity_record_revision::text as revision,stop_requested_at is not null as stopped,
      record->>'outcome' as outcome,record->>'startedAt' as started_at,execution_state from runs
      where id=$1 and workspace_id=$2 and workflow_id=$3 and workflow_version_id=$4
  ), execution_facts as (
    select e.id,e.attempt,e.activity_record_revision::text as revision,
    e.record#>>'{sessionContinuation,previousExecutionId}' as continued_from_execution_id,
    to_char(e.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
    e.record->>'state' as state,e.record#>>'{result,outcome}' as outcome,e.record->>'startedAt' as started_at,
    e.record->>'nativeSessionId' as native_session_id,c.record#>>'{harness,harness}' as harness,
    coalesce((select max(sequence) from harness_native_events n where n.execution_id=e.id),0)::text as native_revision
    from harness_executions e left join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId'
      and c.agent_id=e.agent_id and c.workspace_id=$2
    where e.run_id=$1 order by e.created_at,e.id limit 16001
  ), job_facts as (
    select j.id,j.attempt_id,j.operation_id,j.activity_record_revision::text as revision,
    j.record#>>'{workflow,nodeId}' as node_id,j.accepted_spec->>'definitionId' as definition_id,
    (j.accepted_spec->>'definitionRevision')::integer as definition_revision,j.accepted_spec->>'definitionVersionId' as definition_version_id,
    j.record#>>'{process,phase}' as phase,j.record#>>'{process,outcome}' as outcome,
    (j.record#>>'{process,processStopped}')::boolean as stopped,j.record->>'publication' as publication,
    j.record->>'startedAt' as started_at,j.record->>'finishedAt' as finished_at,
    to_char(j.created_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as created_at,
    coalesce(j.accepted_spec=j.record->'acceptedSpec' and j.workspace_id=$2 and j.id=w.node_execution_id
      and j.record->>'id'=j.id and j.record->>'workspaceId'=j.workspace_id
      and j.record->>'attemptId'=j.attempt_id and j.record->>'operationId'=j.operation_id
      and j.record#>>'{workflow,runId}'=$1 and j.record#>>'{workflow,workflowId}'=$3
      and j.record#>>'{workflow,nodeExecutionId}'=w.node_execution_id
      and w.reference->>'workspaceId'=$2 and w.reference->>'workflowVersionId'=$4
      and w.reference->>'runId'=$1 and w.reference->>'workflowId'=$3
      and w.reference->>'kind'='job' and w.reference->>'nodeId'=j.record#>>'{workflow,nodeId}'
      and w.reference->>'nodeExecutionId'=j.id and w.reference->>'jobExecutionId'=j.id
      and w.reference->>'occurrenceId' is not distinct from x.occurrence_id
      and x.executor_kind='job' and x.workflow_node_id=j.record#>>'{workflow,nodeId}'
      and x.technical_attempt=1 and x.identity->>'executionId'=j.id
      and x.identity->>'jobDefinitionId'=j.accepted_spec->>'definitionId'
      and x.identity->>'jobDefinitionVersionId'=j.accepted_spec->>'definitionVersionId'
      and j.definition_version_id=j.accepted_spec->>'definitionVersionId'
      and p.preparation->>'executionId'=j.id and p.preparation->>'attemptId'=j.attempt_id
      and p.preparation->>'operationId'=j.operation_id and p.preparation->>'workspaceId'=$2
      and p.preparation->>'workflowVersionId'=$4 and p.preparation->>'runId'=$1
      and p.preparation->>'workflowId'=$3 and p.preparation->>'nodeId'=j.record#>>'{workflow,nodeId}'
      and p.preparation->'input'=j.accepted_spec->'workflowInput'
      and s.input_json::jsonb=p.preparation->'input' and w.input_json::jsonb=p.preparation->'input',false) as pinned
    from workflow_job_executions w join job_executions j on j.id=w.job_execution_id
    left join run_repeat_executions x on x.run_id=w.run_id and x.execution_id=w.node_execution_id
    left join run_repeat_slots s on s.slot_id=x.slot_id and s.run_id=w.run_id
    left join workflow_job_preparations p on p.slot_id=s.slot_id and p.run_id=w.run_id
    where w.run_id=$1
    order by created_at,id limit 16001
  ), ci_facts as (
    ${AGENT_CI_SNAPSHOT_SQL}
  ), interaction_facts as (
    select i.id,i.revision::text,i.execution_id,i.status,
    i.record->>'deliveryState' as delivery,(i.record->>'decidedAt') is not null as answer_recorded,
    i.harness,i.native_session_id,i.native_request_id,
    exists(select 1 from interaction_graph_resumes g where g.interaction_id=i.id and g.run_id=i.run_id
      and g.execution_id=i.execution_id and g.approval_native_ack_id is not null) as worker_acknowledged,
    (select g.revision::text from interaction_graph_resumes g where g.interaction_id=i.id and g.run_id=i.run_id and g.execution_id=i.execution_id) as acknowledgment_revision
    from durable_interactions i where i.run_id=$1 and i.workspace_id=$2 and i.workflow_id=$3 order by i.id limit 2001
  ), activity_bounds as (
    ${RUN_ACTIVITIES_BOUNDS_SQL}
  ) select (select row_to_json(r) from run_fact r) as run,
    coalesce((select json_agg(e) from execution_facts e),'[]'::json) as executions,
    coalesce((select json_agg(j) from job_facts j),'[]'::json) as jobs,
    coalesce((select json_agg(c) from ci_facts c),'[]'::json) as cis,
    coalesce((select json_agg(i) from interaction_facts i),'[]'::json) as interactions,
    (select row_to_json(b) from activity_bounds b) as bounds`,
  [scope.runId, scope.workspaceId, scope.workflowId, scope.workflowVersionId])).rows[0]!
  const { run, executions, jobs, interactions, bounds } = result
  if (!run) throw new DomainError('RUN_PIN_CONFLICT', 'The exact Run activity scope is unavailable.', 409)
  const cis = result.cis.map(({ record, ...row }) => ({ ...row, ci: ciActivityFromRecord(record) }))
  if (executions.length + jobs.length + cis.length > REPEAT_GRAPH_LIMITS.executions || interactions.length > REPEAT_GRAPH_LIMITS.decisions) {
    throw new DomainError('ACTIVITY_SNAPSHOT_TOO_LARGE', 'Use the bounded canonical graph for this Run.', 409)
  }
  const revisions: ActivitySourceRevision[] = [{ source: 'scope', id: scope.runId, revision: run.revision },
    { source: 'run_activity', id: scope.runId, revision: bounds.high_water },
    ...executions.flatMap((execution) => [{ source: 'execution' as const, id: execution.id, revision: execution.revision },
      { source: 'native_events' as const, id: execution.id, revision: execution.native_revision }]),
    ...jobs.map((job) => ({ source: 'execution' as const, id: job.id, revision: job.revision })),
    ...cis.map((ci) => ({ source: 'ci_run' as const, id: ci.id, revision: ci.revision })),
    ...interactions.flatMap((interaction) => [{ source: 'interaction' as const, id: interaction.id, revision: interaction.revision },
      ...(interaction.acknowledgment_revision !== null ? [{ source: 'interaction' as const, id: `ack:${interaction.id}`, revision: interaction.acknowledgment_revision }] : [])])]
  return { run, executions, jobs, cis, interactions, bounds, revisions }
}

/** Read on the existing authorized Run transaction. A validated revision vector protects READ COMMITTED callers. */
export async function readRunActivitySnapshot(sql: Queryable, scope: RunActivityScope, version: WorkflowVersionV3): Promise<ActivitySnapshotV1> {
  if (version.id !== scope.workflowVersionId || version.workspaceId !== scope.workspaceId || version.workflowId !== scope.workflowId) {
    throw new DomainError('RUN_PIN_CONFLICT', 'The activity version does not match its immutable Run scope.', 409)
  }
  const before = await facts(sql, scope)
  for (const job of before.jobs) {
    const node = version.definition.nodes.find((node) => node.id === job.node_id)
    const graphJob = node?.kind === 'job' && node.jobDefinitionId === job.definition_id
      && node.jobDefinitionRevision === job.definition_revision && node.jobDefinitionVersionId === job.definition_version_id
    if (!job.pinned || !graphJob || !['queued', 'preparing', 'running', 'terminal'].includes(job.phase)) {
      throw new DomainError('ACTIVITY_OWNER_CONFLICT', 'Job activity lost its exact accepted Run identity.', 409)
    }
  }
  const ref = (execution: ExecutionFact): WorkRef => ({ kind: 'execution', ...scope, executionId: execution.id, attemptKey: String(execution.attempt) })
  const ciRef = (ci: CiFact): WorkRef => {
    const execution = before.executions.find(entry => entry.id === ci.execution_id)
    const node = version.definition.nodes.find(entry => entry.id === ci.node_id)
    if (!ci.pinned || !execution || !node || node.kind === 'job' || node.agentId !== ci.agent_id) {
      throw new DomainError('ACTIVITY_OWNER_CONFLICT', 'CI activity lost its originating Agent execution.', 409)
    }
    return { kind: 'ci', ...scope, executionId: execution.id, attemptKey: String(execution.attempt),
      nodeId: ci.node_id, agentId: ci.agent_id, ticketId: ci.id }
  }
  const ciSummaries: WorkSummary[] = before.cis.map(ci => {
    let phase: WorkSummary['phase'] = 'terminal'
    if (ci.ci.state === 'queued') phase = 'waiting'
    else if (ci.ci.state === 'starting') phase = 'preparing'
    else if (ci.ci.state === 'running') phase = 'active'
    const outcomes: Record<CiActivity['state'], WorkSummary['outcome']> = {
      queued: null, starting: null, running: null, passed: 'succeeded', failed: 'failed',
      canceled: 'canceled', lost: 'unknown',
    }
    const outcome = outcomes[ci.ci.state]
    return { ref: ciRef(ci), phase, outcome, evidence: ci.ci.state === 'lost' ? 'unknown' : 'confirmed',
      delivery: null, startedAt: ci.ci.startedAt, ci: ci.ci }
  })
  if (before.executions.some((execution) => !['queued', 'starting', 'running', 'waiting', 'completed'].includes(execution.state))) {
    throw new DomainError('ACTIVITY_OWNER_CONFLICT', 'An execution has no authoritative lifecycle state.', 409)
  }
  const summaries: WorkSummary[] = before.executions.map((execution) => ({ ref: ref(execution),
    phase: execution.state === 'completed' ? 'terminal' : before.run.stopped ? 'interrupting'
      : execution.state === 'starting' ? 'preparing' : execution.state === 'waiting' ? 'waiting' : 'active',
    outcome: execution.state === 'completed' && ['succeeded', 'failed', 'canceled'].includes(execution.outcome ?? '')
      ? execution.outcome as WorkSummary['outcome'] : execution.state === 'completed' ? 'unknown' : null,
    evidence: execution.state === 'completed' && !execution.outcome ? 'unknown' : 'confirmed', delivery: null,
    startedAt: execution.started_at,
    ...(execution.continued_from_execution_id ? { continuedFromExecutionId: execution.continued_from_execution_id } : {}),
    ...(execution.native_session_id && execution.harness ? { native: { harness: execution.harness, sessionId: execution.native_session_id } } : {}) }))
  const jobRef = (job: JobFact): WorkRef => ({ kind: 'execution', ...scope, executionId: job.id, attemptKey: job.attempt_id })
  const jobSummaries: WorkSummary[] = before.jobs.map((job) => ({ ref: jobRef(job),
    phase: job.phase === 'terminal' && job.stopped ? ['pending', 'collecting'].includes(job.publication) ? 'finalizing' : 'terminal'
      : before.run.stopped ? 'interrupting' : job.phase === 'preparing' || job.phase === 'queued' ? 'preparing' : 'active',
    outcome: job.phase !== 'terminal' || !job.stopped ? null : job.outcome === 'succeeded' ? 'succeeded'
      : job.outcome === 'cancelled' ? 'canceled' : job.outcome ? 'failed' : 'unknown',
    evidence: job.phase === 'terminal' && !job.stopped ? 'unknown' : 'confirmed', delivery: null, startedAt: job.started_at }))
  const pendingInteractions: InteractionSummary[] = before.interactions.filter((interaction) => !['delivered', 'canceled'].includes(interaction.status)).flatMap((interaction) => {
    const execution = before.executions.find((entry) => entry.id === interaction.execution_id)
    if (!execution) throw new DomainError('ACTIVITY_OWNER_CONFLICT', 'Interaction lost its exact persisted execution owner.', 409)
    return [{ id: interaction.id, revision: interaction.revision, owner: ref(execution),
      native: { harness: interaction.harness, sessionId: interaction.native_session_id, requestId: interaction.native_request_id },
      delivery: interaction.status === 'pending' ? 'pending' : interaction.delivery === 'uncertain' ? 'uncertain'
        : interaction.status === 'decided' ? 'answer_recorded' : interaction.status === 'delivery_failed' ? 'failed' : 'delivery_pending',
      answerRecorded: interaction.answer_recorded, providerAcknowledged: interaction.delivery === 'delivered',
      workerAcknowledged: interaction.worker_acknowledged, responseAvailability: 'unknown' }]
  })
  const rows = (await sql.query<ActivityReadRow>(RUN_ACTIVITIES_PAGE_SQL.replace('__COMPARATOR__', '<=').replace('__ORDER__', 'desc'),
  [scope.runId, before.bounds.high_water, before.bounds.high_water, before.bounds.retained_from, 101])).rows
  const selected = rows.slice(0, 100).reverse()
  const activities = selected.flatMap((row) => {
    const publicItem = publicRunActivity(row, version, scope.runId, before.run.outcome)
    const execution = before.executions.find((entry) => entry.id === row.harness_execution_id)
    // Run-level audit rows retain their genuine Run owner; never borrow the latest execution.
    const job = before.jobs.find((entry) => entry.id === row.job_execution_id)
    const ci = before.cis.find(entry => entry.id === publicItem.refs.ciTicketId
      && entry.execution_id === row.harness_execution_id)
    let owner: WorkRef = { kind: 'run', ...scope }
    if (ci) owner = ciRef(ci)
    else if (execution) owner = ref(execution)
    else if (job) owner = jobRef(job)
    return [{ kind: 'diagnostic' as const, id: publicItem.id, revision: '0', order: row.sequence, orderSource: 'run_activity', owner,
      source: { schemaVersion: 1, system: 'run_activity', eventId: publicItem.id, sequence: row.sequence, observedAt: row.occurred_at.toISOString() },
      evidence: publicItem.status === 'unknown' ? 'unknown' : 'confirmed', code: publicItem.kind,
      message: row.kind === 'harness_output' && publicItem.detail
        ? `${publicItem.summary}: ${publicItem.detail}` : publicItem.summary,
      ...(publicItem.ci ? { ci: publicItem.ci } : {}),
      ...(ci && execution ? { parent: ref(execution) } : {}) }]
  })
  const nativeWork = projectNativeActivityFacts(await readNativeActivityFacts(sql, scope.runId), (executionId) => {
    const execution = before.executions.find((entry) => entry.id === executionId)
    if (!execution) throw new DomainError('ACTIVITY_OWNER_CONFLICT', 'Native item lost its exact execution scope.', 409)
    return { owner: ref(execution), harness: execution.harness, sessionId: execution.native_session_id, terminal: execution.state === 'completed' }
  })
  const after = await facts(sql, scope)
  if (JSON.stringify(before.revisions) !== JSON.stringify(after.revisions)) throw new DomainError('ACTIVITY_SNAPSHOT_CONFLICT',
    'Activity source revisions changed during read. Refresh this exact Run.', 409)
  const activeExecutions = summaries.filter((summary, index) => before.executions[index]!.state !== 'queued' && summary.phase !== 'terminal')
  const activeJobs = jobSummaries.filter((summary, index) => before.jobs[index]!.phase !== 'queued' && summary.phase !== 'terminal')
  const activeCi = ciSummaries.filter(summary => summary.phase !== 'terminal')
  const runRef: WorkRef = { kind: 'run', ...scope }
  const lastExecution = before.executions.at(-1), lastJob = before.jobs.at(-1)
  let latest = lastJob && (!lastExecution || lastJob.created_at > lastExecution.created_at
    || lastJob.created_at === lastExecution.created_at && lastJob.id > lastExecution.id) ? jobRef(lastJob)
    : lastExecution ? ref(lastExecution) : runRef
  const lastCi = before.cis.at(-1)
  if (lastCi && (!lastExecution || lastCi.ci.queuedAt >= lastExecution.created_at)
    && (!lastJob || lastCi.ci.queuedAt >= lastJob.created_at)) latest = ciRef(lastCi)
  const runWork: WorkSummary[] = activeExecutions.length === 0 && activeJobs.length === 0 && activeCi.length === 0 && ['running', 'waiting', 'interrupted'].includes(before.run.execution_state)
    ? [{ ref: runRef, phase: before.run.stopped ? 'interrupting' : before.run.execution_state === 'waiting' ? 'waiting' : 'preparing',
      outcome: null, delivery: null, evidence: before.run.execution_state === 'interrupted' ? 'reconciling' : 'confirmed', startedAt: before.run.started_at ?? null }] : []
  return ActivitySnapshotV1Schema.parse({ schemaVersion: 1, scope: { kind: 'workflow_run', ...scope }, revision: before.run.revision,
    sourceRevisions: before.revisions,
    active: [...activeExecutions, ...activeJobs, ...activeCi, ...runWork, ...nativeWork.active],
    ...(nativeWork.hasMore ? { hasMoreActiveWork: true } : {}),
    queued: before.executions.length === 0 && before.jobs.length === 0 && before.cis.length === 0 && before.run.execution_state === 'queued' ? [runRef]
      : [...before.executions.filter((execution) => execution.state === 'queued').map(ref),
        ...before.jobs.filter((job) => job.phase === 'queued').map(jobRef),
        ...before.cis.filter(ci => ci.ci.state === 'queued').map(ciRef)],
    latest,
    pendingInteractions, activities: [...activities, ...nativeWork.activities],
    // This scoped cursor is an audit sequence, never a cross-scope/browser cursor.
    page: { before: null, nextCursor: rows.length > 100 ? selected[0]!.sequence : null, hasMore: rows.length > 100 } })
}
