import type pg from 'pg'
import { RunOutcomeSchema } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema,
  SavedRunVersionSnapshotSchema, ExecutableWorkflowV3Schema } from '@foreman-code/contracts/wave25'
import { CurrentJournalRunPinSchema as GraphEditRunPinSchema, CurrentJournalRunStateSchema as GraphEditRunStateSchema,
  type CurrentJournalRunState as GraphEditRunState } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { hasSaveNativeSettlement } from './saveNativeSettlement.js'
import { readImmutableWorkflowVersion, readImmutableAgentConfiguration,
  type ImmutableWorkflowVersionRow, type ImmutableAgentConfigurationRow } from '../workflows/immutableRead.js'
import { CANCELED_INTERACTION_RETIRED_SQL } from '../interactions/wave25/publication.js'
import { PUBLIC_PENDING_INTERACTION_SQL, PUBLIC_UNSETTLED_REVIEW_SQL } from '../run-graph/publicObligations.js'

export interface AffectedGraphScope { workspaceId: string; workflowId: string; stagedAgentIds: readonly string[] }
const affected = `r.workspace_id=$1
  and (r.workflow_id=$2 or r.record->'agentConfigurationVersionIds' ?| $3::text[]
    or exists (select 1 from workflow_versions affected_version where affected_version.id=r.workflow_version_id
      and affected_version.record->'agentConfigurationVersionIds' ?| $3::text[]))`
const invalidTerminal = `r.execution_state<>'completed'
  or r.record->>'executionState' is distinct from r.execution_state
  or r.record->>'outcome' is null or not (r.record->>'outcome'=any($4::text[]))
  or r.record->>'id' is distinct from r.id
  or r.record->>'workspaceId' is distinct from r.workspace_id
  or r.record->>'workflowId' is distinct from r.workflow_id
  or r.record->>'workflowVersionId' is distinct from r.workflow_version_id
  or r.record->'executionSemanticsVersion' is distinct from '3'::jsonb
  or not exists (select 1 from workflow_versions v where v.id=r.workflow_version_id
    and v.workspace_id=r.workspace_id and v.workflow_id=r.workflow_id
    and v.execution_semantics_version=3 and v.record->'executionSemanticsVersion'='3'::jsonb
    and v.record->>'id'=v.id and v.record->>'workspaceId'=r.workspace_id and v.record->>'workflowId'=r.workflow_id
    and v.record->'agentConfigurationVersionIds'=r.record->'agentConfigurationVersionIds')`
const cleanup = `exists (select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)`
// Native finalization and credential closure are durable lifecycle facts, not a
// guess from a terminal business outcome or a Stop acceptance receipt.
const native = `exists (select 1 from harness_executions e where e.run_id=r.id and (
    e.record->>'state' is distinct from 'completed'
    or e.record->'result'->>'outcome' is null or not (e.record->'result'->>'outcome'=any($4::text[]))
    or (e.record->>'nativeSessionId' is not null and not exists (
      select 1 from execution_native_sessions s where s.execution_id=e.id
        and s.reference->>'nativeSessionId'=e.record->>'nativeSessionId' and s.workflow_finalized_at is not null))
    or exists (select 1 from execution_native_sessions s where s.execution_id=e.id and s.workflow_finalized_at is null)
  )) or exists (select 1 from worker_credential_bindings b where b.run_id=r.id and b.revoked_at is null)`
const interactions = `exists (
  select 1 from durable_interactions i
  left join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id
  left join interaction_graph_resumes g on g.interaction_id=i.id
  where i.run_id=r.id and (e.id is null or (${PUBLIC_PENDING_INTERACTION_SQL})
    or (i.status='canceled' and not (${CANCELED_INTERACTION_RETIRED_SQL})))
)`
// A queued review may not have an execution ID yet. Its owning interaction,
// not an optional launched execution, determines the affected Run.
const reviews = `exists (select 1 from review_jobs j join durable_interactions review_owner on review_owner.id=j.interaction_id
  where review_owner.run_id=r.id and ((${PUBLIC_UNSETTLED_REVIEW_SQL})
    or j.record->'cleanup'->>'nativeState'='pending' or j.record->'cleanup'->>'credentialState'='pending'))`

