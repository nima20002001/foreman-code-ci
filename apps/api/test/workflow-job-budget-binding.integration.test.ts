import assert from 'node:assert/strict'
import { describe, expect, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { readWorkflowJobSourceLocked } from '../src/modules/jobs/workflowSource.js'
import { snapshot, timeout, useWorkflowJobBudgetFixture } from './helpers/workflowJobBudgetFixture.js'

vi.mock('../src/modules/interactions/repeatNativeSettlement.js', async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  settleRepeatNativeExecutionLocked: vi.fn(async () => undefined),
  settleRepeatNativeExecutionWithProofLocked: vi.fn(async () => undefined),
}))

describe.skipIf(!postgresEnabled)('accepted Job result binding', () => {
  const withJob = useWorkflowJobBudgetFixture()
  it.each([false, true])('binds a typed Job output to an Agent after reconciliation (repeat entry: %s)', async repeated => {
    await withJob((graph, job) => {
      const entry = graph.entryNodeId
      assert.ok(entry, 'Expected an Agent entry node')
      const nodes = repeated ? graph.nodes : [graph.nodes[0]!]
      const definition: WorkflowDefinitionV3 = { ...graph, entryNodeId: job.id, nodes: [job, ...nodes],
        requiredAgentCount: nodes.length,
        edges: [{ id: 'job-agent', kind: 'execution', source: job.id, target: entry }, ...(repeated ? graph.edges : [])],
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: repeated ? 7 : 2 } }
      return definition
    }, async f => {
      const { execution, resolution } = await f.acceptJob()
      await f.restart()
      const agent = f.version.definition.nodes.find(node => node.kind !== 'job')!
      const occurrence = repeated ? await f.store.enterBlock(f.version.definition.repeat!.blocks[0]!.id) : null
      if (repeated) assert.equal(occurrence?.kind, 'active')
      const ref = { nodeId: agent.id,
        occurrence: occurrence?.kind === 'active' ? occurrence.occurrence.identity : null }
      const admitted = await f.store.admit(ref, () => f.candidate(agent.id))
      assert.equal(admitted.kind, 'admitted')
      if (admitted.kind !== 'admitted') throw new Error('Expected downstream admission')
      const stored = await f.store.readExecution(admitted.execution.id)
      const sources = repeated ? stored.input.entry!.external : stored.input.predecessors
      expect(sources).toHaveLength(1)
      expect(sources[0]).toMatchObject({ relationshipId: 'job-agent', execution: resolution.value.execution,
        acceptedResultDigest: resolution.value.acceptedResultDigest, acceptedResult: { outcome: 'succeeded' } })
      expect(JSON.stringify(sources[0]!.acceptedResult)).toContain(execution.id)
      const persisted = await snapshot(f)
      expect(persisted.state.bindings).toEqual(expect.arrayContaining([
        expect.objectContaining({ sender: expect.objectContaining({ kind: 'job', executionId: execution.id }),
          recipient: expect.objectContaining({ executionId: admitted.execution.id }),
          acceptedResultDigest: resolution.value.acceptedResultDigest,
          kind: repeated ? 'external' : 'predecessor', relationshipId: 'job-agent' }),
      ]))
      expect((await f.jobStore().prepareJob({ nodeId: f.node.id, occurrence: null })).kind).toBe('resolved')
      expect((await f.db.pool.query('select id from job_executions where workspace_id=$1', [f.run.workspaceId])).rows).toHaveLength(1)
      await expect(f.owner.oneShotConnection().transaction(sql => readWorkflowJobSourceLocked(sql,
        { ...f.scope, runId: 'unrelated-run' }, f.version, resolution, 'job-agent')))
        .rejects.toMatchObject({ code: 'REPEAT_INPUT_NOT_ACCEPTED' })
    }, repeated ? 'repeat' : 'sequential')
  }, timeout)
})
