import { describe, expect, it } from 'vitest'
import { inspect } from 'node:util'
import { ChatDeliveryReceiptSchema } from '@foreman-code/contracts'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { workflowChatCall, workflowChatTarget } from './helpers/workflowChatRequests.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('consultation execution capacity', () => {
  it('waits for the Run slot held by a worker before offering the admitted coordinator reply', async () => {
    const saved = hierarchyRuntimeFixture()
    saved.version.definition.executionPolicy = { ...saved.version.definition.executionPolicy!, maxParallelism: 1 }
    const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
      node === 'master' ? { select: ['build'] } : {}))
    const f = await currentOperatorIntegration({ executionChat: true, fixture: saved, approvalNodeIds: [], collaborationPorts: {},
      managerFactory: context => provider.connection(context) })
    const drive = f.engine.start(f.f.run.id).catch(error => error)
    try {
      await provider.entered('builder')
      const target = await workflowChatTarget(f, 'master')
      expect(target.kind).toBe('workflow_coordinator')
      const receipt = ChatDeliveryReceiptSchema.parse(await workflowChatCall(f, 'agent_chat_send', {
        commandId: 'capacity-reply', target, intent: 'next_turn', content: 'Explain the current state.', attachments: [],
      }))
      expect(['queued', 'submitting']).toContain(receipt.state)
      expect(provider.consultations).toEqual([])
      expect(provider.maximumActive).toBe(1)
      provider.release('builder')
      await expect.poll(() => provider.consultations.length, { timeout: 15_000 }).toBe(1)
      const driven = await drive
      expect(driven, inspect(driven, { depth: 8 })).not.toBeInstanceOf(Error)
      expect(provider.maximumActive).toBe(1)
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ outcome: 'succeeded' })
    } finally { provider.releaseAll(); await f.stop(); await drive; await f.close() }
  }, 60_000)
})
