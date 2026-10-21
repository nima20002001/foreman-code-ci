import assert from 'node:assert/strict'
import { expect } from 'vitest'
import { WorkActivationInputSchema, makeCurrentWorkflowFixture, parseWorkHandoffResult } from '@foreman-code/contracts/wave25'
import { finished } from './workHandoffFixture.js'
import { runWorkHandoffWithRestart, workHandoffRuntimeFixture } from './workHandoffRuntimeFixture.js'

export async function releasesRevisedJoinAfterExhaustion({ restart }: { restart: boolean }) {
  const definition = makeCurrentWorkflowFixture(`join-exhausted-${restart}`, 'parallel')
  const sourceId = definition.version.entryNodeId
  const joinId = definition.version.definition.nodes[3]!.id
  definition.version.definition.handoffs = { contractVersion: 1 }
  definition.version.definition.executionPolicy = { maxParallelism: 3, maxNodeExecutions: 30 }
  definition.version.definition.nodes.push({ id: 'reviewer', name: 'Reviewer',
    agentId: definition.version.definition.nodes[3]!.agentId })
  definition.version.definition.edges[3]!.maxWorkHandoffsPerRun = 1
  definition.version.definition.edges.push({ id: 'a-reviewer', kind: 'execution', source: sourceId, target: 'reviewer' })
  const f = await workHandoffRuntimeFixture(definition, (nodeId, request) => {
    const { work } = WorkActivationInputSchema.parse(request.input)
    if (work.kind === 'limit_denial') return { routing: { kind: 'finish' },
      data: { latestDeliverable: { revision: 2 }, remainingFindings: ['incoming review exhausted'] } }
    let revision = 1
    if (work.kind === 'work_return') revision = 2
    else if (work.kind === 'work_request') {
      revision = (parseWorkHandoffResult(work.acceptedSourceResult).data.latestDeliverable as { revision: number }).revision
    } else if (work.kind === 'join') {
      revision = (parseWorkHandoffResult(work.sources[0]!.acceptedSourceResult).data.latestDeliverable as { revision: number }).revision
    }
    if (nodeId === 'reviewer') {
      assert.equal(work.kind, 'work_request')
      return { routing: { kind: 'return', requestId: work.request.requestId,
        outcome: revision === 1 ? 'needs_changes' : 'accepted' },
      data: { latestDeliverable: { revision }, remainingFindings: revision === 1 ? ['revise'] : [] } }
    }
    return finished(revision)
  })
  try {
    const runtime = await runWorkHandoffWithRestart(f, restart, (execution) => {
      const { work } = WorkActivationInputSchema.parse(execution.input)
      return work.kind === 'limit_denial'
    })
    expect(await runtime.runs.get(f.f.run.id)).toMatchObject({ executionState: 'waiting', outcome: 'pending' })
    const joins = (await f.db.pool.query<{ record: unknown }>(
      `select e.record from harness_executions e join run_work_activations a
       on a.activation_id=e.work_activation_id where e.run_id=$1 and a.workflow_node_id=$2
       order by a.activation_sequence`, [f.f.run.id, joinId])).rows
    expect(joins).toHaveLength(2)
    const first = WorkActivationInputSchema.parse((joins[0]!.record as { input: unknown }).input)
    const revised = WorkActivationInputSchema.parse((joins[1]!.record as { input: unknown }).input)
    assert.equal(first.work.kind, 'join')
    assert.equal(revised.work.kind, 'join')
    expect(first.work.sources).toHaveLength(2)
    expect(revised.work.sources).toHaveLength(1)
    expect(revised.work.sources[0]!.request.relationshipId).toBe(definition.version.definition.edges[2]!.id)
    expect(revised.work.activation.activationId).not.toBe(first.work.activation.activationId)
    const before = { ...f.provider.counts }
    await runtime.engine.start(f.f.run.id)
    expect(f.provider.counts).toEqual(before)
    expect((await f.db.pool.query('select run_id from run_work_direction_waits where run_id=$1',
      [f.f.run.id])).rowCount).toBe(1)
  } finally { await f.close() }
}
