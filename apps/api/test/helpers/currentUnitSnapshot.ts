import { createHash } from 'node:crypto'
import {
  AcceptedWorkflowRunV3Schema, ExecutableWorkflowV3Schema, WorkflowVersionV3Schema,
  canonicalGraphJson, makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import type {
  ImmutableAgentConfigurationRow, ImmutableWorkflowVersionRow,
} from '../../src/modules/workflows/immutableRead.js'

/** Schema-valid, hash-pinned DATA for scripted unit repositories. This does not
 * persist a Run, grant authority, issue a native permit or fabricate a receipt.
 * The caller must explicitly model every SQL/receipt boundary under test. */
export function currentUnitSnapshot(suffix: string, form: Parameters<typeof makeCurrentWorkflowFixture>[1] = 'single') {
  const f = makeCurrentWorkflowFixture(suffix, form)
  const contentHash = 'sha256:' + createHash('sha256').update(canonicalGraphJson({
    definition: f.version.definition, configurations: f.version.agentConfigurationVersionIds,
    entryNodeId: f.version.entryNodeId,
  })).digest('hex')
  const version = WorkflowVersionV3Schema.parse({ ...f.version, contentHash })
  ExecutableWorkflowV3Schema.parse({ version, configurations: f.configurations })
  const run = AcceptedWorkflowRunV3Schema.parse({ ...f.run,
    authorizationPrincipalId: `principal-${suffix}`,
    executionLocation: { runnerId: `runner-${suffix}`, rootPath: `/synthetic/${suffix}`,
      locationRevision: 1, identityHash: `sha256:${'a'.repeat(64)}` },
  })
  return { ...f, version, run }
}
export type CurrentUnitSnapshot = ReturnType<typeof currentUnitSnapshot>

export function currentUnitRunRow(f: CurrentUnitSnapshot, flags: { stopped?: boolean; cleanupPending?: boolean } = {}) {
  const { run } = f
  return { id: run.id, workspace_id: run.workspaceId, workflow_id: run.workflowId,
    workflow_version_id: run.workflowVersionId, execution_state: run.executionState,
    runner_id: run.executionLocation.runnerId, working_directory: run.executionLocation.rootPath,
    location_revision: String(run.executionLocation.locationRevision), record: structuredClone(run),
    stopped: flags.stopped ?? false, cleanup_pending: flags.cleanupPending ?? false }
}
export function currentUnitVersionRow(f: CurrentUnitSnapshot): ImmutableWorkflowVersionRow {
  const { version } = f
  return { id: version.id, workspace_id: version.workspaceId, workflow_id: version.workflowId,
    version: version.version, entry_node_id: version.entryNodeId, execution_semantics_version: 3,
    record: structuredClone(version) }
}
export function currentUnitConfigurationRows(f: CurrentUnitSnapshot): ImmutableAgentConfigurationRow[] {
  return f.configurations.map((configuration) => ({ id: configuration.id, workspace_id: configuration.workspaceId,
    agent_id: configuration.agentId, version: configuration.version, record: structuredClone(configuration) }))
}
