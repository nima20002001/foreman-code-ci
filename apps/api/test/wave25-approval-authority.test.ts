import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { repeatDigest, repeatExecutionIdentity, repeatSlotId } from '../src/modules/runs/repeatResolution.js'
import { repeatTerminalResolution } from '../src/modules/runs/repeatNode.js'
import { assertOrchestratorGraphAuthority } from '../src/modules/interactions/graphAuthority.js'
import { approvalFixture, deliveryFixture } from './helpers/wave25ApprovalFixture.js'

function setup() {
  const f = approvalFixture()
  const requester = f.executions[1]!
  const reviewer = f.executions[0]!
  reviewer.state = 'completed'
  reviewer.result = { outcome: 'succeeded', output: { reviewed: true } }
  reviewer.finishedAt = f.createdAt
  const interaction = deliveryFixture().interaction
  const row = {
    run_record: f.run, version_record: f.version, execution_record: requester,
    configuration_record: f.configurations[0]!, requester_configuration_record: f.configurations[1]!,
    workflow_node_id: requester.workflowNodeId,
  }
  const owner = { rows: [{ id: reviewer.id, record: reviewer }] }
  const executionRow = (execution: typeof reviewer) => ({ record: execution, identity: repeatExecutionIdentity(execution),
    accepted: execution.id === reviewer.id, execution_id: execution.id, run_id: f.run.id,
    workflow_node_id: execution.workflowNodeId, agent_id: execution.agentId, attempt: execution.attempt,
    slot_id: repeatSlotId(f.run.id, { nodeId: execution.workflowNodeId, occurrence: null }),
    occurrence_id: null, execution_occurrence_id: null, identity_occurrence_id: null,
    technical_attempt: execution.attempt, input_json: JSON.stringify(execution.input), input_digest: repeatDigest(execution.input), occurrence_record: null })
  const query = vi.fn().mockImplementation(async (sql: string, parameters: unknown[]) => {
    if (sql.includes("as semantics from runs")) return { rows: [{ semantics: '3' }] }
    if (sql.includes('r.id as run_id')) return { rows: [{ run_record: f.run, version_record: f.version,
      run_id: f.run.id, workspace_id: f.run.workspaceId, workflow_id: f.run.workflowId, workflow_version_id: f.version.id }] }
    if (sql.includes('join run_repeat_executions')) return { rows: [executionRow(parameters[0] === reviewer.id ? reviewer : requester)] }
    if (sql.includes('from run_repeat_resolutions')) return { rows: [{
      record: repeatTerminalResolution(f.version, { workspaceId: f.run.workspaceId, workflowId: f.run.workflowId,
        workflowVersionId: f.version.id, runId: f.run.id, executionSemanticsVersion: 3 }, { nodeId: reviewer.workflowNodeId, occurrence: null }, reviewer),
      execution_id: reviewer.id, source_occurrence_id: null }] }
    if (sql.includes('from run_repeat_results')) return { rows: [{ execution_id: reviewer.id, run_id: f.run.id,
      occurrence_id: null, result_json: JSON.stringify(reviewer.result), result_digest: repeatDigest(reviewer.result) }] }
    return { rows: [row] }
  })
  return { ...f, requester, reviewer, interaction, row, owner, query, client: { query } as unknown as pg.Pool }
}

describe('Version-bound approval authority', () => {
  it('uses the exact accepted route for the requester and reviewer execution/session', async () => {
    const f = setup()
    f.query.mockResolvedValueOnce({ rows: [f.row] }).mockResolvedValueOnce(f.owner)
    await expect(assertOrchestratorGraphAuthority(f.client, f.interaction, {
      executionId: f.reviewer.id, principalId: 'credential-reviewer', nativeSessionId: f.reviewer.nativeSessionId!,
    })).resolves.toMatchObject({ requestingNodeId: 'node-worker', orchestratorNodeId: 'node-reviewer', relationshipId: 'approval-edge' })
  })
  const deniedCases: Array<[string, (f: ReturnType<typeof setup>) => void]> = [
    ['requester node', (f) => { f.requester.workflowNodeId = 'different-node'; f.row.workflow_node_id = 'different-node' }],
    ['requester Agent', (f) => { f.requester.agentId = 'different-agent' }],
    ['Run', (f) => { f.requester.runId = 'different-run' }],
    ['workspace', (f) => { f.run.workspaceId = 'different-workspace' }],
    ['version', (f) => { f.run.workflowVersionId = 'different-version' }],
    ['requester configuration', (f) => { f.requester.agentConfigurationVersionId = 'different-config' }],
    ['reviewer configuration', (f) => { f.configurations[0]!.id = 'different-reviewer-config' }],
    ['reviewer role', (f) => { f.configurations[0]!.productRole = 'coder' }],
    ['native session', (f) => { f.requester.nativeSessionId = 'different-session' }],
    ['missing native session', (f) => { delete f.requester.nativeSessionId }],
    ['missing explicit assignment', (f) => { f.version.definition.edges = f.version.definition.edges.filter((e) => e.kind === 'execution') }],
    ['native self-review crossing into App routing', (f) => { f.configurations[1]!.harness = structuredClone(f.configurations[0]!.harness) }],
  ]
  it.each(deniedCases)('denies mismatched %s before any decision', async (_name, mutate) => {
    const f = setup()
    mutate(f)
    await expect(assertOrchestratorGraphAuthority(f.client, f.interaction)).rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
  })
  it('denies the wrong reviewer native session even when its Agent and node match', async () => {
    const f = setup()
    f.query.mockResolvedValueOnce({ rows: [f.row] }).mockResolvedValueOnce(f.owner)
    await expect(assertOrchestratorGraphAuthority(f.client, f.interaction, {
      executionId: f.reviewer.id, nativeSessionId: 'stale-reviewer-session',
    })).rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
  })
  it('denies missing or revoked credential bindings returned by the authority query', async () => {
    const f = setup()
    f.query.mockResolvedValueOnce({ rows: [f.row] }).mockResolvedValueOnce({ rows: [] })
    await expect(assertOrchestratorGraphAuthority(f.client, f.interaction, { principalId: 'revoked-credential' }))
      .rejects.toMatchObject({ code: 'INTERACTION_ACCESS_DENIED' })
    // This unit assertion is not PostgreSQL or authentication evidence.
    expect(f.query.mock.calls[1]![0]).toContain('b.revoked_at is null')
  })
})
