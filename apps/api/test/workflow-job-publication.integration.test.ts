import { readPublicProjectionLocked } from '../src/modules/run-graph/compactSnapshot.js'
import assert from 'node:assert/strict'
import { describe, expect, it } from 'vitest'
import {
  CANONICAL_RUN_GRAPH_MCP_TOOLS,
  RepeatGraphSnapshotV3Schema,
} from '@foreman-code/contracts/wave25'
import { openRunGraphPublication } from '../src/modules/run-graph/publication.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { workflowJobAttemptIdentityMigration } from '../src/infrastructure/workflowJobAttemptIdentityMigration.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { workflowJobFixture } from './helpers/workflowJobFixture.js'
import { graphRpcValue } from './eng04-graph-composition-fixture.js'

type Fixture = Awaited<ReturnType<typeof workflowJobFixture>>

async function withJob(work: (f: Fixture) => Promise<void>, options: Parameters<typeof currentDatabase>[0] = {}) {
  const db = await currentDatabase(options)
  try {
    const f = await workflowJobFixture(db, (graph, job) => {
      const agent = graph.nodes[0]!
      return {
        ...graph,
        entryNodeId: job.id,
        nodes: [job, agent],
        edges: [{ id: 'job-agent', kind: 'execution', source: job.id, target: agent.id }],
        requiredAgentCount: 1,
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: 2 },
      }
    })
    try {
      await work(f)
    } finally {
      await f.close()
    }
  } finally {
    await db.close()
  }
}

async function snapshot(f: Fixture) {
  const response = await f.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.snapshot, { protocolVersion: 1, scope: f.scope })
  expect(response.status).toBe(200)
  expect(response.result?.isError, JSON.stringify(graphRpcValue(response.result))).not.toBe(true)
  return RepeatGraphSnapshotV3Schema.parse(graphRpcValue(response.result))
}

