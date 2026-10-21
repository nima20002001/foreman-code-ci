import { describe, expect, it } from 'vitest'
import { inspect } from 'node:util'
import { ChatControlReceiptSchema, ChatDeliveryReceiptSchema } from '@foreman-code/contracts'
import { WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { workflowChatCall, workflowChatTarget } from './helpers/workflowChatRequests.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { WorkflowExecutionChatService } from '../src/modules/collaboration/workflowChatService.js'
import { validateWorkflowChatAdmission } from '../src/modules/collaboration/workflowChatProduction.js'
import { readHierarchyCoordinationLocked } from '../src/modules/runs/hierarchyCoordinationRead.js'

describe.skipIf(!postgresEnabled)('workflow control recovery and parent settlement', () => {
  it.each(['canceled', 'succeeded'] as const)('settles a stopped child whose native outcome is %s and resumes its parents', async outcome => {
    const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
      node === 'master' ? { select: ['build'] } : {}), outcome)
    const f = await currentOperatorIntegration({ executionChat: true, workflowHierarchy: true,
      fixture: hierarchyRuntimeFixture(), approvalNodeIds: [], collaborationPorts: {},
      managerFactory: context => provider.connection(context) })
    let driveFailure: unknown
    const drive = f.engine.start(f.f.run.id).catch(error => { driveFailure = error; return error })
    try {
      await provider.entered('builder')
      const target = await workflowChatTarget(f, 'builder')
      if (target.kind !== 'workflow_execution') throw new Error('Expected the worker execution')
      const stopped = ChatControlReceiptSchema.parse(await workflowChatCall(f, 'agent_chat_interrupt', {
        commandId: 'stop-child', target, scope: 'active_turn',
      }))
      // The native offer is recorded as unknown until the observer proves physical closure.
      expect(stopped.state).toBe('unknown')
      await expect.poll(async () => {
        expect(driveFailure, inspect(driveFailure, { depth: 8 })).toBeUndefined()
        return { run: (await f.runs.get(f.f.run.id))?.executionState,
          execution: (await f.runs.getExecution(target.execution.executionId))?.state }
      }, { timeout: 15_000 }).toEqual({ run: 'completed', execution: 'completed' })
      expect(await drive).not.toBeInstanceOf(Error)
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ outcome: 'succeeded' })
      expect(await f.runs.getExecution(target.execution.executionId)).toMatchObject({ state: 'completed', result: { outcome } })
      const members = (await f.db.pool.query('select failure_result from run_hierarchy_group_members where failure_execution_id=$1',
        [target.execution.executionId])).rows
      expect(members).toEqual([{ failure_result: { outcome: 'failed', error: {
        code: 'WORKFLOW_TURN_STOPPED', message: 'The current work was stopped without a queued continuation.', retryable: false,
      } } }])
      expect((await f.db.pool.query('select state from run_hierarchy_groups where run_id=$1', [f.f.run.id])).rows)
        .toEqual([{ state: 'continued' }, { state: 'continued' }])
      expect(provider.cancellations).toEqual(['builder'])
      expect(await workflowChatCall(f, 'agent_chat_interrupt', {
        commandId: 'stop-child', target, scope: 'active_turn',
      })).toMatchObject({ commandId: stopped.commandId, state: 'completed' })
    } finally { provider.releaseAll(); await f.stop(); await drive; await f.close() }
  }, 60_000)

  it('recovers a committed steer after the caller loses dispatch and reconciles subsequent sweeps without resending', async () => {
    const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
      node === 'master' ? { select: ['build'] } : {}))
    const f = await currentOperatorIntegration({ executionChat: true, fixture: hierarchyRuntimeFixture(),
      approvalNodeIds: [], collaborationPorts: {}, managerFactory: context => provider.connection(context) })
    const drive = f.engine.start(f.f.run.id).catch(error => error)
    try {
      await provider.entered('builder')
      const target = await workflowChatTarget(f, 'builder')
      const owner = f.native.workflowChatOwner(f.db.pool, validateWorkflowChatAdmission)
      // The caller disappears after the service commits. The real coordinator remains available to recovery.
      const disconnected = new WorkflowExecutionChatService(f.db.pool, { owner: { ...owner,
        dispatch: async () => { throw new Error('Caller transport disconnected before dispatch') } },
        assertAttachments: async () => {},
      })
      const request = { commandId: 'recover-steer', target, intent: 'steer' as const, content: 'Keep the original task and include the edge case.', attachments: [] }
      const receipt = await disconnected.deliver(f.writer.principal, request)
      expect(receipt.state).toBe('submitting')
      expect(provider.steers).toEqual([])
      await f.engine.reconcile(error => { throw error })
      expect(provider.steers).toEqual([receipt.id])
      expect(await disconnected.deliver(f.writer.principal, request)).toMatchObject({ id: receipt.id, state: 'accepted' })
      await f.engine.reconcile(error => { throw error })
      expect(provider.steers).toEqual([receipt.id])
    } finally { provider.releaseAll(); await f.stop(); await drive; await f.close() }
  }, 60_000)

  it('keeps a held execution usable after Stop reports that no native turn is active', async () => {
    const f = await currentOperatorIntegration({ executionChat: true, fixture: hierarchyRuntimeFixture({ maximum: 12 }),
      approvalNodeIds: [], collaborationPorts: {}, outputFor: (node, request) => coordinationOutput(node, request, {
        select: [], findings: WorkActivationInputSchema.parse(request.input).work.kind === 'hierarchy_direction' ? [] : ['Choose scope'],
      }) })
    const drive = f.engine.start(f.f.run.id).catch(error => error)
    try {
      await expect.poll(async () => (await readHierarchyCoordinationLocked(f.db.pool, f.f.run.id, f.f.version))?.state,
        { timeout: 15_000 }).toBe('waiting_for_direction')
      const held = (await readHierarchyCoordinationLocked(f.db.pool, f.f.run.id, f.f.version))!.direction!.execution
      const target = await workflowChatTarget(f, 'master', held.executionId)
      expect(await workflowChatCall(f, 'agent_chat_interrupt', { commandId: 'stop-unstarted', target, scope: 'active_turn' }))
        .toMatchObject({ state: 'completed', errorCode: 'NO_ACTIVE_TURN' })
      const input = ChatDeliveryReceiptSchema.parse(await workflowChatCall(f, 'agent_chat_send', {
        commandId: 'direction-after-stop', target, intent: 'next_turn', content: 'Deliver the scoped result.', attachments: [],
      }))
      expect(input.target).toEqual(target)
      expect(await drive).not.toBeInstanceOf(Error)
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ outcome: 'succeeded' })
      expect(f.provider.startedExecutions.filter(id => id === held.executionId)).toHaveLength(1)
    } finally { await f.stop(); await drive; await f.close() }
  }, 60_000)
})
