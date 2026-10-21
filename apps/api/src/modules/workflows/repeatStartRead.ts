import { createHash } from 'node:crypto'
import { WorkspaceLocationIdentitySchema } from '@foreman-code/contracts/workspace-root-policies'
import { ExecutionLocationSchema, type RunExecutionLocation } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  RepeatStartSnapshotV1Schema, RunStartV3InputSchema, RunExecutionLocationV3Schema,
  GraphDraftV3Schema, WorkflowDefinitionV3Schema, sameWorkflowValue,
  type RepeatStartSnapshotV1,
} from '@foreman-code/contracts/wave25'
import type { TransactionSql } from '../../infrastructure/transaction.js'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'
import { waitForRunStartLock } from '../runs/startLocks.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import {
  readImmutableWorkflowVersion, readImmutableAgentConfiguration, IMMUTABLE_WORKFLOW_VERSION_COLUMNS,
  type ImmutableWorkflowVersionRow, type ImmutableAgentConfigurationRow,
} from './immutableRead.js'

interface LocationRow {
  id: string; execution_location: unknown; execution_location_identity: unknown
  location_revision: string; archived_at: Date | null
}
/** Prepared from the configured workspace location outside the graph transaction.
 * Placed Agent directories are validated by their complete placement admission.
 * Internal-only: these are not request fields or a client supplied capability. */
export interface PreparedRepeatStartLocation {
  location: RunExecutionLocation
  row: LocationRow
}

/** Read-only validation inside the existing Start publication transaction.
 * Caller must already hold the command + runner admission locks, must process
 * exact receipts before this helper, and must retain every lock through COMMIT.
 * This neither INSERTs a Run nor supplies engine/publication/native readiness.
 * Use the existing authority/receipt/audit/native/capacity fences afterwards. */
