import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkflowNativeProofRecord } from '../src/modules/runs/workflowNativeProof.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { readUntil } from './helpers/observableCondition.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('workflow native proof transaction', () => {
  it.each([false, true])('persists the original proof atomically with context admission rejected=%s', async reject => {
    let observed: WorkflowNativeProofRecord | undefined
    let transactionId: string | undefined
    let running: Promise<unknown> | undefined
    const f = await checkpointRuntimeFixture(1, 1, { approvalNodeIds: [],
      nativeSourcePersisted: async (sql, _evidence, proof) => {
        if (proof.original.type !== 'history') return
        const row = (await sql.query<{ record: WorkflowNativeProofRecord }>(
          'select record from workflow_native_proofs where proof_id=$1', [proof.proofId])).rows[0]
        expect(row?.record).toEqual(proof)
        if (!observed) {
          observed = proof
          transactionId = (await sql.query<{ id: string }>('select pg_current_xact_id()::text as id')).rows[0]!.id
        }
        if (reject) throw new Error('Context admission denied')
      } })
    try {
      running = f.engine.start(f.f.run.id).then(() => ({ finished: true }), error => ({ error }))
      await readUntil(async () => observed, value => value !== undefined,
        { timeoutMs: 10_000, description: 'proof reaching context admission' })
      if (reject) {
        await readUntil(async () => (await f.db.pool.query<{ status: string }>(
          'select pg_xact_status($1::xid8) as status', [transactionId])).rows[0]!.status,
        status => status === 'aborted', { timeoutMs: 2000, description: 'rejected admission transaction rollback' })
      } else {
        await expect(running).resolves.toEqual({ finished: true })
        expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      }
      expect(observed).toBeDefined()
      const rows = await f.db.pool.query<{ record: WorkflowNativeProofRecord }>(
        'select record from workflow_native_proofs where proof_id=$1', [observed!.proofId])
      expect(rows.rows).toEqual(reject ? [] : [{ record: observed }])
    } finally {
      await f.close()
      await running
    }
  }, 60_000)
})
