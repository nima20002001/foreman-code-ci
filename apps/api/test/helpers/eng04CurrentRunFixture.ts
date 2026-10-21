import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { AcceptedRepeatStartV1Schema, AcceptedWorkflowRunV3Schema,
  type CurrentWorkflowSavedSchema, type RepeatGraphScopeV3, type makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { z } from 'zod'
import { withExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { repeatStartPublication } from '../../src/modules/run-graph/repeatStartPublication.js'
import { insertRepeatRun } from '../../src/modules/runs/repeatStartAdmission.js'

/** A canonical SQL-publication fixture AFTER authenticated typed Save, not a
 * public Start result/command receipt or native capability. Neither inputs nor
 * ordinary Run records acquire repeat data. No graph head is synthesized. */
export async function insertCurrentRunFixture(pool: pg.Pool, fixture: ReturnType<typeof makeCurrentWorkflowFixture>,
  saved: z.infer<typeof CurrentWorkflowSavedSchema>, authorizationPrincipalId: string,
  options: { insert?: boolean; input?: unknown } = {}) {
  const version = saved.version
  const run = AcceptedWorkflowRunV3Schema.parse({ ...fixture.run, workflowId: version.workflowId,
    workflowVersionId: version.id, authorizationPrincipalId, approval: version.approval,
    agentConfigurationVersionIds: version.agentConfigurationVersionIds,
    ...(options.input === undefined ? {} : { input: options.input }) })
  const request = { workspaceId: version.workspaceId, workflowId: version.workflowId, workflowVersionId: version.id,
    executionSemanticsVersion: 3, commandId: randomUUID(), expectedWorkflowRevision: saved.revision,
    expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
    expectedLocationRevision: run.executionLocation.locationRevision, input: run.input }
  const accepted = AcceptedRepeatStartV1Schema.parse({ run, snapshot: { request, authorizationPrincipalId,
    executable: { version, configurations: fixture.configurations }, workflow: { id: version.workflowId,
      workspaceId: version.workspaceId, revision: saved.revision, currentVersionId: version.id, archived: false,
      definition: version.definition }, workspace: { id: version.workspaceId, archived: false, location: run.executionLocation }, draft: null } })
  if (options.insert !== false) await withExclusiveGraphConnection(pool,
    (connection) => connection.transaction((sql) => insertRepeatRun(sql, accepted, repeatStartPublication)))
  const scope: RepeatGraphScopeV3 = { workspaceId: run.workspaceId, workflowId: run.workflowId,
    workflowVersionId: version.id, runId: run.id, executionSemanticsVersion: 3 }
  return { version, run, accepted, scope }
}