describe.skipIf(!postgresEnabled)('workflow Job Run publication', () => {
  it('upgrades an existing Job preparation without changing its saved Run or graph', async () => {
    await withJob(async f => {
      const ref = { nodeId: f.node.id, occurrence: null }
      const preparation = await f.jobStore().prepareJob(ref)
      assert.equal(preparation.kind, 'preparation')
      if (preparation.kind !== 'preparation') throw new Error('Expected Job preparation')
      const prepared = await snapshot(f)
      const run = await f.readRun()
      await applyApplicationMigrations(f.db.pool)
      await applyApplicationMigrations(f.db.pool)
      expect(await f.readRun()).toEqual(run)
      expect(await snapshot(f)).toEqual(prepared)
      await f.restart()
      expect(await f.jobStore().prepareJob(ref)).toEqual(preparation)
      const execution = await f.admitJob()
      expect(execution.id).toBe(preparation.preparation.executionId)
      expect((await f.db.pool.query('select id from harness_executions where run_id=$1', [f.run.id])).rows)
        .toEqual([])
      expect((await snapshot(f)).state.executions).toEqual(expect.arrayContaining([
        expect.objectContaining({ identity: expect.objectContaining({ kind: 'job', executionId: execution.id }),
          state: 'queued', resultOutcome: null }),
      ]))
    }, { deferMigration: workflowJobAttemptIdentityMigration.version })
  }, 120000)

  it('persists preparation, admission, observation and acceptance through the shared Run publication', async () => {
    await withJob(async f => {
      const ref = { nodeId: f.node.id, occurrence: null }
      const preparation = await f.jobStore().prepareJob(ref)
      assert.equal(preparation.kind, 'preparation')
      if (preparation.kind !== 'preparation') throw new Error('Expected Job preparation')
      const prepared = await snapshot(f)
      expect(prepared.state.executions).toEqual(expect.arrayContaining([
        expect.objectContaining({
          identity: expect.objectContaining({ kind: 'job', executionId: preparation.preparation.executionId }),
          inputDigest: preparation.preparation.inputDigest, state: 'starting', resultOutcome: null,
        }),
      ]))
      expect(prepared.state.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ state: expect.objectContaining({ workflowNodeId: f.node.id, lifecycle: 'starting' }) }),
      ]))
      expect(await f.jobStore().prepareJob(ref)).toEqual(preparation)
      expect(await snapshot(f)).toEqual(prepared)

      const execution = await f.admitJob()
      expect(execution.id).toBe(preparation.preparation.executionId)
      const admitted = await snapshot(f)
      expect(admitted.state.executions).toEqual(expect.arrayContaining([
        expect.objectContaining({ identity: expect.objectContaining({ kind: 'job', executionId: execution.id }),
          state: 'queued', resultOutcome: null }),
      ]))
      expect(await f.jobStore().observeJobState(ref, execution.id)).toEqual(execution)
      await f.driver.observe(execution, new AbortController().signal,
        () => f.jobStore().observeJobState(ref, execution.id))
      const observed = await f.jobStore().observeJobState(ref, execution.id)
      expect(observed.process).toMatchObject({ phase: 'terminal', outcome: 'succeeded', processStopped: true })
      const terminal = await snapshot(f)
      expect(terminal.state.executions).toEqual(expect.arrayContaining([
        expect.objectContaining({ identity: expect.objectContaining({ kind: 'job', executionId: execution.id }),
          state: 'completed', resultOutcome: 'succeeded' }),
      ]))
      const resolution = await f.jobStore().acceptJobTerminal(ref, execution.id)
      expect(resolution.value).toMatchObject({ resolution: 'succeeded', execution: { executionId: execution.id } })
      expect(resolution.value.acceptedResultDigest).toBeDefined()
      expect(await f.jobStore().observeJobState(ref, execution.id)).toEqual(observed)
      const accepted = await snapshot(f)
      expect(accepted.state.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          state: expect.objectContaining({ workflowNodeId: f.node.id, lifecycle: 'succeeded' }),
          resolution: resolution.value,
          acceptedResultDigest: resolution.value.acceptedResultDigest,
        }),
      ]))

      await f.restart()
      expect(await f.jobStore().observeJobState(ref, execution.id)).toEqual(observed)
      expect(await f.jobStore().acceptJobTerminal(ref, execution.id)).toEqual(resolution)
      expect(await f.jobStore().prepareJob(ref)).toEqual({ kind: 'resolved', resolution })
      expect(await snapshot(f)).toEqual(accepted)
      expect((await f.db.pool.query('select id from job_executions where workspace_id=$1', [f.run.workspaceId])).rows)
        .toEqual([{ id: execution.id }])

      const denied = await f.credential([{ actions: ['runs:read'],
        scope: { workspaceIds: [f.run.workspaceId], workflowIds: ['another-workflow'] } }])
      const blocked = await f.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.snapshot,
        { protocolVersion: 1, scope: f.scope }, denied.token)
      expect(blocked.result?.isError).toBe(true)
      expect(graphRpcValue(blocked.result)).toMatchObject({ error: { code: 'GRAPH_READ_ACCESS_DENIED' } })
      expect(await snapshot(f)).toEqual(accepted)
    })
  }, 120000)

  it('rejects a missing Job execution source on MCP readback and refuses to repair it on replay', async () => {
    await withJob(async f => {
      const ref = { nodeId: f.node.id, occurrence: null }
      const preparation = await f.jobStore().prepareJob(ref)
      assert.equal(preparation.kind, 'preparation')
      if (preparation.kind !== 'preparation') throw new Error('Expected Job preparation')
      const prepared = await snapshot(f)
      const executionId = preparation.preparation.executionId
      const removed = await f.db.pool.query(`delete from run_graph_sources
        where run_id=$1 and source_kind='execution' and source_id=$2 returning source_id`, [f.run.id, executionId])
      expect(removed.rows).toEqual([{ source_id: executionId }])
      const response = await f.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.snapshot, { protocolVersion: 1, scope: f.scope })
      expect(response.status).toBe(200)
      expect(response.result?.isError, JSON.stringify(graphRpcValue(response.result))).toBe(true)
      expect(graphRpcValue(response.result)).toMatchObject({ error: { code: 'GRAPH_INVARIANT_VIOLATION' } })
      await expect(f.jobStore().prepareJob(ref)).rejects.toMatchObject({ code: 'GRAPH_INVARIANT_VIOLATION' })
      const head = await f.db.pool.query('select head_sequence::text as sequence from run_graph_heads where run_id=$1',
        [f.run.id])
      expect(head.rows).toEqual([{ sequence: prepared.asOfSequence }])
      const sources = await f.db.pool.query(`select source_id from run_graph_sources
        where run_id=$1 and source_kind='execution' and source_id=$2`, [f.run.id, executionId])
      expect(sources.rows).toEqual([])
    })
  }, 120000)

  it('rolls back a Job state mutation without a matching publication source', async () => {
    await withJob(async f => {
      const execution = await f.admitJob()
      const before = await snapshot(f)
      await expect(f.owner.oneShotConnection().transaction(async sql => {
        await openRunGraphPublication(sql, f.scope, readPublicProjectionLocked)
        const next = { ...execution, process: { ...execution.process, phase: 'running' },
          startedAt: execution.createdAt }
        await sql.query('update job_executions set record=$2::jsonb where id=$1',
          [execution.id, JSON.stringify(next)])
      })).rejects.toMatchObject({ code: 'GRAPH_INVARIANT_VIOLATION' })
      expect(await snapshot(f)).toEqual(before)
      expect(await f.jobs.repository.execution(f.owner.oneShotConnection(), f.run.workspaceId, execution.id))
        .toEqual(execution)
    })
  }, 120000)

  it('rejects a second publication on the same transaction and leaves the persisted graph unchanged', async () => {
    await withJob(async f => {
      const before = await snapshot(f)
      await expect(f.owner.oneShotConnection().transaction(async sql => {
        await openRunGraphPublication(sql, f.scope, readPublicProjectionLocked)
        await openRunGraphPublication(sql, f.scope, readPublicProjectionLocked)
      })).rejects.toMatchObject({ code: 'GRAPH_TRANSACTION_NESTED' })
      expect(await snapshot(f)).toEqual(before)
    })
  }, 120000)
})
