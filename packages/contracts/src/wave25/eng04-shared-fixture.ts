import { makeCurrentWorkflowFixture } from './currentFixture.js'
import { WorkflowVersionV3Schema, WorkflowRunV3Schema } from './saved.js'
import { RepeatStartSnapshotV1Schema } from './repeatAdmission.js'

/** Synthetic contract fixture. No provider, SQL, credential or readiness claim. */
export function makeSharedV3Fixture(suffix = 'eng04-shared') {
  const f = makeCurrentWorkflowFixture(suffix, 'repeat')
  const version = WorkflowVersionV3Schema.parse({ ...f.version, id: `${f.version.id}-v3` })
  const location = { runnerId: 'runner-local', rootPath: '/synthetic/project ', locationRevision: 4, identityHash: `sha256:${'a'.repeat(64)}` }
  const run = WorkflowRunV3Schema.parse({ ...f.run, workflowVersionId: version.id, executionSemanticsVersion: 3,
    executionLocation: location, authorizationPrincipalId: 'synthetic-principal' })
  const request = { workspaceId: version.workspaceId, workflowId: version.workflowId, workflowVersionId: version.id,
    executionSemanticsVersion: 3 as const, commandId: 'eng04-shared-start-command', expectedWorkflowRevision: 7,
    expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds, expectedLocationRevision: 4, input: {} }
  const snapshot = RepeatStartSnapshotV1Schema.parse({ request, authorizationPrincipalId: 'synthetic-principal', executable: { version, configurations: f.configurations },
    workflow: { id: version.workflowId, workspaceId: version.workspaceId, revision: 7, currentVersionId: version.id,
      archived: false, definition: version.definition }, workspace: { id: version.workspaceId, archived: false, location }, draft: null })
  const scope = { ...f.scope, workflowVersionId: version.id, executionSemanticsVersion: 3 as const }
  return { ...f, version, run, request, snapshot, scope, location }
}
