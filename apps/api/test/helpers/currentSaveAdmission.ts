import { createHash } from 'node:crypto'
import { AcceptedWorkflowRunV3Schema, canonicalGraphJson, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

/** Synthetic rows for query-boundary tests only. The production reader still
 * validates exact physical columns, V3 snapshots and the immutable hash. These
 * values are not a native settlement, typed publication or Start receipt. */
export function currentSaveAdmissionFixture(suffix: string) {
  const f = makeCurrentWorkflowFixture(suffix, 'single')
  f.version.contentHash = `sha256:${createHash('sha256').update(canonicalGraphJson({
    definition: f.version.definition, configurations: f.version.agentConfigurationVersionIds, entryNodeId: f.version.entryNodeId,
  })).digest('hex')}`
  const record = AcceptedWorkflowRunV3Schema.parse({ ...f.run, executionState: 'completed', outcome: 'succeeded',
    result: { outcome: 'succeeded', output: {} }, finishedAt: f.createdAt, authorizationPrincipalId: 'save-authority',
    executionLocation: { runnerId: 'runner-local', rootPath: '/fixture', locationRevision: 1, identityHash: `sha256:${'1'.repeat(64)}` } })
  const row = { id: record.id, workspace_id: record.workspaceId, workflow_id: record.workflowId,
    workflow_version_id: record.workflowVersionId, record,
    version_row: { id: f.version.id, workspace_id: f.version.workspaceId, workflow_id: f.version.workflowId,
      version: f.version.version, entry_node_id: f.version.entryNodeId, execution_semantics_version: 3, record: f.version },
    configurations: f.configurations.map((configuration) => ({ id: configuration.id, workspace_id: configuration.workspaceId,
      agent_id: configuration.agentId, version: configuration.version, record: configuration })),
    terminal: true, cleanup: false, native: false, interactions: false, reviews: false }
  const pin = { ...f.scope, agentConfigurationVersionIds: f.version.agentConfigurationVersionIds }
  return { f, row, record, pin }
}
