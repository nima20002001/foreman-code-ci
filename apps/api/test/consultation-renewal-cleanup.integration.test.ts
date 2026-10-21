import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatDeliveryReceiptSchema } from '@foreman-code/contracts'
import { WorkerCredentialService } from '../src/modules/access/workerCredentials.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { workflowChatCall, workflowChatTarget } from './helpers/workflowChatRequests.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { deferred } from './helpers/deferred.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('consultation setup renewal cleanup', () => {
  it('does not renew a revoked setup credential after a capacity lookup fails', async () => {
    const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
      node === 'master' ? { select: ['build'] } : {}))
    let failLookup = false
    let injected = false
    const releaseConsultation = deferred()
    const f = await currentOperatorIntegration({ fixture: hierarchyRuntimeFixture(), executionChat: true,
      approvalNodeIds: [], collaborationPorts: {}, credentialTtlMs: 60_000, managerFactory: context => {
        const manager = provider.connection(context)
        if (context.purpose === 'consultation') {
          const start = manager.startTurn.bind(manager)
          manager.startTurn = async function* (...args) {
            for await (const event of start(...args)) {
              yield event
              if (event.type === 'turn.started') await releaseConsultation.promise
            }
          }
        }
        if (context.purpose === 'consultation' && !injected) {
          const attach = manager.attachSession.bind(manager)
          manager.attachSession = async (...args) => {
            const session = await attach(...args)
            failLookup = true
            return session
          }
        }
        return manager
      } })
    const snapshot = f.runs.getRepeatSnapshot.bind(f.runs)
    vi.spyOn(f.runs, 'getRepeatSnapshot').mockImplementation(async (...args) => {
      if (failLookup) {
        failLookup = false
        injected = true
        throw new Error('The snapshot database read failed')
      }
      return snapshot(...args)
    })
    const renewal = vi.spyOn(WorkerCredentialService.prototype, 'renewForConsultation')
    const drive = f.engine.start(f.f.run.id).catch(error => error)
    try {
      await provider.entered('builder')
      const target = await workflowChatTarget(f, 'master')
      const first = ChatDeliveryReceiptSchema.parse(await workflowChatCall(f, 'agent_chat_send', { commandId: 'failed-setup', target,
        intent: 'next_turn', content: 'Explain the pending work', attachments: [] }))
      expect(first).toMatchObject({
        state: 'failed', errorCode: 'CONSULTATION_PREPARATION_FAILED',
      })
      expect(injected).toBe(true)
      expect(first.consultationId).toBeDefined()
      expect(provider.consultations).toEqual([])
      expect((await f.db.pool.query("select principal_id from worker_credential_bindings where run_id=$1 and purpose='consultation' and revoked_at is null",
        [f.f.run.id])).rows).toEqual([])
      const second = ChatDeliveryReceiptSchema.parse(await workflowChatCall(f, 'agent_chat_send', { commandId: 'after-failure', target,
        intent: 'next_turn', content: 'Explain current progress', attachments: [] }))
      expect(second).not.toMatchObject({ state: 'failed' })
      expect(second.consultationId).toBeDefined()
      await expect.poll(() => provider.consultations.length).toBe(1)
      // Wait for a real later renewal, so the failed setup's earlier deadline has also elapsed.
      await expect.poll(() => renewal.mock.calls.some(([binding]) => binding.consultationId === second.consultationId),
        { timeout: 5_000 }).toBe(true)
      expect(renewal.mock.calls.map(([binding]) => binding.consultationId)).toEqual([second.consultationId])
      expect(renewal.mock.calls.some(([binding]) => binding.consultationId === first.consultationId)).toBe(false)
    } finally {
      releaseConsultation.resolve(undefined)
      provider.releaseAll(); await f.stop(); await drive; await f.close()
    }
  }, 60_000)
})
