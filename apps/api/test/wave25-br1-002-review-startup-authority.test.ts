import { describe, expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { ExecutableWorkflowV3Schema, makeCurrentWorkflowFixture, AcceptedWorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { candidateFor } from './helpers/wave25Agent3.js'
import type { GraphSqlClient } from '../src/modules/run-graph/connection.js'
import { assertOrchestratorGraphAuthority } from '../src/modules/interactions/graphAuthority.js'

type AuthorityRequest = Parameters<typeof assertOrchestratorGraphAuthority>[1]

/** Real decoders, saved-route resolver and authority guard; only the SQL read is
 * a stub. This is not coordinator/dispatcher/PostgreSQL qualification. */
function authorityFixture() {
  const f = makeCurrentWorkflowFixture('br1-002-startup-authority')
  const [entry, worker] = f.version.definition.nodes
  if (!entry || !worker) throw new Error('Expected the two-node current fixture')
  const approval = { handler: 'orchestrator' as const, designatedOrchestratorAgentId: entry.agentId }
  const configurations = f.configurations.map((c) => AgentConfigurationVersionSchema.parse({
    ...c, productRole: c.agentId === entry.agentId ? 'orchestrator' : 'coder',
    harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, advanced: {
      ...DEFAULT_HARNESS_DEFAULTS.codex.advanced!,
      approvalsReviewer: c.agentId === entry.agentId ? 'auto_review' : 'user',
      approvalPolicy: 'on-request',
    } },
  }))
  const relationshipId = `approval-${worker.id}`
  const version = ExecutableWorkflowV3Schema.parse({ configurations, version: {
    ...f.version, approval, definition: { ...f.version.definition, approval,
      edges: [...f.version.definition.edges, { id: relationshipId, kind: 'approval', source: entry.id, target: worker.id }] },
  } }).version
  const run = AcceptedWorkflowRunV3Schema.parse({ ...f.run, approval, authorizationPrincipalId: 'fixture-author',
    executionLocation: { runnerId: 'local', rootPath: '/synthetic/authority', locationRevision: 1, identityHash: `sha256:${'1'.repeat(64)}` } })
  const execution = HarnessExecutionSchema.parse({ ...candidateFor(f, worker.id), state: 'running', nativeSessionId: 'ses_br1002_worker' })
  const row = { run_record: run, version_record: version, execution_record: execution,
    configuration_record: configurations[0], requester_configuration_record: configurations[1], workflow_node_id: worker.id }
  const query = vi.fn(async () => ({ rows: [row] }))
  const client = { query } as unknown as GraphSqlClient
  const request: AuthorityRequest = { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    executionId: execution.id, requestingAgentId: execution.agentId, approval,
    nativeSessionId: execution.nativeSessionId!, harness: 'codex' }
  return { client, query, request, relationshipId, entry, worker }
}

describe('BR1-002 reviewer startup: native authority is not optional for V3', () => {
  it('accepts the exact persisted Worker native session/harness and immutable approval edge', async () => {
    const f = authorityFixture()
    await expect(assertOrchestratorGraphAuthority(f.client, f.request)).resolves.toMatchObject({
      relationshipId: f.relationshipId, requestingNodeId: f.worker.id, orchestratorNodeId: f.entry.id,
    })
    expect(f.query).toHaveBeenCalledOnce()
  })

  it.each(['nativeSessionId', 'harness'] as const)('rejects a pre-create request missing %s', async (field) => {
    const f = authorityFixture()
    delete f.request[field]
    await expect(assertOrchestratorGraphAuthority(f.client, f.request)).rejects.toMatchObject({
      code: 'INTERACTION_ACCESS_DENIED', status: 403,
    })
  })

  it('rejects the original coordinator-shaped call that omits both native identity fields', async () => {
    const f = authorityFixture()
    const { workspaceId, workflowId, runId, executionId, requestingAgentId, approval } = f.request
    await expect(assertOrchestratorGraphAuthority(f.client, {
      workspaceId, workflowId, runId, executionId, requestingAgentId, approval,
    })).rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED', status: 403 })
  })

  it('rejects another native session rather than trusting only the Run and execution IDs', async () => {
    const f = authorityFixture()
    await expect(assertOrchestratorGraphAuthority(f.client, { ...f.request, nativeSessionId: 'ses_other' }))
      .rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED', status: 403 })
  })

})
