import { agentWorkflowVersion } from './helpers/agentWorkflowFixture.js'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { ManagementActionSchema, type ManagementGrant } from '@foreman-code/contracts/management'
import {
  AcceptedRepeatStartV1Schema, AcceptedWorkflowRunV3Schema, CurrentWorkflowSaveResultSchema, WorkflowVersionV3Schema,
  type RepeatGraphScopeV3, type CurrentWorkflowSaveInput, type CurrentWorkflowSavedSchema, type makeCurrentWorkflowFixture,
} from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import type { z } from 'zod'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { insertRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
type Agent3Fixture = ReturnType<typeof makeCurrentWorkflowFixture>
type RepeatSavedWorkflow = z.infer<typeof CurrentWorkflowSavedSchema>

/** Prepare a current V3 graph for an explicit bounded repeat publication. */
export function repeatReadyAgent3Fixture(fixture: Agent3Fixture): Agent3Fixture {
  const entry = fixture.version.definition.nodes[0]!, exit = fixture.version.definition.nodes[1]!
  fixture.version = agentWorkflowVersion(WorkflowVersionV3Schema.parse({ ...fixture.version, definition: { ...fixture.version.definition,
    executionPolicy: { maxParallelism: 1, maxNodeExecutions: 6 }, nodes: [entry, { ...exit, choice: { outcomes: [
      { outcome: 'pass', target: { kind: 'branch_end' } }, { outcome: 'issues', target: { kind: 'branch_end' } },
    ] } }],
  } }))
  return fixture
}

/** Real bearer credential + authenticated production HTTP repeat writer. The
 * request therefore reaches the same authoring service, additive SQL witness,
 * command receipt, success audit and immutable v3 publication as the product. */
export async function createRepeatFixtureWriter(pool: pg.Pool, fixture: Agent3Fixture) {
  const access = new PostgresAccessService(pool), commands = new PostgresCommandCoordinator(pool)
  const grantScope = { workspaceIds: [fixture.scope.workspaceId], workflowIds: [fixture.scope.workflowId] }
  const credential = (grants: ManagementGrant[]) => access.issue({ name: 'ENG04 PostgreSQL fixture writer', audience: 'operator',
    expiresAt: new Date(Date.now() + 300000), grants })
  const writer = await credential([{ actions: ['capabilities:read'], scope: {} },
    { actions: ['workspace_locations:read', 'skills:read'], scope: { workspaceIds: [fixture.scope.workspaceId] } }, {
    actions: ManagementActionSchema.options.filter((action) => action !== 'capabilities:read'), scope: grantScope,
  }])
  const workflows = new WorkflowManagementService(pool, commands)

  async function publish(maxOccurrences = 3): Promise<RepeatSavedWorkflow> {
    const head = (await pool.query<{ revision: string; current_version_id: string | null }>(
      'select revision::text,current_version_id from workflows where workspace_id=$1 and id=$2',
      [fixture.scope.workspaceId, fixture.scope.workflowId],
    )).rows[0]
    if (!head?.current_version_id) throw new Error('The disposable repeat fixture has no saved workflow head')
    const revision = Number(head.revision)
    if (!Number.isSafeInteger(revision)) throw new Error('The disposable repeat fixture has an invalid workflow revision')
    const entry = fixture.version.definition.nodes[0]!, exit = fixture.version.definition.nodes[1]!
    if (!fixture.run.executionLocation) throw new Error('The current fixture requires an execution location')
    const input: CurrentWorkflowSaveInput = {
      workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId, commandId: randomUUID(),
      expectedRevision: revision, expectedWorkflowVersionId: head.current_version_id, executionSemanticsVersion: 3,
      expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
      graph: { ...fixture.version.definition, repeat: { contractVersion: 1, blocks: [{ id: 'repair', nodeIds: [entry.id, exit.id], entryNodeId: entry.id,
        exitNodeId: exit.id, maxOccurrences, repeatOutcome: 'issues', earlyExitOutcome: 'pass', limitExit: { kind: 'branch_end' } }] } },
    }
    const app = buildApp({ readiness: { database: { ping: async () => { await pool.query('select 1') } },
      checkpoints: { ping: async () => undefined } }, operator: { access,
      services: { commands, workflows } as OperatorServices } })
    await app.ready()
    try {
      const response = await app.inject({ method: 'PUT',
        url: `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/definition`,
        headers: { host: 'localhost', accept: 'application/json', authorization: `Bearer ${writer.token}` }, payload: input })
      if (response.statusCode !== 200) throw new Error(`Authenticated repeat fixture publication failed: ${response.statusCode} ${response.body}`)
      return CurrentWorkflowSaveResultSchema.parse(response.json()).value
    } finally { await app.close() }
  }

  return { access, commands, workflows, grantScope, credential, writer, publish }
}

/** Build the same accepted v3 Start cut used by the real admission layer, then
 * insert through the owner-safe repeat Run transaction and canonical baseline
 * producer. No raw Run row, graph receipt or workflow pointer is synthesized. */
export async function insertFixtureRepeatRun(pool: pg.Pool, fixture: Agent3Fixture, saved: RepeatSavedWorkflow,
  authorizationPrincipalId: string, options: { insert?: boolean; input?: unknown } = {}) {
  const version = saved.version
  const run = AcceptedWorkflowRunV3Schema.parse({ ...fixture.run, workflowVersionId: version.id,
    executionSemanticsVersion: 3, authorizationPrincipalId,
    ...(options.input === undefined ? {} : { input: options.input }) })
  const request = { workspaceId: version.workspaceId, workflowId: version.workflowId, workflowVersionId: version.id,
    executionSemanticsVersion: 3, commandId: randomUUID(), expectedWorkflowRevision: saved.revision,
    expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
    expectedLocationRevision: run.executionLocation.locationRevision, input: run.input }
  const accepted = AcceptedRepeatStartV1Schema.parse({ run, snapshot: { request, authorizationPrincipalId,
    executable: { version, configurations: fixture.configurations }, workflow: { id: version.workflowId,
      workspaceId: version.workspaceId, revision: saved.revision, currentVersionId: version.id, archived: false,
      definition: version.definition }, workspace: { id: version.workspaceId, archived: false, location: run.executionLocation },
    draft: null,
  } })
  if (options.insert !== false) await withExclusiveGraphConnection(pool,
    (connection) => connection.transaction((sql) => insertRepeatRun(sql, accepted, repeatStartPublication)))
  const scope: RepeatGraphScopeV3 = { workspaceId: run.workspaceId, workflowId: run.workflowId,
    workflowVersionId: version.id, runId: run.id, executionSemanticsVersion: 3 }
  return { version, run, accepted, scope }
}
