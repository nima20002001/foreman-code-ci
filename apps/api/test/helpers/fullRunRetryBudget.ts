import { describe, expect, it } from 'vitest'
import { RunStartV3ResultSchema } from '@foreman-code/contracts/wave25'
import { attempts, describeRetryBudget, occurrences, sameSlot } from './retryBudget.js'
import {
  executionRows, fullRunInput, readback, recoveryFixture, toolValue, assertOriginalFailure,
  type Form,
} from './eng06DRecovery.js'

export function describeFullRunRetryBudget(
  forms: Form[],
  transports: Array<'http' | 'mcp'> = ['http', 'mcp'],
) {
  describeRetryBudget('full-Run retry budget', () => {
    describe.each(forms)('%s full-Run retry is a separate authorization and identity', (form) => {
      it.each(transports)('%s Start replay creates only one NEW Run with a fresh technical budget', async (via) => {
        const f = await recoveryFixture(form, () => 'retryable_failure')
        try {
          f.launch(); await f.settled()
          const old = await readback(f), oldRows = await executionRows(f)
          await f.restart()
          const input = await fullRunInput(f)
          const start = async () => {
            if (via === 'mcp') return RunStartV3ResultSchema.parse(toolValue(await f.transport.client.callTool({ name: 'run_start', arguments: input })))
            const response = await f.transport.app.inject({ method: 'POST',
              url: `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/runs`,
              headers: { authorization: `Bearer ${f.base.writer.token}` }, payload: input })
            expect(response.statusCode, response.body).toBeGreaterThanOrEqual(200)
            expect(response.statusCode, response.body).toBeLessThan(300)
            return RunStartV3ResultSchema.parse(response.json())
          }
          const accepted = await start(), replayed = await start()
          expect(accepted.accepted).toBe(true); expect(accepted.replayed).toBe(false)
          expect(accepted.run.id).not.toBe(old.record.run.id)
          expect(replayed.replayed).toBe(true); expect(replayed.run.id).toBe(accepted.run.id)
          expect(accepted.run.input).toEqual(old.record.run.input)
          expect(accepted.run.workflowVersionId).toBe(old.record.run.workflowVersionId)
          expect(accepted.run.agentConfigurationVersionIds).toEqual(old.record.run.agentConfigurationVersionIds)
          await f.settled(accepted.run.id)
          const fresh = await readback(f, accepted.run.id), newRows = await executionRows(f, accepted.run.id)
          expect(fresh.record.run.outcome).toBe('failed')
          expect(attempts(newRows), JSON.stringify({ rows: newRows.map((row) => row.execution), diagnostics: f.diagnostics() })).toEqual([1, 2, 3]); sameSlot(newRows)
          for (const row of newRows) await assertOriginalFailure(f, row.execution.id, true)
          expect(newRows.every((row) => !oldRows.some((oldRow) => oldRow.execution.id === row.execution.id))).toBe(true)
          expect(await readback(f)).toEqual(old)
          expect(f.provider.counts.starts).toBe(6)
          expect(await occurrences(f, accepted.run.id)).toHaveLength(form === 'repeat' ? 1 : 0)
          if (form === 'repeat') expect(newRows[0]!.input.occurrence!.identity.occurrenceId)
            .not.toBe(oldRows[0]!.input.occurrence!.identity.occurrenceId)
          expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows).toHaveLength(2)
          expect(f.shutdownErrors).toEqual([])
        } finally { await f.close() }
      }, 90000)
    })
  })
}
