import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { readback, recoveryFixture, runPath, scope, toolValue, assertRecoveryReceipts } from './helpers/eng06DRecovery.js'
import { forms, parked } from './helpers/recoveryReadback.js'

afterEach(() => vi.restoreAllMocks())

// These are normal positive assertions, not expected-failure tests. In particular
// d32a361 cold cleanup requires a scoped physical-disposal callback. The helper
// simulates that external boundary, never SQL receipts, native ACKs or results.
describe.skipIf(!postgresEnabled)('Run recovery readback through HTTP and authenticated MCP', () => {
  describe.each(forms)('%s Stop during restart recovery', (form) => {
    it.each(['http', 'mcp'] as Array<'http' | 'mcp'>)('%s accepts the exact Stop and settles cleanup rather than returning 409 forever', async (via) => {
      const f = await recoveryFixture(form, () => 'park')
      try {
        f.launch(); const before = await parked(f)
        // A dead API runs no shutdown step: neither its restart intent nor its close callback.
        vi.spyOn(f.runtime.native, 'preserveActiveForRestart').mockResolvedValue(true)
        await f.restart({ mode: 'crash' })
        const input = { ...scope(f), commandId: randomUUID() }
        const send = async () => {
          if (via === 'mcp') return toolValue(await f.transport.client.callTool({ name: 'run_stop', arguments: input }), f.diagnostics()) as {
            runId: string; status: string; replayed: boolean; processStopped: boolean }
          const response = await f.transport.app.inject({ method: 'POST', url: `${runPath(f)}/stop`,
            headers: { authorization: `Bearer ${f.base.writer.token}` }, payload: input })
          // Deliberately NOT 409/REPEAT_CLEANUP_PENDING, not it.fails, not a mock.
          expect(response.statusCode, JSON.stringify({ body: response.body, diagnostics: f.diagnostics() })).toBe(200)
          return response.json<{ runId: string; status: string; replayed: boolean; processStopped: boolean }>()
        }
        const receipt = await send()
        expect(receipt.runId).toBe(f.base.f.run.id)
        expect(['accepted', 'already_terminal']).toContain(receipt.status)
        expect(receipt.replayed).toBe(false)
        await f.settled()
        const after = await readback(f), replayed = await send()
        expect(after.record).toMatchObject({ run: { executionState: 'completed' },
          stopRequested: true, cleanupPending: false })
        expect(after.record.run.outcome).toBe('canceled')
        expect(replayed).toEqual({ ...receipt, replayed: true })
        expect(after.record.run.input).toEqual(before.record.run.input)
        expect(after.record.run.workflowVersionId).toBe(before.record.run.workflowVersionId)
        expect(after.details).toHaveLength(1)
        expect(after.details[0]!.execution.executionId).toBe(before.details[0]!.execution.executionId)
        expect(after.details[0]!.acceptedResult).toEqual({ status: 'not_accepted' })
        expect(after.details[0]!.reportedResult).toEqual({ outcome: 'canceled' })
        expect(f.provider.counts.attaches).toBe(0)
        await assertRecoveryReceipts(f, [before.details[0]!.execution.executionId], { detached: false })
        expect(f.provider.counts.starts).toBe(1); expect(f.provider.counts.sessions).toBe(1)
        expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [f.base.f.scope.workflowId])).rows).toHaveLength(1)
        expect(f.shutdownErrors).toEqual([])
      } finally { await f.close() }
    }, 90000)
  })
})
