import assert from 'node:assert/strict'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionResult, HarnessExecution } from '@foreman-code/contracts'
import { CANONICAL_RUN_GRAPH_MCP_TOOLS, CanonicalRunGraphCurrentSchema } from '@foreman-code/contracts/wave25'
import { graphRpcValue } from './eng04-graph-composition-fixture.js'
import { InteractionService } from '../src/modules/interactions/service.js'
import { Wave25InteractionRepository } from '../src/modules/interactions/wave25/repository.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { RespondToInteractionResponseSchema, WorkDirectionRequestSchema } from '@foreman-code/contracts'
import { workDirectionInteractionId } from '../src/modules/runs/workDirectionInteraction.js'
import {
  useSettlementFixtures, timeout, handoffs, runtime, directionApi,
} from './helpers/workflowSettlementTestSupport.js'

// Native terminals and physical closure are explicit test inputs. Authenticated
// Save/MCP reads, canonical publication, SQL transactions and settlement execute.
vi.mock('../src/modules/interactions/repeatNativeSettlement.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  settleRepeatNativeExecutionLocked: vi.fn(async () => undefined),
  settleRepeatNativeExecutionWithProofLocked: vi.fn(async () => undefined),
}))

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('workflow settlement direction', () => {
  const withFixture = useSettlementFixtures()

  it.each(['finish', 'continue', 'stop'] as const)(
    'answers a direction wait through authenticated MCP using %s and preserves the findings', async (choice) => {
      await withFixture((graph) => ({ ...handoffs(1)(graph),
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
      }), async (f) => {
        const result: ExecutionResult = { outcome: 'succeeded', output: {
          routing: { kind: 'finish' }, data: { latestDeliverable: { revision: 1 }, remainingFindings: ['Review is incomplete'] },
        } }
        await runtime(f, async (execution) => {
          if (execution.state !== 'completed') await f.finish(execution.id, result)
        })()
        const api = await directionApi(f)
        try {
          const listed = await api.call('interaction_list', { runId: f.run.id, status: 'pending', limit: 10 })
          expect(listed?.isError, JSON.stringify(listed)).not.toBe(true)
          const list = graphRpcValue(listed) as { items: Array<{ id: string }>; pendingCount: number }
          expect(list.pendingCount).toBe(1)
          expect(list.items.map((item) => item.id)).toEqual([workDirectionInteractionId(f.run.id)])
          expect(graphRpcValue(await api.call('interaction_summary', { runId: f.run.id }))).toMatchObject({ pendingCount: 1 })
          const interaction = await api.repository.get(list.items[0]!.id)
          assert.ok(interaction)
          expect(graphRpcValue(await api.call('interaction_get', { interactionId: interaction.id }))).toMatchObject({
            canRespond: true, interaction: { kind: 'work_direction', status: 'pending' },
            activity: { response: { available: true, path: 'workflow_decision' } },
          })
          expect(WorkDirectionRequestSchema.parse(interaction.request).unresolved[0]?.remainingFindings)
            .toEqual(['Review is incomplete'])
          expect(interaction.responseOptions.map((option) => option.optionId)).toEqual(['finish', 'continue', 'stop'])
          const response = { interactionId: interaction.id, optionId: choice, expectedRevision: interaction.revision,
            ...(choice === 'continue' ? { response: { direction: 'Complete the review and fix its findings' } } : {}) }
          const reader = await f.credential([{ actions: ['interactions:read'], scope: { runIds: [f.run.id] } }])
          expect((await api.call('interaction_respond', response, reader.token))?.isError).toBe(true)
          const wrongScope = await f.credential([{ actions: ['interactions:read', 'interactions:respond'],
            scope: { runIds: ['other-run'] } }])
          expect((await api.call('interaction_get', { interactionId: interaction.id }, wrongScope.token))?.isError).toBe(true)
          expect((await api.call('interaction_respond', response, wrongScope.token))?.isError).toBe(true)
          const responderOnly = await f.credential([{ actions: ['interactions:read', 'interactions:respond'],
            scope: { runIds: [f.run.id] } }])
          if (choice !== 'finish') expect((await api.call('interaction_respond', response, responderOnly.token))?.isError).toBe(true)
          expect((await api.call('interaction_respond', { ...response, expectedRevision: interaction.revision + 1 }))?.isError).toBe(true)
          expect((await api.call('interaction_respond', { ...response, response: { direction: ' ' } }))?.isError).toBe(true)
          expect((await api.repository.get(interaction.id))?.status).toBe('pending')
          if (choice === 'continue') {
            const acceptStart = api.start.getMockImplementation()!
            api.start.mockImplementationOnce(async (...args) => {
              await acceptStart(...args)
              throw new Error('Start reply unavailable')
            })
            expect((await api.call('interaction_respond', response))?.isError).toBe(true)
            expect(await api.repository.get(interaction.id)).toMatchObject({ status: 'delivered',
              continuationRunId: expect.any(String) })
            const restarted = new InteractionService(new Wave25InteractionRepository(f.db.pool),
              new PostgresApprovalBudgetRepository(f.db.pool), {} as never, async () => undefined)
            restarted.useWorkDirectionActions({ start: api.start, wake: async () => undefined })
            expect((await restarted.recover({ limit: 20 })).errors).toEqual([])
            expect((await restarted.recover({ limit: 20 })).errors).toEqual([])
          }
          const accepted = await api.call('interaction_respond', response)
          expect(accepted?.isError, JSON.stringify(accepted)).not.toBe(true)
          const decided = RespondToInteractionResponseSchema.parse(graphRpcValue(accepted))
          expect(decided).toMatchObject({ replayed: choice === 'continue',
            interaction: { status: 'delivered', selectedOptionId: choice } })
          if (choice === 'stop') {
            expect((await f.db.pool.query('select stop_requested_at from runs where id=$1', [f.run.id]))
              .rows[0]?.stop_requested_at).toEqual(expect.any(Date))
            expect((await f.db.pool.query('select pending from run_cleanup_intents where run_id=$1', [f.run.id]))
              .rows[0]?.pending).toBe(true)
          }
          await f.restart()
          if (choice === 'stop') {
            await f.lifecycle.settleRun(true, false)
            expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'canceled' })
          } else {
            expect(await f.store.completeWorkRun()).toBe('completed')
            expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'succeeded', result })
          }
          const replay = await api.call('interaction_respond', response)
          expect(replay?.isError, JSON.stringify(replay)).not.toBe(true)
          expect(graphRpcValue(replay)).toMatchObject({ replayed: true, interaction: decided.interaction })
          const persisted = await api.repository.get(interaction.id)
          expect(graphRpcValue(await api.call('interaction_get', { interactionId: interaction.id })))
            .toMatchObject({ interaction: persisted, canRespond: false })
          expect(graphRpcValue(await api.call('interaction_summary', { runId: f.run.id }))).toMatchObject({ pendingCount: 0 })
          const current = CanonicalRunGraphCurrentSchema.parse(graphRpcValue(
            await api.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.current, { protocolVersion: 1, scope: f.scope })))
          expect(current.state.run).toMatchObject({ executionState: 'completed', pendingInteractionCount: 0 })
          expect(current.state.executions).toHaveLength(1)
          expect((await f.db.pool.query<{ record: HarnessExecution }>('select record from harness_executions where run_id=$1',
            [f.run.id])).rows[0]?.record.result).toEqual(result)
          if (choice === 'continue') {
            expect(decided.interaction.continuationRunId).toEqual(expect.any(String))
            const continuation = (await f.db.pool.query<{ record: unknown }>(`
              select r.record from run_work_direction_responses d join runs r on r.id=d.continuation_run_id
              where d.interaction_id=$1`, [interaction.id])).rows[0]
            expect(continuation?.record).toMatchObject({ workflowVersionId: f.version.id,
              id: decided.interaction.continuationRunId,
              input: { workDirection: { previousRunId: f.run.id, direction: 'Complete the review and fix its findings' } } })
            expect((await f.db.pool.query('select 1 from runs where workflow_id=$1', [f.run.workflowId])).rowCount).toBe(2)
          } else expect(api.start).not.toHaveBeenCalled()
          const audit = (await f.db.pool.query<{ source: string }>(`
            select source from management_audit where principal_id=$1 and action='interaction_respond'`,
            [f.writer.principal.id])).rows
          expect(audit.some((row) => row.source === 'mcp')).toBe(true)
        } finally { await api.app.close() }
      }, 'single')
    }, timeout,
  )

})