// Keep the Run/configuration/resource fences here. Exact current-generation
// close, recovery, unbound-disposal and no-submission receipts are checked by
// the canonical readers below, not a second closed_at-only SQL definition.
// Neither a terminal outcome nor an absent session/process proves settlement.
const currentNative = `(
  exists (select 1 from harness_executions e where e.run_id=r.id and (
    e.record->>'id' is distinct from e.id or e.record->>'runId' is distinct from e.run_id
    or e.record->>'workflowNodeId' is distinct from e.workflow_node_id
    or e.record->>'agentId' is distinct from e.agent_id
    or e.record->>'attempt' is distinct from e.attempt::text
    or e.record->>'agentConfigurationVersionId' is distinct from r.record->'agentConfigurationVersionIds'->>e.agent_id
    or e.record->>'finishedAt' is null
    or not exists (select 1 from workflow_versions v,
      jsonb_array_elements(case when jsonb_typeof(v.record->'definition'->'nodes')='array'
        then v.record->'definition'->'nodes' else '[]'::jsonb end) n
      where v.id=r.workflow_version_id and n->>'id'=e.workflow_node_id and n->>'agentId'=e.agent_id)
    or (e.record->>'nativeSessionId' is not null and not exists (
      select 1 from execution_native_sessions s
      where s.execution_id=e.id and s.reference->>'nativeSessionId'=e.record->>'nativeSessionId'
        and e.record->>'workingDirectory'=coalesce((select placement.record#>>'{workingTree,canonicalCwd}'
          from execution_native_placements placement where placement.execution_id=e.id),
          (select w.record->>'workingDirectory' from run_worktrees w
            where w.run_id=r.id and w.allocation_id in (e.id,'')
            order by (w.allocation_id=e.id) desc limit 1),r.working_directory)
        and s.reference->>'harness'=(select cfg.record->'harness'->>'harness' from agent_configuration_versions cfg
          where cfg.id=e.record->>'agentConfigurationVersionId' and cfg.workspace_id=r.workspace_id and cfg.agent_id=e.agent_id)
        and jsonb_typeof(s.reference->'providerVersion')='string' and length(s.reference->>'providerVersion')>0
        and s.workflow_finalized_at is not null))
  ))
  or exists(select 1 from worker_credential_bindings b left join management_principals p on p.id=b.principal_id
    where b.run_id=r.id and (b.revoked_at is null or p.id is null or p.revoked_at is null))
)`
const currentTerminal = `(
  r.record->'result'->>'outcome' is distinct from r.record->>'outcome'
  or r.record->>'finishedAt' is null
  or r.record->'executionLocation'->>'runnerId' is distinct from r.runner_id
  or r.record->'executionLocation'->>'rootPath' is distinct from r.working_directory
  or r.record->'executionLocation'->>'locationRevision' is distinct from r.location_revision::text
)`
// Existing native writers bind g to the exact requester and graph continuation.
// Non-null acknowledgement from another Run/execution is never settlement.
const currentInteractions = `exists (
  select 1 from durable_interactions i
  left join harness_executions e on e.id=i.execution_id and e.run_id=i.run_id
  left join interaction_graph_resumes g on g.interaction_id=i.id
  where i.run_id=r.id and (
    i.record->>'id' is distinct from i.id or i.record->>'runId' is distinct from r.id
    or i.record->>'workspaceId' is distinct from r.workspace_id or i.record->>'workflowId' is distinct from r.workflow_id
    or i.record->>'executionId' is distinct from i.execution_id
    or i.record->>'status' is distinct from i.status or i.record->>'revision' is distinct from i.revision::text
    or i.record->>'requestingAgentId' is distinct from e.agent_id
    or i.record->>'nativeSessionId' is distinct from e.record->>'nativeSessionId'
    or i.record->'approval' is distinct from r.record->'approval'
    -- Owner work directions settle without native approval callbacks or graph-resume records.
    or (i.status='delivered' and i.record->>'kind' is distinct from 'work_direction' and (
      i.record->>'deliveryState' is distinct from 'delivered' or i.record->>'deliveredAt' is null
      or g.run_id is distinct from r.id or g.execution_id is distinct from i.execution_id
      or g.graph_thread_id is distinct from i.record->>'graphThreadId'
      or g.graph_interrupt_id is null or g.graph_interrupt_id is distinct from i.record->>'graphInterruptId'
      or g.state is distinct from 'resumed' or g.completed_at is null
      or g.approval_native_ack_source->>'sourceKind' is distinct from 'native_event'
      or g.approval_native_ack_source->>'sourceId' is null or g.approval_native_ack_source->>'sourceRevision' is null
      or not exists(select 1 from run_graph_effects f where f.run_id=r.id and f.effect_kind='graph.resume' and f.entity_id=i.id)
      or not exists(select 1 from run_graph_sources s where s.run_id=r.id and s.source_kind='native_event'
        and s.source_id=i.id and s.source_revision=i.revision)
      or not exists(select 1 from run_native_correlations c where c.run_id=r.id and c.execution_id=i.execution_id
        and c.work_kind='workflow' and c.work_id=i.execution_id and c.interaction_id=i.id
        and c.native_request_id=i.record->>'nativeRequestId' and c.native_session_id=i.record->>'nativeSessionId'
        and c.provider=i.record->>'harness')))

  ))`

