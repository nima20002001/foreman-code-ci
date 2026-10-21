import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { WorkActivationIdentitySchema, WorkActivationInputSchema, WorkReturnSchema } from '@foreman-code/contracts/wave25'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { workReturnGroupMigration } from '../src/infrastructure/workReturnGroupMigration.js'
import { repeatId } from '../src/modules/runs/repeatResolution.js'
import { digest, text, transaction } from './eng04-migration-fixtures.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { dropStagedControlContinuationReads, finished, stageControlContinuationReads, workHandoffFixture } from './helpers/workHandoffFixture.js'

async function queuedReturnsBeforeUpgrade(count: number) {
  const db = await currentDatabase({ beforeMigration: workReturnGroupMigration.version })
  await stageControlContinuationReads(db.pool)
  let t: Awaited<ReturnType<typeof workHandoffFixture>> | undefined
  try {
    t = await workHandoffFixture(db.pool, randomUUID(), version => ({ ...version,
      definition: { ...version.definition, handoffs: { contractVersion: 1 },
        executionPolicy: { maxParallelism: 2, maxNodeExecutions: 10 },
        nodes: version.definition.nodes.map(node => {
          const configured = { ...node }
          delete configured.join
          return configured
        }),
        edges: version.definition.nodes.slice(1, count + 1).map(node => ({
          id: `review-${node.id}`, kind: 'execution', source: version.entryNodeId, target: node.id,
        })),
      } }))
    const root = await t.accept(await t.store.ensureWorkEntry(), finished(1))
    const original = WorkActivationInputSchema.parse(root.input).work.activation
    const saved = []
    for (const edge of t.version.definition.edges) {
      const admitted = await t.store.admitWorkRequest(root.id, edge.id)
      assert.equal(admitted.kind, 'accepted')
      const request = admitted.request
      const review = await t.accept(request.destinationActivationId, {
        routing: { kind: 'return', requestId: request.requestId, outcome: 'needs_changes' },
        data: { latestDeliverable: { reviewer: request.destinationNodeId }, remainingFindings: [request.destinationNodeId] },
      })
      const returnId = repeatId('work-return', review.id)
      const activationId = repeatId('work-activation', returnId)
      const returned = WorkReturnSchema.parse({ scope: original.scope, returnId, requestId: request.requestId,
        sourceActivationId: request.destinationActivationId, sourceExecutionId: review.id,
        requesterActivationId: original.activationId, continuationActivationId: activationId,
        acceptedResultDigest: digest(review.result), outcome: 'needs_changes',
        latestDeliverable: { reviewer: request.destinationNodeId }, remainingFindings: [request.destinationNodeId],
        returnedAt: review.finishedAt })
      const activation = WorkActivationIdentitySchema.parse({ scope: original.scope, activationId,
        workflowNodeId: root.workflowNodeId, lineageId: original.lineageId, cause: { kind: 'work_return', returnId } })
      await transaction(db.pool, async sql => {
        await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
          cause_kind,cause_id,state,record) values($1,$2,$3,$4,'work_return',$5,'queued',$6::jsonb)`,
        [activationId, t!.run.id, t!.version.id, root.workflowNodeId, returnId, text(activation)])
        await sql.query(`insert into run_work_returns(return_id,run_id,request_id,source_activation_id,source_execution_id,
          requester_continuation_activation_id,result_digest,outcome,record)
          values($1,$2,$3,$4,$5,$6,$7,'needs_changes',$8::jsonb)`,
        [returnId, t!.run.id, request.requestId, request.destinationActivationId, review.id,
          activationId, digest(review.result), text(returned)])
        await sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
          values($1,'backend','work_handoff_returned',$2,$3,$4::jsonb),
            ($1,'backend','work_requester_reactivated',$2,$3,$5::jsonb)`,
        [t!.run.id, review.id, review.finishedAt,
          text({ returnId, requestId: request.requestId, relationshipId: request.relationshipId,
            outcome: 'needs_changes', continuationActivationId: activationId }),
          text({ activationId, requesterNodeId: root.workflowNodeId, returnId })])
      })
      saved.push({ activation, returned, review })
    }
    await dropStagedControlContinuationReads(db.pool)
    await applyApplicationMigrations(db.pool)
    await t.restart()
    return { db, t, saved, close: async () => { await t!.close(); await db.close() } }
  } catch (error) {
    await t?.close()
    await db.close()
    throw error
  }
}

describe.runIf(postgresEnabled)('queued per-return continuations across an upgrade', () => {
  it('dispatches an already queued continuation when its reviewer task replays after restart', async () => {
    const f = await queuedReturnsBeforeUpgrade(1)
    try {
      const saved = f.saved[0]!
      expect(await f.t.route(saved.review)(saved.returned.sourceActivationId)).toEqual([saved.activation.activationId])
      const input = await f.t.input(saved.activation.activationId)
      expect(input.work).toMatchObject({ kind: 'work_return', returned: saved.returned })
      expect(input.work).not.toHaveProperty('returns')
      await f.t.restart()
      expect(await f.t.route(saved.review)(saved.returned.sourceActivationId)).toEqual([saved.activation.activationId])
      expect(await f.t.input(saved.activation.activationId)).toEqual(input)
      const events = (await f.db.pool.query<{ payload: unknown }>(
        `select payload from run_activity where run_id=$1 and kind='work_requester_reactivated'`, [f.t.run.id])).rows
      expect(events).toEqual([{ payload: { activationId: saved.activation.activationId,
        requesterNodeId: saved.activation.workflowNodeId, returnId: saved.returned.returnId } }])
    } finally { await f.close() }
  }, 120_000)

  it('binds two unbound queued continuations separately without grouping their feedback', async () => {
    const f = await queuedReturnsBeforeUpgrade(2)
    try {
      expect(f.saved).toHaveLength(2)
      const inputs = []
      for (const saved of f.saved) {
        const input = await f.t.input(saved.activation.activationId)
        expect(input.work).toMatchObject({ kind: 'work_return', returned: saved.returned })
        expect(input.work).not.toHaveProperty('returns')
        inputs.push(input)
      }
      await f.t.restart()
      for (const [index, saved] of f.saved.entries()) {
        expect(await f.t.route(saved.review)(saved.returned.sourceActivationId)).toEqual([saved.activation.activationId])
        expect(await f.t.input(saved.activation.activationId)).toEqual(inputs[index])
      }
      const persisted = (await f.db.pool.query<{ record: unknown }>(
        `select record from run_work_activations where run_id=$1 and cause_kind='work_return'
          order by activation_id`, [f.t.run.id])).rows.map(row => row.record)
      expect(persisted).toEqual(f.saved.map(saved => saved.activation)
        .sort((left, right) => left.activationId.localeCompare(right.activationId)))
    } finally { await f.close() }
  }, 120_000)
})
