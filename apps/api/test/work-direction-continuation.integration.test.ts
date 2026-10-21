import assert from 'node:assert/strict'
import { describe, expect, it, vi } from 'vitest'
import { CanonicalRunGraphCurrentSchema, CANONICAL_RUN_GRAPH_MCP_TOOLS,
  type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { graphRpcValue } from './eng04-graph-composition-fixture.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { requestRepeatRunStop } from '../src/modules/runs/repeatLifecycle.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { workDirectionInteractionId } from '../src/modules/runs/workDirectionInteraction.js'
import { deferred } from './helpers/deferred.js'
import {
  useSettlementFixtures, timeout, handoffs, runtime, directionApi, type Fixture,
} from './helpers/workflowSettlementTestSupport.js'

// The fixture supplies completed native work; direction decisions, Start,
// Stop, canonical publication and cleanup run against PostgreSQL.
vi.mock('../src/modules/interactions/repeatNativeSettlement.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  settleRepeatNativeExecutionLocked: vi.fn(async () => undefined),
  settleRepeatNativeExecutionWithProofLocked: vi.fn(async () => undefined),
}))

async function waitForDirection(f: Fixture) {
  await runtime(f, async (execution) => {
    if (execution.state !== 'completed') await f.finish(execution.id, {
      outcome: 'succeeded', output: { routing: { kind: 'finish' },
        data: { latestDeliverable: { revision: 1 }, remainingFindings: ['Review is incomplete'] } },
    })
  })()
}

async function stopAndCleanUp(f: Fixture, api: Awaited<ReturnType<typeof directionApi>>) {
  await requestRepeatRunStop(f.db.pool, f.run.id, async () => {
    requireAuthorization(f.writer.principal, 'runs:stop', f.scope)
  })
  await api.repository.cancelPendingForRun(f.run.id)
  await f.lifecycle.settleRun(true, false)
  await f.lifecycle.finishCleanup()
  expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'canceled' })
  expect((await f.db.pool.query('select pending from run_cleanup_intents where run_id=$1', [f.run.id])).rows)
    .toEqual([{ pending: false }])
}

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('work direction continuation and Stop', () => {
  const withFixture = useSettlementFixtures()
  const graph = (value: WorkflowDefinitionV3): WorkflowDefinitionV3 => ({
    ...handoffs(1)(value), executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
  })

  it('rejects a continuation when Stop finishes during Start preparation', async () => {
    await withFixture(graph, async (f) => {
      await waitForDirection(f)
      const preparing = deferred()
      const releasePreparation = deferred()
      const api = await directionApi(f, { ...repeatStartPublication, placementAdmission: {
        prepare: async () => {
          preparing.resolve()
          await releasePreparation.promise
          return undefined
        },
      } })
      let response: ReturnType<typeof api.call> | undefined
      try {
        const interaction = await api.repository.get(workDirectionInteractionId(f.run.id))
        assert.ok(interaction)
        response = api.call('interaction_respond', { interactionId: interaction.id,
          expectedRevision: interaction.revision, optionId: 'continue', response: { direction: 'Finish the review' } })
        await preparing.promise
        expect((await api.repository.get(interaction.id))?.status).toBe('delivery_pending')
        await stopAndCleanUp(f, api)
        expect((await api.repository.get(interaction.id))?.status).toBe('canceled')
        releasePreparation.resolve()
        const reply = await response
        expect(reply?.isError).toBe(true)
        expect((await f.db.pool.query('select id from runs where workflow_id=$1', [f.run.workflowId])).rows)
          .toEqual([{ id: f.run.id }])
        expect((await f.db.pool.query('select continuation_run_id from run_work_direction_responses where interaction_id=$1',
          [interaction.id])).rows).toEqual([{ continuation_run_id: null }])
        expect((await f.db.pool.query(`select result from management_command_receipts
          where principal_id=$1 and operation='run.start' and command_id=$2`,
        [f.writer.principal.id, interaction.id])).rows).toEqual([])
        expect(graphRpcValue(await api.call('interaction_get', { interactionId: interaction.id })))
          .toMatchObject({ interaction: { status: 'canceled' }, canRespond: false })
      } finally {
        releasePreparation.resolve()
        await response
        await api.app.close()
      }
    }, 'single')
  }, timeout)

  it('commits the delivered direction and continuation link before returning the Start reply', async () => {
    await withFixture(graph, async (f) => {
      await waitForDirection(f)
      const api = await directionApi(f)
      const reader = await f.credential([{ actions: ['interactions:read', 'runs:read'],
        scope: { runIds: [f.run.id] } }])
      const started = deferred<string>()
      const releaseReply = deferred()
      const acceptStart = api.start.getMockImplementation()!
      api.start.mockImplementationOnce(async (...args) => {
        const result = await acceptStart(...args)
        started.resolve(result.run.id)
        await releaseReply.promise
        return result
      })
      let response: ReturnType<typeof api.call> | undefined
      try {
        const interaction = await api.repository.get(workDirectionInteractionId(f.run.id))
        assert.ok(interaction)
        response = api.call('interaction_respond', { interactionId: interaction.id,
          expectedRevision: interaction.revision, optionId: 'continue', response: { direction: 'Finish the review' } })
        const continuationRunId = await started.promise
        expect(await api.repository.get(interaction.id)).toMatchObject({ status: 'delivered', continuationRunId })
        expect(graphRpcValue(await api.call('interaction_get', { interactionId: interaction.id }, reader.token)))
          .toMatchObject({ interaction: { status: 'delivered', continuationRunId }, canRespond: false })
        expect((await f.db.pool.query('select continuation_run_id from run_work_direction_responses where interaction_id=$1',
          [interaction.id])).rows).toEqual([{ continuation_run_id: continuationRunId }])
        const graphReply = await api.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.current,
          { protocolVersion: 1, scope: f.scope }, reader.token)
        expect(graphReply?.isError, JSON.stringify(graphReply)).not.toBe(true)
        const current = CanonicalRunGraphCurrentSchema.parse(graphRpcValue(graphReply))
        expect(current.state.run.pendingInteractionCount).toBe(0)
        await stopAndCleanUp(f, api)
        expect((await api.repository.get(interaction.id))?.status).toBe('delivered')
        releaseReply.resolve()
        expect((await response)?.isError).not.toBe(true)
        expect((await f.db.pool.query('select id from runs where workflow_id=$1 order by id', [f.run.workflowId])).rows)
          .toEqual([f.run.id, continuationRunId].sort().map((id) => ({ id })))
      } finally {
        releaseReply.resolve()
        await response
        await api.app.close()
      }
    }, 'single')
  }, timeout)
})