const currentReviews = `exists (
  select 1 from review_jobs j join durable_interactions i on i.id=j.interaction_id
  where i.run_id=r.id and (j.record->>'id' is distinct from j.id
    or j.record->>'interactionId' is distinct from j.interaction_id or j.record->>'state' is distinct from j.state
    or (j.state='completed' and (j.approval_native_evidence->>'kind' is distinct from 'terminal'
      or j.approval_native_evidence->'terminal'->>'nativeSettled' is distinct from 'true'))
  ))`

const values = (input: AffectedGraphScope) => [input.workspaceId, input.workflowId,
  [...new Set(input.stagedAgentIds)].sort(), RunOutcomeSchema.options.filter((outcome) => outcome !== 'pending')]

interface AffectedRow {
  id: string; workspace_id: string; workflow_id: string; workflow_version_id: string; record: Record<string, unknown>
  terminal: boolean; cleanup: boolean; native: boolean; interactions: boolean; reviews: boolean
  version_row: ImmutableWorkflowVersionRow | null
  configurations: ImmutableAgentConfigurationRow[] | null
}

/** BOTH admission and the edit plan use the same read-only proof checks. Hold
 * existing affected parents in stable order until COMMIT: native entry/closure,
 * recovery and settlement writers lock the parent before changing evidence.
 * Save/stage/advance also hold workspace/workflow admission locks against new
 * Runs. Advisory edit readback is revalidated under those locks before any Stop
 * or publication; it never grants authority from a stale affected-Run set. */
async function readAffectedRows(client: Pick<pg.PoolClient, 'query'>, input: AffectedGraphScope): Promise<AffectedRow[]> {
  const affectedRuns = await client.query(
    `select r.id from runs r where ${affected} order by r.id for share of r`, values(input).slice(0, 3))
  if (affectedRuns.rowCount === 0) return []
  const rows = await client.query<AffectedRow>(`select r.id,r.workspace_id,r.workflow_id,r.workflow_version_id,r.record,
    not ((${invalidTerminal}) or (${currentTerminal})) as terminal, ${cleanup} as cleanup,
    ((${native}) or (${currentNative})) as native,
    ((${interactions}) or (${currentInteractions})) as interactions, ((${reviews}) or (${currentReviews})) as reviews,
    (
      select jsonb_build_object('id',v.id,'workspace_id',v.workspace_id,'workflow_id',v.workflow_id,
        'version',v.version,'entry_node_id',v.entry_node_id,'execution_semantics_version',v.execution_semantics_version,'record',v.record)
      from workflow_versions v where v.id=r.workflow_version_id
    ) as version_row,
    (
      select coalesce(jsonb_agg(jsonb_build_object('id',c.id,'workspace_id',c.workspace_id,'agent_id',c.agent_id,'version',c.version,'record',c.record) order by c.id),'[]'::jsonb)
      from agent_configuration_versions c where c.workspace_id=r.workspace_id and c.id in (
        select value from jsonb_each_text(case when jsonb_typeof(r.record->'agentConfigurationVersionIds')='object'
          then r.record->'agentConfigurationVersionIds' else '{}'::jsonb end))
    ) as configurations
    from runs r where ${affected} order by r.id`, values(input))
  for (const row of rows.rows) {
    if (row.native !== false || !validCurrentSnapshot(row)) continue
    const version = readImmutableWorkflowVersion(row.version_row!, { id: row.workflow_version_id,
      workspaceId: row.workspace_id, workflowId: row.workflow_id })
    row.native = !await hasSaveNativeSettlement(client, { workspaceId: row.workspace_id, workflowId: row.workflow_id,
      workflowVersionId: row.workflow_version_id, runId: row.id, executionSemanticsVersion: 3 }, version)
  }
  return rows.rows
}

