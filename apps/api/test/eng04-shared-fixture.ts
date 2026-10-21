import { createHash } from 'node:crypto'
import {
  makeCurrentWorkflowFixture, WorkflowVersionV3Schema, WorkflowRunV3Schema, canonicalGraphJson,
} from '@foreman-code/contracts/wave25'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'

/** SQL-shaped tests only. No live DB, credentials or native session. */
export function sharedFixture() {
  const f = makeCurrentWorkflowFixture('eng04-shared-api')
  const entry = f.version.definition.nodes[0]!, exit = f.version.definition.nodes[1]!
  const version = WorkflowVersionV3Schema.parse({ ...f.version, id: `${f.version.id}-v3`, executionSemanticsVersion: 3,
    definition: { ...f.version.definition, executionSemanticsVersion: 3,
      nodes: [entry, { ...exit, choice: { outcomes: [
        { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
      ] } }], executionPolicy: { maxParallelism: 1, maxNodeExecutions: 6 },
      repeat: { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: [entry.id, exit.id], entryNodeId: entry.id,
        exitNodeId: exit.id, maxOccurrences: 3, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] },
    } })
  version.contentHash = `sha256:${createHash('sha256').update(canonicalGraphJson({ definition: version.definition,
    configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId })).digest('hex')}`
  const identity = { device: '1', inode: '2' }
  const location = { runnerId: 'runner-local', rootPath: '/synthetic/project', locationRevision: 4,
    identityHash: `sha256:${createHash('sha256').update('1:2').digest('hex')}` }
  const locationRow = { id: version.workspaceId, execution_location: { runnerId: location.runnerId, rootPath: location.rootPath },
    execution_location_identity: identity, location_revision: '4', archived_at: null }
  const run = WorkflowRunV3Schema.parse({ ...f.run, workflowVersionId: version.id, executionSemanticsVersion: 3,
    executionLocation: location, authorizationPrincipalId: 'synthetic-principal' })
  const versionRow = { id: version.id, workspace_id: version.workspaceId, workflow_id: version.workflowId,
    version: version.version, entry_node_id: version.entryNodeId, execution_semantics_version: 3, record: version }
  const configurations = f.configurations.map((record) => ({ id: record.id, workspace_id: record.workspaceId,
    agent_id: record.agentId, version: record.version, record, current_configuration_version_id: record.id }))
  const workflow = { id: version.workflowId, workspace_id: version.workspaceId, revision: '7',
    current_version_id: version.id, archived_at: null, record: version.definition }
  const request = { workspaceId: version.workspaceId, workflowId: version.workflowId, workflowVersionId: version.id,
    executionSemanticsVersion: 3 as const, commandId: 'eng04-shared-start-command', expectedWorkflowRevision: 7,
    expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds, expectedLocationRevision: 4, input: {} }
  const principal: ManagementPrincipal = { id: 'synthetic-principal', name: 'Synthetic', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [
      { actions: ['runs:start', 'workflows:read', 'agents:read'], scope: { workspaceIds: [run.workspaceId], workflowIds: [run.workflowId] } },
      { actions: ['workspace_locations:read'], scope: { workspaceIds: [run.workspaceId] } },
    ] }
  return { f, version, versionRow, configurations, workflow, run, location, locationRow, request, principal }
}
