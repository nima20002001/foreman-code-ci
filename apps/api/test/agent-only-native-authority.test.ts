import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { AgentSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import { JobWorkflowNodeSchema } from '@foreman-code/contracts/job-workflow'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture, type CurrentEditSaveInput, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { prepareCurrentStagedAgents } from '../src/modules/graph-drafts/currentStagedAgents.js'
import { identity, readContext } from '../src/modules/interactions/wave25/context.js'
import type { GraphSqlClient } from '../src/modules/run-graph/connection.js'
import { deliveryFixture } from './helpers/wave25ApprovalFixture.js'

/** Scripted read ports exercise current contracts and domain predicates, not SQL integration. */
function fixture() {
  const saved = makeCurrentWorkflowFixture('agent-only-authority')
  const version: WorkflowVersionV3 = saved.version
  const job = JobWorkflowNodeSchema.parse({ kind: 'job', id: 'native-authority-job-node', name: 'Build',
    jobDefinitionId: 'native-authority-job', jobDefinitionRevision: 2, jobDefinitionVersionId: 'native-authority-job-version' })
  version.definition.nodes.unshift(job)
  version.definition.executionPolicy!.maxNodeExecutions++
  const actor = saved.identities[0]!
  const requester = HarnessExecutionSchema.parse({ id: actor.executionId, runId: saved.run.id,
    workflowNodeId: actor.workflowNodeId, agentId: actor.agentId, agentConfigurationVersionId: actor.agentConfigurationVersionId,
    attempt: 2, input: {}, state: 'waiting', nativeSessionId: 'actual-requester-session', createdAt: saved.createdAt })
  const interaction = { ...deliveryFixture().interaction, workspaceId: saved.run.workspaceId,
    workflowId: saved.run.workflowId, runId: saved.run.id, executionId: requester.id,
    requestingAgentId: requester.agentId, nativeSessionId: requester.nativeSessionId!, approval: saved.run.approval }
  const query = vi.fn(async (text: string, values: unknown[] = []) => {
    if (text.includes('r.record as run')) return { rows: [{ run: saved.run, version, stopped: false }], rowCount: 1 }
    if (text.includes('from harness_executions')) return { rows: [{ record: requester, closed: false }], rowCount: 1 }
    if (text.includes('approval_relationship_id')) return { rows: [{ approval_relationship_id: null,
      approval_reviewer_execution_id: null }], rowCount: 1 }
    if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 }
    throw new Error(`Unexpected read-only authority query (${values.length} parameters): ${text}`)
  })
  const principal: ManagementPrincipal = { id: 'staged-agent-author', name: 'Author', audience: 'operator',
    revokedAt: null, expiresAt: '2099-01-01T00:00:00.000Z',
    grants: [{ actions: ['agents:create'], scope: { workspaceIds: [saved.run.workspaceId] } }] }
  const input: CurrentEditSaveInput = { workspaceId: saved.run.workspaceId, workflowId: saved.run.workflowId,
    executionSemanticsVersion: 3, commandId: 'mixed-agent-save', expectedRevision: 1,
    expectedWorkflowVersionId: version.id, expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
    graph: version.definition }
  return { ...saved, version, job, requester, interaction, query, principal, input,
    sql: { query } as unknown as GraphSqlClient, client: { query } as unknown as pg.PoolClient }
}

describe('Agent-only native approval and staged configuration boundaries', () => {
  it('retains exact Agent Run/version/configuration/attempt identity in a mixed current workflow', async () => {
    const f = fixture()
    const context = await readContext(f.sql, f.interaction)
    expect(context.scope).toEqual({ workspaceId: f.run.workspaceId, workflowId: f.run.workflowId,
      runId: f.run.id, workflowVersionId: f.version.id, executionSemanticsVersion: 3 })
    expect(identity(context.requester)).toEqual({ workflowNodeId: f.requester.workflowNodeId,
      executionId: f.requester.id, agentId: f.requester.agentId,
      agentConfigurationVersionId: f.requester.agentConfigurationVersionId, attempt: 2 })
    expect(context.reviewer).toBeUndefined()
    expect(f.query.mock.calls.every(([sql]) => !/insert|update|delete/i.test(sql))).toBe(true)
  })

  it('refuses a Job requester even when a neighboring Agent has matching configuration and session facts', async () => {
    const f = fixture()
    f.requester.workflowNodeId = f.job.id
    await expect(readContext(f.sql, f.interaction)).rejects.toMatchObject({ code: 'APPROVAL_REQUESTER_MISMATCH' })
    expect(f.query.mock.calls.some(([sql]) => sql.includes('approval_relationship_id'))).toBe(false)
  })

  it('keeps staged planning pins limited to authored Agents and locks no synthetic Job Agent', async () => {
    const f = fixture()
    expect(await prepareCurrentStagedAgents(f.client, f.principal, f.input))
      .toEqual({ prepared: [], resultant: f.version.agentConfigurationVersionIds })
    expect(f.query.mock.calls.map((call) => call[1])).not.toContainEqual([`agent:${f.job.jobDefinitionId}`])
  })

  it('refuses staging an Agent configuration through a Job reference before any SQL work', async () => {
    const f = fixture()
    const staged = { agent: AgentSchema.parse({ id: f.job.jobDefinitionId, name: 'Cannot configure a Job as an Agent' }), baseRevision: null }
    await expect(prepareCurrentStagedAgents(f.client, f.principal, { ...f.input, stagedAgents: [staged] }))
      .rejects.toMatchObject({ code: 'AGENT_CONFIGURATION_CONFLICT' })
    expect(f.query).not.toHaveBeenCalled()
  })

  it('requires scoped create grants before disclosing whether a staged mixed-node identity is valid', async () => {
    const f = fixture()
    const staged = { agent: AgentSchema.parse({ id: f.job.jobDefinitionId, name: 'Denied stage' }), baseRevision: null }
    const denied = { ...f.principal, grants: [{ actions: ['agents:create' as const], scope: { workspaceIds: ['another-workspace'] } }] }
    await expect(prepareCurrentStagedAgents(f.client, denied, { ...f.input, stagedAgents: [staged] }))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED', status: 403 })
    expect(f.query).not.toHaveBeenCalled()
  })
})