function validCurrentSnapshot(row: AffectedRow): boolean {
  if (!row.record || typeof row.record !== 'object' || Array.isArray(row.record)) return false
  const semantics = row.record.executionSemanticsVersion
  if (semantics !== 3) return false // Missing, retired, string and unknown pins never acquire current authority.
  try {
    if (!row.version_row || !Array.isArray(row.configurations)) return false
    const run = AcceptedWorkflowRunV3Schema.parse(row.record)
    if (run.id !== row.id || run.workspaceId !== row.workspace_id || run.workflowId !== row.workflow_id
      || run.workflowVersionId !== row.workflow_version_id) return false
    const version = readImmutableWorkflowVersion(row.version_row, { id: row.workflow_version_id,
      workspaceId: row.workspace_id, workflowId: row.workflow_id })
    const configurations = row.configurations.map((configuration) => readImmutableAgentConfiguration(configuration,
      { workspaceId: row.workspace_id }))
    if (!SavedRunVersionSnapshotSchema.safeParse({ run, version }).success) return false
    const executable = ExecutableWorkflowV3Schema.safeParse({ version, configurations })
    // Historical settlement checks snapshot integrity, not newer admission rules:
    // an already-accepted Run must not block a corrective Save only because its
    // immutable topology fails the later cross-repeat reviewer restriction.
    return executable.success || executable.error.issues.every((issue) => issue.code === 'custom'
      && (issue as { params?: { publicCode?: string } }).params?.publicCode === 'REPEAT_REVIEW_SCOPE_UNSUPPORTED')
  } catch { return false } // Never disclose private input, result, configuration or Zod issues.
}
function settled(row: AffectedRow): boolean {
  // Missing/corrupt flags are never interpreted as settlement.
  return row.terminal === true && row.cleanup === false && row.native === false
    && row.interactions === false && row.reviews === false && validCurrentSnapshot(row)
}
function unsettled(): never {
  throw new DomainError('WORKFLOW_RUNS_UNSETTLED',
    'Meaningful edits cannot be published while an affected Run is active or has unresolved native, cleanup, interaction or review obligations. The draft is retained; Stop acceptance alone is not settlement.', 409)
}

/** Caller holds workspace admission + workflow locks until COMMIT. Admission
 * does not require runs:read and therefore never returns affected identities. */
export async function assertMeaningfulSaveAdmitted(client: Pick<pg.PoolClient, 'query'>, input: AffectedGraphScope): Promise<void> {
  const rows = await readAffectedRows(client, input)
  if (rows.some((row) => !settled(row))) return unsettled()
}

/** Caller must authorize EVERY returned exact scope before returning any plan.
 * Only pins/obligation flags leave this function, never the private evidence. */
export async function readAffectedGraphRuns(client: Pick<pg.PoolClient, 'query'>, input: AffectedGraphScope): Promise<GraphEditRunState[]> {
  const rows = await readAffectedRows(client, input)
  return rows.map((row) => {
    if (!validCurrentSnapshot(row)) return unsettled()
    const pin = GraphEditRunPinSchema.parse({ workspaceId: row.workspace_id, workflowId: row.workflow_id,
      runId: row.id, workflowVersionId: row.workflow_version_id,
      executionSemanticsVersion: row.record.executionSemanticsVersion,
      agentConfigurationVersionIds: row.record.agentConfigurationVersionIds })
    const terminal = row.terminal === true
    const cleanupPending = row.cleanup !== false, nativePending = row.native !== false
    const interactionPending = row.interactions !== false, reviewPending = row.reviews !== false
    return GraphEditRunStateSchema.parse({ pin, terminal, outcome: row.record.outcome,
      settled: settled(row), cleanupPending, nativePending, interactionPending, reviewPending })
  })
}
