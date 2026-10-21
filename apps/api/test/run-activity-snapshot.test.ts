import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { readRunActivitySnapshot } from '../src/modules/runs/activitySnapshot.js'
import { projectNativeActivityFacts } from '../src/modules/runs/nativeActivitySnapshot.js'
import type { ActivityReadRow } from '../src/modules/runs/activityProjection.js'
import { ciActivityFromRecord } from '../src/modules/runs/agentCiSnapshot.js'
import { CiRunRecordSchema } from '@foreman-code/contracts'

const scope = { workspaceId: 'ws', workflowId: 'wf', runId: 'run', workflowVersionId: 'version' }
const version = { id: 'version', workspaceId: 'ws', workflowId: 'wf', definition: { nodes: [], edges: [] } } as unknown as WorkflowVersionV3
function fixture(moving = false, jobs: Record<string, unknown>[] = [], movingJob = false,
  cis: Record<string, unknown>[] = [], movingCi = false, activities: ActivityReadRow[] = []) {
  const executions = [
    { id: 'A', attempt: 1, revision: '7', native_revision: '0', state: 'running', outcome: null,
      started_at: '2026-10-01T00:00:00.000Z', native_session_id: 'native-A', harness: 'codex' },
    { id: 'C', attempt: 2, revision: '2', native_revision: '0', state: 'waiting', outcome: null,
      started_at: '2026-10-01T00:00:01.000Z', native_session_id: 'native-C', harness: 'codex' },
    { id: 'B', attempt: 1, revision: '0', native_revision: '0', state: 'queued', outcome: null,
      started_at: null, native_session_id: null, harness: 'codex' },
  ]
  const facts = (after: boolean) => [{
    run: { revision: moving && after ? '4' : '3', stopped: false, outcome: 'pending', execution_state: 'running' },
    executions,
    jobs: jobs.map(job => ({ ...job, revision: movingJob && after ? '10' : job.revision })),
    cis: cis.map(ci => ({ ...ci, revision: movingCi && after ? '4' : ci.revision })),
    interactions: [],
    bounds: { high_water: '9007199254740993', retained_from: '1', observed: 1 },
  }]
  // Serve the two fact reads around the activity/native pages, independent of query spelling.
  const responses = [facts(false), activities, [], facts(true)]
  const sql = { query: async () => {
    const rows = responses.shift()
    if (!rows) throw new Error('Unexpected activity read after the snapshot completed')
    return { rows }
  } } as unknown as Pick<pg.PoolClient, 'query'>
  return sql
}
describe('Run activity snapshot', () => {
  it('keeps Host CI owned by its Agent execution through waiting, running and terminal states', async () => {
    const record = CiRunRecordSchema.parse({ id: '00000000-0000-4000-8000-000000000001',
      groupId: '00000000-0000-4000-8000-000000000002', workspaceId: scope.workspaceId,
      suite: 'install', repository: 'example/project', commit: 'a'.repeat(40), part: null, partition: null,
      state: 'queued', computer: null, step: null, exitCode: null, message: null,
      queuedAt: '2026-10-01T00:00:02.000Z', startedAt: null, finishedAt: null,
      initiator: { principalId: 'worker', executionId: 'A' } })
    const ci = { id: record.id, revision: '3', execution_id: 'A', agent_id: 'agent', node_id: 'node',
      pinned: true, record }
    const ownedVersion = { ...version, definition: { ...version.definition,
      nodes: [{ id: 'node', kind: 'agent' as const, agentId: 'agent' }] } } as WorkflowVersionV3
    const queued = await readRunActivitySnapshot(fixture(false, [], false, [ci]), scope, ownedVersion)
    expect(queued.queued).toContainEqual(expect.objectContaining({ kind: 'ci', executionId: 'A', ticketId: record.id }))
    expect(queued.active).toContainEqual(expect.objectContaining({ phase: 'waiting',
      ref: expect.objectContaining({ kind: 'ci', executionId: 'A', agentId: 'agent' }),
      ci: expect.objectContaining({ state: 'queued' }) }))
    for (const state of ['starting', 'running', 'passed', 'failed', 'canceled', 'lost'] as const) {
      const read = await readRunActivitySnapshot(fixture(false, [], false, [{ ...ci,
        record: { ...record, state } }]), scope, ownedVersion)
      const active = read.active.find(work => work.ref.kind === 'ci')
      if (state === 'starting' || state === 'running') {
        expect(active).toMatchObject({ phase: state === 'starting' ? 'preparing' : 'active', ci: { state } })
      } else expect(active).toBeUndefined()
      expect(read.queued.some(ref => ref.kind === 'ci')).toBe(false)
    }
    expect(queued.sourceRevisions).toContainEqual({ source: 'ci_run', id: record.id, revision: '3' })
    await expect(readRunActivitySnapshot(fixture(false, [], false, [ci], true), scope, ownedVersion))
      .rejects.toMatchObject({ code: 'ACTIVITY_SNAPSHOT_CONFLICT' })
    await expect(readRunActivitySnapshot(fixture(false, [], false, [{ ...ci, agent_id: 'foreign' }]), scope, ownedVersion))
      .rejects.toMatchObject({ code: 'ACTIVITY_OWNER_CONFLICT' })
  })
  it('attributes shared CI activity to each requesting execution', async () => {
    const record = CiRunRecordSchema.parse({ id: '00000000-0000-4000-8000-000000000001',
      groupId: '00000000-0000-4000-8000-000000000002', workspaceId: scope.workspaceId,
      suite: 'install', repository: 'example/project', commit: 'a'.repeat(40), partition: null, state: 'running',
      computer: null, step: null, exitCode: null, message: null,
      queuedAt: '2026-10-01T00:00:02.000Z', startedAt: null, finishedAt: null,
      initiator: { principalId: 'worker', executionId: 'A' } })
    const requesters = ['A', 'C']
    const nodes = requesters.map(id => ({ id: `node-${id}`, kind: 'agent' as const, agentId: `agent-${id}` }))
    const ownedVersion = { ...version, definition: { ...version.definition, nodes } } as WorkflowVersionV3
    const cis = requesters.map((id, index) => ({ id: record.id, revision: '3', execution_id: id,
      agent_id: nodes[index]!.agentId, node_id: nodes[index]!.id, pinned: true, record }))
    const activities: ActivityReadRow[] = requesters.map((id, index) => ({ sequence: String(index + 1),
      source: 'backend', kind: 'ci_state_changed', occurred_at: new Date(record.queuedAt),
      harness_execution_id: id, execution_node_id: nodes[index]!.id, execution_agent_id: nodes[index]!.agentId,
      execution_attempt: index + 1, work_activation_id: null, result_outcome: null, native: null,
      ci_ticket_id: record.id, ci_activity: ciActivityFromRecord(record), safe_payload: {} }))
    const read = await readRunActivitySnapshot(fixture(false, [], false, cis, false, activities), scope, ownedVersion)
    expect(read.active.filter(work => work.ref.kind === 'ci').map(work => work.ref))
      .toEqual(requesters.map(executionId => expect.objectContaining({ ticketId: record.id, executionId })))
    for (const activity of read.activities) {
      const executionId = activity.order === '1' ? 'A' : 'C'
      expect(activity.owner).toMatchObject({ kind: 'ci', ticketId: record.id, executionId })
      expect(activity.parent).toMatchObject({ executionId })
    }
    expect(read.activities).toHaveLength(2)
  })
  it('keeps two active executions, queued newest B, and independent exact source revisions', async () => {
    const value = await readRunActivitySnapshot(fixture(), scope, version)
    expect(value.active.map((entry) => entry.ref)).toMatchObject([{ executionId: 'A', attemptKey: '1' }, { executionId: 'C', attemptKey: '2' }])
    expect(value.queued).toMatchObject([{ executionId: 'B' }]); expect(value.latest).toEqual(value.queued[0])
    expect(value.revision).toBe('3'); expect(value.sourceRevisions).toContainEqual({ source: 'run_activity', id: 'run', revision: '9007199254740993' })
  })
  it('rejects a torn READ COMMITTED body rather than stamping it with a later revision', async () => {
    await expect(readRunActivitySnapshot(fixture(true), scope, version)).rejects.toMatchObject({ code: 'ACTIVITY_SNAPSHOT_CONFLICT' })
  })
  it('does not settle unresolved native children with their parent or invent their session', () => {
    const row = { execution_id: 'A', sequence: '4', item_id: 'child', item_type: 'subagent', status: 'running', native_session_id: null,
      native_turn_id: 'child-turn', generation: null, observed_at: null }
    const context = () => ({ owner: { kind: 'run' as const, ...scope }, harness: 'codex', sessionId: 'parent-session', terminal: true })
    const result = projectNativeActivityFacts([row], context)
    expect(result.active[0]).toMatchObject({ outcome: null, evidence: 'unknown' }); expect(result.active[0]?.native).toBeUndefined()
    expect(projectNativeActivityFacts([{ ...row, status: 'completed', native_session_id: 'child-session' }], context).active).toEqual([])
    expect(JSON.stringify(result)).not.toContain('parent-session')
  })
  it('retains genuine Job refs, pending output finalization and independent Job record revisions', async () => {
    const job = { id: 'job-real-id', attempt_id: 'actual-attempt-id', operation_id: 'actual-operation-id', revision: '9',
      node_id: 'job-node', definition_id: 'job-definition', definition_revision: 4, definition_version_id: 'job-version', pinned: true,
      phase: 'terminal', outcome: 'succeeded', stopped: true, publication: 'collecting', started_at: '2026-10-01T00:00:00.000Z',
      finished_at: '2026-10-01T00:00:01.000Z', created_at: '2026-10-01T00:00:00.000000Z' }
    const mixed = { ...version, definition: { ...version.definition, nodes: [{ kind: 'job' as const, id: 'job-node', name: 'Build',
      jobDefinitionId: 'job-definition', jobDefinitionRevision: 4, jobDefinitionVersionId: 'job-version' }] } }
    const value = await readRunActivitySnapshot(fixture(false, [job]), scope, mixed)
    const projected = value.active.find((entry) => entry.ref.kind === 'execution' && entry.ref.executionId === job.id)
    expect(projected).toMatchObject({ ref: { kind: 'execution', executionId: job.id, attemptKey: job.attempt_id }, phase: 'finalizing', outcome: 'succeeded' })
    expect(projected).not.toHaveProperty('native')
    expect(value.sourceRevisions).toContainEqual({ source: 'execution', id: job.id, revision: '9' })
    await expect(readRunActivitySnapshot(fixture(false, [job], true), scope, mixed)).rejects.toMatchObject({ code: 'ACTIVITY_SNAPSHOT_CONFLICT' })
    await expect(readRunActivitySnapshot(fixture(false, [{ ...job, pinned: false }]), scope, mixed)).rejects.toMatchObject({ code: 'ACTIVITY_OWNER_CONFLICT' })
    await expect(readRunActivitySnapshot(fixture(false, [{ ...job, definition_version_id: 'changed' }]), scope, mixed)).rejects.toMatchObject({ code: 'ACTIVITY_OWNER_CONFLICT' })
  })
})
