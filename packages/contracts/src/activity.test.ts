import { describe, expect, it } from 'vitest'
import { ActivitySnapshotV1Schema, projectActivityStatus } from './activity.js'
import { activitySnapshotFixtures as fixtures } from './activityFixtures.js'
import { CiActivitySchema } from './ciHost.js'
describe('Activity v1 ownership projection', () => {
  it('keeps a CI ticket separate from its owning execution and validates lifecycle facts', () => {
    const ci = CiActivitySchema.parse({ id: '00000000-0000-4000-8000-000000000001',
      groupId: '00000000-0000-4000-8000-000000000002', suite: 'integration', part: null,
      partition: { index: 0, count: 2 }, state: 'queued', computer: null, step: null, exitCode: null,
      queuedAt: '2026-10-01T00:00:00.000Z', startedAt: null, finishedAt: null })
    const ref = { kind: 'ci', workspaceId: 'ws', workflowId: 'wf', runId: 'run', workflowVersionId: 'version',
      executionId: 'agent-execution', attemptKey: '1', nodeId: 'node', agentId: 'agent', ticketId: ci.id }
    const snapshot = { ...fixtures.idle, scope: { kind: 'workflow_run', workspaceId: 'ws', workflowId: 'wf',
      runId: 'run', workflowVersionId: 'version' }, queued: [ref], latest: ref,
      active: [{ ref, phase: 'waiting', outcome: null, delivery: null, evidence: 'confirmed', startedAt: null, ci }] }
    expect(ActivitySnapshotV1Schema.parse(snapshot).active[0]).toMatchObject({ ref, ci })
    expect(CiActivitySchema.safeParse({ ...ci, state: 'succeeded' }).success).toBe(false)
    expect(CiActivitySchema.safeParse({ ...ci, suite: 'build', part: 'lint-api', partition: null }).success).toBe(false)
    expect(CiActivitySchema.safeParse({ ...ci, partition: { index: 2, count: 2 } }).success).toBe(false)
    expect(CiActivitySchema.safeParse({ ...ci, logTail: 'raw log' }).success).toBe(false)
  })
  it('preserves older active A independently of newer queued/latest B', () => {
    const value = fixtures.activeBeforeNewerQueued
    expect(value.active[0]?.ref).toMatchObject({ requestId: 'A' })
    expect(value.queued).toEqual([{ kind: 'chat_request', conversationId: 'conversation', requestId: 'B' }])
    expect(value.latest).toEqual(value.queued[0])
  })
  it('keeps interruption and uncertainty separate from proven outcomes', () => {
    expect(fixtures.interrupting.active[0]?.outcome).toBeNull()
    expect(fixtures.uncertainDelivery.active[0]).toMatchObject({ evidence: 'reconciling', delivery: 'unknown', outcome: null })
  })
  it('does not settle unresolved children with their parent', () => {
    expect(fixtures.terminalParentUnresolvedChild.active).toHaveLength(1)
    expect(fixtures.terminalParentUnresolvedChild.active[0]).toMatchObject({ ref: { kind: 'subagent' }, outcome: null, evidence: 'unknown' })
  })
  it('retains multiple active executions without newest-wins selection', () => {
    const work = fixtures.activeBeforeNewerQueued.active[0]!
    const execution = { kind: 'execution' as const, workspaceId: 'ws', workflowId: 'wf', runId: 'run', workflowVersionId: 'version', executionId: 'one', attemptKey: 'attempt' }
    expect(projectActivityStatus({ work: [{ ...work, ref: execution }, { ...work, ref: { ...execution, executionId: 'two' } }], queued: [], latest: execution }).active).toHaveLength(2)
  })
  it('validates fixtures and rejects transport/raw fields and numeric revisions', () => {
    for (const fixture of Object.values(fixtures)) expect(ActivitySnapshotV1Schema.safeParse(fixture).success).toBe(true)
    expect(ActivitySnapshotV1Schema.safeParse({ ...fixtures.idle, revision: 12 }).success).toBe(false)
    expect(ActivitySnapshotV1Schema.safeParse({ ...fixtures.idle, connection: 'connected' }).success).toBe(false)
  })
})