export async function readLockedRepeatStartSnapshot(
  client: TransactionSql, principal: ManagementPrincipal, raw: unknown,
  prepared: PreparedRepeatStartLocation,
): Promise<RepeatStartSnapshotV1> {
  const input = RunStartV3InputSchema.parse(raw)
  const caller = await readLiveManagementPrincipal(client, principal.id)
  requireAuthorization(caller, 'runs:start', { workspaceId: input.workspaceId, workflowId: input.workflowId })
  requireAuthorization(caller, 'workspace_locations:read', { workspaceId: input.workspaceId })
  await waitForRunStartLock(client, `admission:workspace:${input.workspaceId}`)
  const workspaceRows = await client.query<LocationRow>(`select id,execution_location,execution_location_identity,
    location_revision::text,archived_at from workspaces where id=$1 for update`, [input.workspaceId])
  const workspace = workspaceRows.rows[0]
  const location = RunExecutionLocationV3Schema.parse(prepared.location)
  if (!workspace || workspace.id !== input.workspaceId || workspace.archived_at !== null
    || !sameWorkflowValue(workspace, prepared.row)) {
    throw new DomainError('LOCATION_REVISION_CONFLICT', 'The prepared workspace location changed before Start.', 409)
  }
  const stored = ExecutionLocationSchema.safeParse(workspace.execution_location)
  const identity = WorkspaceLocationIdentitySchema.safeParse(workspace.execution_location_identity)
  if (!stored.success || !identity.success || stored.data.runnerId !== location.runnerId
    || stored.data.rootPath !== location.rootPath || String(location.locationRevision) !== workspace.location_revision
    || location.locationRevision !== input.expectedLocationRevision
    || location.identityHash !== `sha256:${createHash('sha256').update(`${identity.data.device}:${identity.data.inode}`).digest('hex')}`) {
    throw new DomainError('LOCATION_REVISION_CONFLICT', 'The prepared location does not match its exact stored identity.', 409)
  }
  const workflows = await client.query<{
    id: string; workspace_id: string; revision: string; current_version_id: string | null; archived_at: Date | null; record: unknown
  }>(`select id,workspace_id,revision::text,current_version_id,archived_at,record
    from workflows where id=$1 and workspace_id=$2 for update`, [input.workflowId, input.workspaceId])
  const workflow = workflows.rows[0]
  if (!workflow || workflow.id !== input.workflowId || workflow.workspace_id !== input.workspaceId
    || workflow.archived_at !== null || workflow.current_version_id !== input.workflowVersionId
    || workflow.revision !== String(input.expectedWorkflowRevision)) {
    throw new DomainError('WORKFLOW_BASE_CONFLICT', 'The active saved workflow identity or revision changed before Start.', 409)
  }
  const versions = await client.query<ImmutableWorkflowVersionRow>(
    `select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS} from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3 for share`,
    [input.workflowVersionId, input.workspaceId, input.workflowId])
  if (!versions.rows[0]) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', 'The immutable workflow version was not found.', 404)
  const version = readImmutableWorkflowVersion(versions.rows[0], { id: input.workflowVersionId,
    workspaceId: input.workspaceId, workflowId: input.workflowId })
  if (!('executionSemanticsVersion' in version) || version.executionSemanticsVersion !== 3) {
    throw new DomainError('EXECUTION_SEMANTICS_UNSUPPORTED', 'This Start contract requires an exact saved semantics-3 version.', 409)
  }
  const rows = await client.query<ImmutableAgentConfigurationRow & { current_configuration_version_id: string }>(
    `select v.id,v.workspace_id,v.agent_id,v.version,v.record,a.current_configuration_version_id from agents a
     join agent_configuration_versions v on v.id=a.current_configuration_version_id
       and v.workspace_id=a.workspace_id and v.agent_id=a.id
     where a.workspace_id=$1 and a.archived_at is null and a.id=any($2::text[]) order by a.id for share of a,v`,
    [input.workspaceId, Object.keys(version.agentConfigurationVersionIds)])
  if (rows.rows.length !== Object.keys(version.agentConfigurationVersionIds).length
    || rows.rows.some((row) => row.id !== version.agentConfigurationVersionIds[row.agent_id]
      || row.current_configuration_version_id !== row.id)) {
    throw new DomainError('WORKFLOW_CONFIGURATION_STALE', 'Save the workflow again after Agent settings change.', 409)
  }
  const configurations = rows.rows.map((row) => readImmutableAgentConfiguration(row, {
    workspaceId: input.workspaceId, id: version.agentConfigurationVersionIds[row.agent_id]!, agentId: row.agent_id,
  }))
  let draft: RepeatStartSnapshotV1['draft'] = null
  if (input.draftId !== undefined) {
    const drafts = await client.query<{ id: string; workspace_id: string; workflow_id: string; revision: string; base_workflow_version_id: string | null; record: unknown }>(
      `select id,workspace_id,workflow_id,revision::text,base_workflow_version_id,record from graph_drafts
       where id=$1 and workspace_id=$2 and workflow_id=$3 and discarded_at is null for share`,
      [input.draftId, input.workspaceId, input.workflowId])
    const row = drafts.rows[0]
    if (!row || row.id !== input.draftId || row.workspace_id !== input.workspaceId || row.workflow_id !== input.workflowId) {
      throw new DomainError('DISPLAYED_GRAPH_NOT_PUBLISHED', 'The displayed draft is no longer available at its exact scope.', 409)
    }
    draft = GraphDraftV3Schema.parse(row.record)
    if (row.revision !== String(draft.revision) || row.base_workflow_version_id !== draft.baseWorkflowVersionId) {
      throw new DomainError('DISPLAYED_GRAPH_NOT_PUBLISHED', 'The displayed draft does not match its stored revision/version.', 409)
    }
  }
  const snapshot = RepeatStartSnapshotV1Schema.parse({ request: input, authorizationPrincipalId: caller.id, executable: { version, configurations },
    workflow: { id: workflow.id, workspaceId: workflow.workspace_id, revision: Number(workflow.revision),
      currentVersionId: workflow.current_version_id, archived: false, definition: WorkflowDefinitionV3Schema.parse(workflow.record) },
    workspace: { id: workspace.id, archived: false, location }, draft })
  for (const configuration of configurations) assertNativeWorkflowConfiguration(configuration.harness, version.approval,
    version.approval.handler === 'orchestrator' && configuration.agentId === version.approval.designatedOrchestratorAgentId)
  return snapshot // Backend-only; do not return prompts, skills or paths as a public preflight response.
}
