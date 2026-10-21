import { expect, it, vi } from 'vitest'
import { NativeSessionLaneSchema } from '@foreman-code/contracts'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { prepareCoordinationWorkflow } from './helpers/coordinationWorkflow.js'
import { memoryWorkflow, type MemoryRuntime } from './helpers/memoryWorkflow.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import type { WorkflowNativeProofRecord } from '../src/modules/runs/workflowNativeProof.js'

it.runIf(postgresEnabled).each([false, true])('publishes settled output under its authenticated writer (retry=%s)', async retry => {
  let settled = false
  let attempts = 0
  let original: WorkflowNativeProofRecord | undefined
  let verified = 0
  const runtime: MemoryRuntime = await currentOperatorIntegration({ fixture: memoryWorkflow('single'),
    insertRun: false, approvalNodeIds: [],
    outputFor: () => ({ text: JSON.stringify({ routing: { kind: 'finish' },
      data: { latestDeliverable: 'Complete', remainingFindings: [] }, summary: 'Completed work.',
      board: { kind: 'none', reason: 'no_access' } }) }),
    managerFactory: () => {
      const manager = runtime.provider.connection()
      return { ...manager, async settleTurn(session, correlation, signal) {
        attempts += 1
        if (retry && attempts === 1) throw new Error('Settlement transport interrupted')
        settled = true
        return manager.reconcile(session, correlation, signal)
      } }
    },
    nativeSourcePersisted: async (tx, _evidence, proof) => {
      if (proof.original.type !== 'history' || !proof.original.history.terminalTurn) return
      if (!settled) { original = structuredClone(proof); return }
      const row = (await tx.query<{ record: unknown }>('select record from native_session_lanes where id=$1',
        [proof.lane!.id])).rows[0]!
      const writer = NativeSessionLaneSchema.parse(row.record)
      // Artifact admission requires the persisted proof and authenticated capture
      // to describe the same writer; the original terminal stays immutable.
      expect(proof.lane!.token).toBe(writer.leaseToken)
      expect(proof.lane!.connectionGeneration).toBe(writer.connectionGeneration)
      if (!retry) expect(proof.lane).toEqual(original!.lane)
      verified += 1
    },
  })
  try {
    const prepared = await prepareCoordinationWorkflow(runtime)
    const started = await prepared.start()
    await vi.waitFor(async () => expect((await runtime.runs.get(started.run.id))?.outcome).toBe('succeeded'),
      { timeout: 30000, interval: 50 })
    expect(attempts).toBe(retry ? 2 : 1)
    expect(verified).toBe(1)
    expect(runtime.provider.startedExecutions).toHaveLength(1)
    expect(original).toBeDefined()
    const saved = await runtime.db.pool.query('select record from workflow_native_proofs where proof_id=$1', [original!.proofId])
    expect(saved.rows[0]!.record).toEqual(original)
  } finally { await runtime.close() }
}, 60000)
