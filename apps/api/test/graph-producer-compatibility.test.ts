import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture, type RunGraphScope } from '@foreman-code/contracts/wave25'
import type { JobExecution } from '@foreman-code/contracts/jobs'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { readPublicNodeProjection, type PublicProjectionOverlay } from '../src/modules/run-graph/publicProjection.js'
import { jobExecution } from './helpers/jobFixture.js'

/** Query-only DB doubles exercise actual projection code/contracts; no SQL integration proof. */
function fixture() {
  const saved = makeCurrentWorkflowFixture('job-public-projection', 'single')
  const scope: RunGraphScope = { workspaceId: saved.run.workspaceId, workflowId: saved.run.workflowId,
    workflowVersionId: saved.version.id, runId: saved.run.id, executionSemanticsVersion: 3 }
  const agent = saved.identities[0]!, nodeId = agent.workflowNodeId
  const job = jobExecution()
  job.workspaceId = scope.workspaceId
  job.workflow = { workflowId: scope.workflowId, runId: scope.runId, nodeId, nodeExecutionId: job.id }
  const row = { id: job.id, workflow_node_id: nodeId, definition_id: job.acceptedSpec.definitionId,
    version_id: job.acceptedSpec.definitionVersionId, definition_revision: job.acceptedSpec.definitionRevision,
    attempt_id: job.attemptId, operation_id: job.operationId,
    admitted_id: job.id as string | null, phase: 'queued' as string | null, outcome: null as string | null,
    stopped: false, publication: 'pending', result_issue: null as string | null, finished_at: null as string | null }
  let closed = false
  const query = vi.fn(async (text: string) => {
    if (/^(begin|commit|rollback)/.test(text)) return { rows: [], rowCount: 0 }
    if (text.includes('from runs r where')) return { rows: [{ closed, cleanup_pending: false }], rowCount: 1 }
    if (text.includes('workflow_job_preparations')) return { rows: [row], rowCount: 1 }
    if (text.includes('distinct on (e.workflow_node_id)')) return { rows: [], rowCount: 0 }
    if (text.includes('run_repeat_resolutions')) return { rows: [], rowCount: 0 }
    throw new Error(`Unexpected projection query: ${text}`)
  })
  const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => {})
  const counts = new Map([[nodeId, { pendingInteractionCount: 0, unsettledReviewCount: 0,
    cleanupPending: false, deliveryBlocked: false }]])
  const project = (overlay: PublicProjectionOverlay = {}) => connection.transaction(sql =>
    readPublicNodeProjection(sql, scope, [nodeId], { native: [], ...overlay }, counts), true)
  return { scope, nodeId, agent, job, row, query, project, closeRun: () => { closed = true } }
}

describe('current Job public projection producer compatibility', () => {
  it('projects the actual reserved preparation identity before a Job is admitted', async () => {
    const f = fixture()
    f.row.admitted_id = null; f.row.phase = null
    const [node] = await f.project()
    expect(node!.state).toEqual({ workflowNodeId: f.nodeId, lifecycle: 'starting', execution: {
      kind: 'job', workflowNodeId: f.nodeId, executionId: f.job.id, attempt: 1,
      jobDefinitionId: f.job.acceptedSpec.definitionId, jobDefinitionVersionId: f.job.acceptedSpec.definitionVersionId } })
    const call = f.query.mock.calls.find(([text]) => text.includes('workflow_job_preparations'))!
    expect(call[0]).toContain("p.preparation->>'workflowVersionId'=$3")
    expect(call[0]).toContain("j.attempt_id=p.preparation->>'attemptId'")
    expect(f.query.mock.calls.some(([text]) => /insert|update|delete/i.test(text))).toBe(false)
  })
  it.each([
    ['queued', null, false, 'pending', null, null, 'queued'],
    ['running', null, false, 'pending', null, null, 'running'],
    ['terminal', 'succeeded', true, 'collecting', null, 'finished', 'unknown'],
    ['terminal', 'succeeded', false, 'complete', null, 'finished', 'unknown'],
    ['terminal', 'succeeded', true, 'complete', null, 'finished', 'succeeded'],
    ['terminal', 'build_failed', true, 'complete', null, 'finished', 'failed'],
    ['terminal', 'timed_out', true, 'complete', null, 'finished', 'failed'],
    ['terminal', 'cancelled', true, 'complete', null, 'finished', 'canceled'],
    ['terminal', 'succeeded', true, 'failed', 'missing_output', 'finished', 'failed'],
    ['terminal', 'succeeded', true, 'complete', 'log_delivery_unknown', 'finished', 'failed'],
  ])('uses persisted process/publication facts (%s/%s/%s/%s/%s)', async (phase, outcome, stopped, publication, issue, finished, lifecycle) => {
    const f = fixture()
    Object.assign(f.row, { phase, outcome, stopped, publication, result_issue: issue, finished_at: finished })
    expect((await f.project())[0]!.state.lifecycle).toBe(lifecycle)
  })
  it('keeps stop closure unknown until actual terminal settlement', async () => {
    const f = fixture(); f.row.phase = 'running'; f.closeRun()
    expect((await f.project())[0]!.state.lifecycle).toBe('unknown')
  })
  it('drops colliding Agent workflow and review native activity from a Job node', async () => {
    const f = fixture(); f.row.phase = 'queued'
    const agent = { ...f.agent, executionId: f.job.id }
    const activity = { workflowNodeId: f.nodeId, execution: agent, status: 'active' as const,
      action: 'working' as const, acknowledgementId: 'agent-ack', correlationId: 'agent-correlation' }
    const nodes = await f.project({ native: [{ key: { execution: agent, workKind: 'workflow', workId: f.job.id },
      activity, lastNativeSequence: '1' }] })
    expect(nodes[0]!.state.lifecycle).toBe('queued')
    expect(nodes[0]!.activity.status).toBe('unknown')
    expect(nodes[0]!.activity).not.toHaveProperty('acknowledgementId')
  })
  it('rejects an admitted record whose persisted receipt pin does not match', async () => {
    const f = fixture(); f.row.phase = null
    await expect(f.project()).rejects.toMatchObject({ code: 'GRAPH_INVARIANT_VIOLATION' })
  })
  it('computes proposed receipt state only for the exact current Job pins', async () => {
    const f = fixture(), proposed: JobExecution = { ...f.job, process: { ...f.job.process, phase: 'running' } }
    expect((await f.project({ jobs: [proposed] }))[0]!.state.lifecycle).toBe('running')
    for (const patch of [{ attemptId: 'other-attempt' }, { operationId: 'other-operation' },
      { acceptedSpec: { ...proposed.acceptedSpec, definitionRevision: 2 } },
      { acceptedSpec: { ...proposed.acceptedSpec, definitionVersionId: 'other-version' } }]) {
      await expect(f.project({ jobs: [{ ...proposed, ...patch }] })).rejects.toMatchObject({ code: 'GRAPH_INVARIANT_VIOLATION' })
    }
    await expect(f.project({ jobs: [{ ...proposed, workflow: { ...proposed.workflow!, runId: 'other-run' } }] }))
      .rejects.toMatchObject({ code: 'GRAPH_SCOPE_MISMATCH' })
  })
})
