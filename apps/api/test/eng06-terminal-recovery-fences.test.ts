import { describe, expect, it, vi } from 'vitest'
import { recoverWorkflowNativeClosure, readWorkflowClosure } from '../src/modules/interactions/workflowClosure.js'
import { recoveryDatabase, recoveryExecution } from './helpers/eng06Recovery.testSupport.js'

/** Real serialized transaction/finalizer implementation; SQL responses are a
 * protocol fake. The engine integration suite exercises real migration guards. */
describe('terminal physical recovery preserves all fences', () => {
  it.each(['succeeded', 'failed'] as const)('recovers a durable %s terminal without a Run cleanup intent', async (outcome) => {
    const t = recoveryDatabase(); t.state.fenced = false; t.state.execution = recoveryExecution('completed')
    if (outcome === 'failed') t.state.execution.result = { outcome, error: { code: 'TRANSIENT', message: 'Original provider failure', retryable: true } }
    const original = structuredClone(t.state.execution), physical = vi.fn(async () => true)
    try {
      await recoverWorkflowNativeClosure(t.owner, original, physical, new AbortController().signal, { purpose: 'terminal' })
      expect(t.state.fenced).toBe(false)
      expect(t.state.execution).toEqual(original)
      expect(await readWorkflowClosure(t.connection, original)).toBeDefined()
      await recoverWorkflowNativeClosure(t.owner, original, physical, new AbortController().signal, { purpose: 'terminal' })
      expect(physical).toHaveBeenCalledTimes(1)
      expect(t.state.inserts).toBe(1)
    } finally { await t.owner.release() }
  })

  it.each(['running', 'waiting', 'reviewer', 'prior-generation', 'no-evidence'] as const)(
    'does not claim terminal closure for %s', async (cut) => {
      const t = recoveryDatabase(); t.state.fenced = false; t.state.execution = recoveryExecution('completed')
      if (cut === 'running' || cut === 'waiting') t.state.execution = recoveryExecution(cut)
      if (cut === 'reviewer') t.state.finalized = true
      if (cut === 'prior-generation') t.state.lifetime!.prior_unclosed = true
      const physical = vi.fn(async () => cut !== 'no-evidence')
      try {
        await expect(recoverWorkflowNativeClosure(t.owner, t.state.execution, physical,
          new AbortController().signal, { purpose: 'terminal' })).rejects.toBeDefined()
        expect(t.state.proof).toBeUndefined()
        if (cut !== 'no-evidence') expect(physical).not.toHaveBeenCalled()
      } finally { await t.owner.release() }
    })

  it.each(['owner', 'generation', 'session', 'terminal', 'commit-fence'] as const)(
    'rejects %s changes across physical IO or COMMIT', async (change) => {
      const t = recoveryDatabase(); t.state.fenced = false; t.state.execution = recoveryExecution('completed')
      const execution = structuredClone(t.state.execution)
      if (change === 'commit-fence') t.state.afterInsert = () => { t.state.fence = 'new-owner' }
      try {
        await expect(recoverWorkflowNativeClosure(t.owner, execution, async () => {
          expect(t.state.active).toBe(false)
          if (change === 'owner') t.state.lost = true
          if (change === 'generation') t.state.lifetime!.generation = '72'
          if (change === 'session') t.state.session!.nativeSessionId = 'different-session'
          if (change === 'terminal') t.state.execution.result = { outcome: 'succeeded', output: 'different result' }
          return true
        }, new AbortController().signal, { purpose: 'terminal' })).rejects.toBeDefined()
        expect(t.state.proof).toBeUndefined()
      } finally { t.state.lost = false; await t.owner.release() }
    })
})
