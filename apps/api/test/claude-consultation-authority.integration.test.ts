import { describe, expect, it } from 'vitest'
import { inspect } from 'node:util'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { createPostgresClaudeInteractionBridge } from '../src/modules/harnesses/claudeSdk/domainAuthority.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { workflowChatCall, workflowChatTarget } from './helpers/workflowChatRequests.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('Claude consultation callback authority', () => {
  it('admits the exact mailbox subject while its delegation execution is closed and revokes it after the reply', async () => {
    const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
      node === 'master' ? { select: ['build'] } : {}))
    const configuration: ClaudeHarnessConfiguration = { harness: 'claude', model: 'fixture', authMode: 'subscription',
      configDirectory: '/fixture/profile', permissionMode: 'default', sandbox: 'danger-full-access', tools: ['Read'],
      permissionRules: [], instructions: '', mcpServers: {} }
    let domain: ReturnType<typeof createPostgresClaudeInteractionBridge> | undefined
    const admissions: unknown[] = []
    const admissionErrors: unknown[] = []
    const f = await currentOperatorIntegration({ executionChat: true, fixture: hierarchyRuntimeFixture(),
      approvalNodeIds: [], collaborationPorts: {}, managerFactory: (context, getOwner) => {
        const manager = provider.connection(context)
        if (context.purpose === 'consultation') {
          const attach = manager.attachSession.bind(manager)
          manager.attachSession = async (session, start, signal) => {
            const binding = { kind: 'workflow' as const, runId: context.runId!, executionId: context.executionId,
              attempt: context.attempt!, getOwner, consultation: context.consultation! }
            domain = createPostgresClaudeInteractionBridge({ database: f.db.pool, binding, configuration,
              manager: { nativeCallbackContext: () => undefined } })
            admissions.push(await domain.callbackAdmission().catch(error => { admissionErrors.push(error); throw error }))
            const forgedBinding = { ...binding, consultation: { ...binding.consultation, consultationId: 'different-consultation' } }
            const forged = createPostgresClaudeInteractionBridge({ database: f.db.pool, binding: forgedBinding,
              configuration, manager: { nativeCallbackContext: () => undefined } })
            await expect(forged.callbackAdmission()).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
            forged.bridge.close()
            return attach(session, start, signal)
          }
        }
        return manager
      } })
    const drive = f.engine.start(f.f.run.id).catch(error => error)
    try {
      await provider.entered('builder')
      const target = await workflowChatTarget(f, 'master')
      const sent = await workflowChatCall(f, 'agent_chat_send', { commandId: 'claude-consultation',
        target, intent: 'next_turn', content: 'Explain the delegated work.', attachments: [] })
      expect(sent, inspect({ sent, admissions, admissionErrors }, { depth: 8 })).not.toMatchObject({ state: 'failed' })
      expect(admissions).toEqual([{ ownerPrincipalId: f.authorizationPrincipalId,
        attemptId: expect.stringMatching(/^consultation:/) }])
      await expect.poll(async () => (await f.db.pool.query('select state from run_coordinator_consultations where run_id=$1',
        [f.f.run.id])).rows[0]?.state).toBe('completed')
      await expect(domain!.callbackAdmission()).rejects.toMatchObject({ code: 'AUTH_REVOKED' })
      expect(provider.consultations).toHaveLength(1)
      expect((await f.runs.listRepeatExecutions(f.f.run.id)).filter(row => row.execution.workflowNodeId === 'master'))
        .toHaveLength(1)
    } finally { domain?.bridge.close(); provider.releaseAll(); await f.stop(); await drive; await f.close() }
  }, 60_000)
})
