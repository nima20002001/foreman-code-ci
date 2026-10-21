import { expect, it } from 'vitest'
import { ChatSendRequestSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { PostgresChatDeliveryRepository } from '../src/modules/workflow-chat/deliveryRepository.js'
import { createWorkflowExecutionChatService } from '../src/modules/collaboration/workflowChatProduction.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { coordinationOutput, hierarchyRuntimeFixture } from './helpers/hierarchyRuntimeFixture.js'
import { workflowChatTarget } from './helpers/workflowChatRequests.js'

it.each(['steer', 'interrupt_and_send'] as const)('rejects prepared %s input after its retained native owner changes', async intent => {
  const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
    node === 'master' ? { select: ['build'] } : {}))
  const f = await currentOperatorIntegration({ executionChat: true, fixture: hierarchyRuntimeFixture(),
    approvalNodeIds: [], collaborationPorts: {}, managerFactory: context => provider.connection(context) })
  const drive = f.engine.start(f.f.run.id).catch(error => error)
  try {
    await provider.entered('builder')
    const target = await workflowChatTarget(f, 'builder')
    const chat = createWorkflowExecutionChatService(f.db.pool, f.native)
    const deliveries = new PostgresChatDeliveryRepository(f.db.pool)
    for (const field of ['nativeSessionId', 'ownerRequestId', 'nativeTurnId'] as const) {
      const request = { ...ChatSendRequestSchema.parse({ target, intent, content: 'Address the accepted turn' }),
        commandId: `${intent}-${field}` }
      const qualified = await chat.qualify(f.writer.principal, request)
      expect(qualified.ownerBinding[field]).toBeTruthy()
      // A prepared command retains the owner from before a same-execution turn transition.
      const retained = { ...qualified, ownerBinding: { ...qualified.ownerBinding, [field]: `previous-${field}` } }
      await withTransaction(f.db.pool, sql => deliveries.prepareLocked(sql, f.writer.principal.id, request, retained))
      await expect(chat.deliver(f.writer.principal, request)).rejects.toMatchObject({ code: 'CHAT_TARGET_CHANGED' })
      expect(await deliveries.find(f.writer.principal.id, request.commandId)).toMatchObject({ ownerAdmission: 'prepared' })
      expect((await chat.read(f.writer.principal, { target })).receipts).toEqual([])
      expect(provider.steers).toEqual([])
      expect(provider.cancellations).toEqual([])
    }
  } finally { provider.releaseAll(); await f.stop(); await drive; await f.close() }
}, 60_000)

it('reads the current owner turn through HTTP and authenticated MCP without inferring it from history', async () => {
  const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
    node === 'master' ? { select: ['build'] } : {}))
  const f = await currentOperatorIntegration({ executionChat: true, fixture: hierarchyRuntimeFixture(),
    approvalNodeIds: [], collaborationPorts: {}, managerFactory: context => provider.connection(context) })
  const drive = f.engine.start(f.f.run.id).catch(error => error)
  try {
    await provider.entered('builder')
    const target = await workflowChatTarget(f, 'builder')
    const chat = createWorkflowExecutionChatService(f.db.pool, f.native)
    const qualification = await chat.qualify(f.writer.principal,
      ChatSendRequestSchema.parse({ target, intent: 'steer', content: 'Inspect owner' }))
    const base = `/api/workspaces/${f.f.run.workspaceId}/workflows/${f.f.run.workflowId}/execution-chat`
    const read = await f.app.inject({ method: 'POST', url: `${base}/read`,
      headers: { authorization: `Bearer ${f.writer.token}` }, payload: { target } })
    expect(read.statusCode, read.body).toBe(200)
    expect(read.json()).toMatchObject({ nativeTurnId: qualification.ownerBinding.nativeTurnId, messages: [] })
    const mcp = await f.client.callTool({ name: 'agent_chat_read', arguments: { target } })
    expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true)
    expect(decodeMcpToolResult(mcp)).toMatchObject({ nativeTurnId: qualification.ownerBinding.nativeTurnId })
  } finally { provider.releaseAll(); await f.stop(); await drive; await f.close() }
}, 60_000)
