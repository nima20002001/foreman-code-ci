import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { readAcceptedPlacement, readDispatchIntent } from '../placement/persistence.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { currentOperatorAuthority } from '../access/runAuthority.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { SourceAttemptAuthority } from './executionHosts.js'
import { AgentSourceAttemptAuthority, installedSourceAttemptAuthority, assertAcceptedSourceRelativeCwd } from './agentSourceAuthority.js'
vi.mock('../placement/persistence.js', () => ({ readAcceptedPlacement: vi.fn(), readDispatchIntent: vi.fn() }))
vi.mock('../runs/remote/persistence.js', () => ({ readReconciledDispatchIntent: vi.fn() }))
vi.mock('../access/runAuthority.js', () => ({ currentOperatorAuthority: vi.fn() }))

it('routes only a genuine persisted Agent allocation and releases lookup connection before host revalidation', async () => {
  let released = false
  const client = { query: vi.fn(async (text: string) => { expect(text).toContain('harness_executions'); return { rows: [{ kind: 'agent' }], rowCount: 1 } }), release: () => { released = true } }
  const pool = { connect: async () => client } as unknown as pg.Pool
  const agent = { revalidate: vi.fn(async () => { expect(released).toBe(true) }) } as unknown as SourceAttemptAuthority
  const job = { revalidate: vi.fn() } as unknown as SourceAttemptAuthority
  const port = installedSourceAttemptAuthority(pool, agent, job)
  await port.revalidate({} as Parameters<typeof port.revalidate>[0], { executionId: 'actual-agent', attemptId: 'attempt', placementHash: 'a'.repeat(64), keyRevision: null, authorizationRevision: null })
  expect(agent.revalidate).toHaveBeenCalled(); expect(job.revalidate).not.toHaveBeenCalled()
  expect(client.query.mock.calls[0]?.[0]).toContain('harness_executions')
})
it('denies ambiguous allocations rather than treating an Agent as a Job', async () => {
  const sql = { query: async () => ({ rows: [{ kind: 'agent' }, { kind: 'job' }], rowCount: 2 }) } as unknown as GraphSqlClient
  const agent = { authorize: vi.fn() } as unknown as SourceAttemptAuthority
  const job = { authorize: vi.fn() } as unknown as SourceAttemptAuthority
  const port = installedSourceAttemptAuthority({} as pg.Pool, agent, job)
  await expect(port.authorize(sql, {} as never, { workspaceId: 'ws', root: {} as never,
    attempt: { executionId: 'same-id', attemptId: 'attempt', placementHash: 'a'.repeat(64), keyRevision: null, authorizationRevision: null }, operationId: 'operation' })).rejects.toMatchObject({ code: 'SOURCE_SUBJECT_AMBIGUOUS' })
  expect(agent.authorize).not.toHaveBeenCalled(); expect(job.authorize).not.toHaveBeenCalled()
})
it('requires the original accepted Agent dispatch and live owner grant before probing source roots', async () => {
  const fixture = makeCurrentWorkflowFixture('source-agent-proof', 'single'), execution = fixture.identities[0]!
  const intent = { operationId: 'original-operation', executionId: execution.executionId, attemptId: 'actual-attempt', runId: fixture.run.id,
    nodeId: execution.workflowNodeId, bindingHash: 'b'.repeat(64), owner: { grantId: 'original-grant', epoch: '1' } }
  vi.mocked(readDispatchIntent).mockResolvedValue(intent as never)
  vi.mocked(readReconciledDispatchIntent).mockResolvedValue(intent as never)
  const query = vi.fn(async (text: string, values?: unknown[]) => { void values; return ({ rows: text.includes('harness_executions') ? [{ run_id: fixture.run.id, workflow_node_id: execution.workflowNodeId, agent_id: execution.agentId }] : [], rowCount: text.includes('harness_executions') ? 1 : 0 }) })
  const rootFence = vi.fn(), authority = new AgentSourceAttemptAuthority({} as pg.Pool, rootFence)
  await expect(authority.authorize({ query } as unknown as GraphSqlClient, {} as never, { workspaceId: fixture.run.workspaceId, root: {} as never,
    attempt: { executionId: execution.executionId, attemptId: 'actual-attempt', placementHash: 'a'.repeat(64), keyRevision: null, authorizationRevision: null }, operationId: 'original-operation' })).rejects.toMatchObject({ code: 'AGENT_SOURCE_OWNER_REVOKED' })
  expect(query.mock.calls[1]?.[1]).toEqual([execution.executionId, 'original-operation', 'original-grant', '1'])
  expect(readAcceptedPlacement).not.toHaveBeenCalled(); expect(currentOperatorAuthority).not.toHaveBeenCalled(); expect(rootFence).not.toHaveBeenCalled()
})

it('allows only the original accepted Agent child or full-tree verification', async () => {
  vi.mocked(readAcceptedPlacement).mockResolvedValue({ payload: { kind: 'agent' }, destination: { canonicalProjectRoot: '/approved/project', canonicalCwd: '/approved/project/src' } } as never)
  const sql = { query: async () => ({ rows: [{ run_id: 'actual-run', workflow_node_id: 'actual-node' }], rowCount: 1 }) } as unknown as GraphSqlClient
  await expect(assertAcceptedSourceRelativeCwd(sql, 'actual-execution', 'src')).resolves.toBeUndefined()
  await expect(assertAcceptedSourceRelativeCwd(sql, 'actual-execution', '')).resolves.toBeUndefined()
  await expect(assertAcceptedSourceRelativeCwd(sql, 'actual-execution', 'other')).rejects.toMatchObject({ code: 'SOURCE_CWD_PIN_CONFLICT' })
})
