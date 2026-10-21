import { describe, expect, it } from 'vitest'
import { ChatDeliveryReceiptSchema, EngineChatReadbackSchema, WorkflowExecutionChatResolutionSchema } from '@foreman-code/contracts'
import { WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { readHierarchyCoordinationLocked } from '../src/modules/runs/hierarchyCoordinationRead.js'
import { graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { openHierarchyEvents } from './helpers/hierarchyHttpStream.js'

describe.skipIf(!postgresEnabled)('Run-owned execution chat over HTTP and MCP', () => {
  it('releases the held direction execution once and preserves command identity and historical targets', async () => {
    const f = await currentOperatorIntegration({ executionChat: true, workflowHierarchy: true,
      fixture: hierarchyRuntimeFixture({ maximum: 12 }), approvalNodeIds: [], collaborationPorts: {},
      outputFor: (node, request) => coordinationOutput(node, request, { select: [],
        findings: WorkActivationInputSchema.parse(request.input).work.kind === 'hierarchy_direction'
          ? [] : ['Choose the delivery scope'] }) })
    let driveError: unknown
    let stream: Awaited<ReturnType<typeof openHierarchyEvents>> | undefined
    const drive = f.engine.start(f.f.run.id).catch(error => { driveError = error })
    const base = `/api/workspaces/${f.f.run.workspaceId}/workflows/${f.f.run.workflowId}/execution-chat`
    try {
      await expect.poll(async () => (await readHierarchyCoordinationLocked(f.db.pool, f.f.run.id, f.f.version))?.state,
        { timeout: 30_000 }).toBe('waiting_for_direction')
      const coordination = (await readHierarchyCoordinationLocked(f.db.pool, f.f.run.id, f.f.version))!
      const executionId = coordination.direction!.execution.executionId
      const query = new URLSearchParams({ workflowNodeId: 'master', runId: f.f.run.id, executionId })
      const resolved = await f.app.inject({ method: 'GET', url: `${base}/target?${query}`, headers: graphHeaders(f.writer.token) })
      expect(resolved.statusCode, resolved.body).toBe(200)
      const selection = WorkflowExecutionChatResolutionSchema.parse(resolved.json())
      if (selection.kind !== 'selected' || selection.target.kind !== 'workflow_execution') throw new Error('Expected held execution')
      expect(selection.target.execution.executionId).toBe(executionId)
      const target = selection.target
      stream = await openHierarchyEvents(f.address,
        `/api/management/workspaces/${f.f.run.workspaceId}/workflows/${f.f.run.workflowId}/hierarchy/events?runId=${f.f.run.id}`,
        f.writer.token)
      const initialEvent = await stream.next()
      const before = (await f.db.pool.query('select count(*)::int as count from run_hierarchy_reports where run_id=$1', [f.f.run.id])).rows
      const send = { commandId: 'direction-input', target, intent: 'next_turn', content: 'Deliver the scoped result.', attachments: [] }
      const denied = await f.access.issue({ name: 'Read-only chat Operator', audience: 'operator',
        grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [f.f.run.workspaceId] } }] })
      const refusal = await graphRpc(f.app, denied.token, 'tools/call', { name: 'agent_chat_send', arguments: send })
      expect(refusal.result?.isError).toBe(true)
      expect((await f.db.pool.query('select id from run_chat_commands where run_id=$1', [f.f.run.id])).rows).toEqual([])
      const response = await graphRpc(f.app, f.writer.token, 'tools/call', { name: 'agent_chat_send', arguments: send })
      expect(response.result?.isError, JSON.stringify(response)).not.toBe(true)
      const receipt = ChatDeliveryReceiptSchema.parse(graphRpcValue(response.result))
      expect(receipt.target).toEqual(target)
      const changedEvent = await stream.next()
      expect(changedEvent.cursor).not.toBe(initialEvent.cursor)
      expect(changedEvent.revision).toBe(initialEvent.revision)
      await drive
      expect(driveError).toBeUndefined()
      expect(f.provider.startedExecutions.filter(id => id === executionId)).toHaveLength(1)
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ outcome: 'succeeded' })
      const read = await f.app.inject({ method: 'POST', url: `${base}/read`, headers: graphHeaders(f.writer.token), payload: { target } })
      expect(read.statusCode, read.body).toBe(200)
      const readback = EngineChatReadbackSchema.parse(read.json())
      expect(readback.receipts).toContainEqual(expect.objectContaining({ id: receipt.id, state: 'completed', target }))
      const replay = await graphRpc(f.app, f.writer.token, 'tools/call', { name: 'agent_chat_send', arguments: send })
      expect(replay.result?.isError, JSON.stringify(replay)).not.toBe(true)
      expect(ChatDeliveryReceiptSchema.parse(graphRpcValue(replay.result))).toMatchObject({ id: receipt.id, target, state: 'completed' })
      expect(f.provider.startedExecutions.filter(id => id === executionId)).toHaveLength(1)
      const conflict = await graphRpc(f.app, f.writer.token, 'tools/call', {
        name: 'agent_chat_send', arguments: { ...send, content: 'Different command content' } })
      expect(conflict.result?.isError).toBe(true)
      expect(JSON.stringify(conflict)).toContain('COMMAND_CONFLICT')
      const old = await graphRpc(f.app, f.writer.token, 'tools/call', { name: 'agent_chat_send', arguments: {
        ...send, commandId: 'old-source', target: { ...target, execution: coordination.sourceExecution! } } })
      expect(old.result?.isError).toBe(true)
      expect((await f.db.pool.query('select count(*)::int as count from run_hierarchy_reports where run_id=$1', [f.f.run.id])).rows)
        .toEqual(before)
      expect((await f.db.pool.query<{ native_prompt: string }>(
        'select native_prompt from run_chat_commands where id=$1', [receipt.id])).rows[0]!.native_prompt)
        .toContain('Deliver the scoped result.')
    } finally { await stream?.close(); await f.stop(); await drive; await f.close() }
  }, 60_000)

  it('cancels one or all queued inputs without interrupting the selected native execution', async () => {
    const f = await currentOperatorIntegration({ executionChat: true, fixture: hierarchyRuntimeFixture(),
      approvalNodeIds: ['build'], collaborationPorts: {}, outputFor: (node, request) =>
        coordinationOutput(node, request, node === 'master' ? { select: ['build'] } : {}) })
    const call = (name: string, args: unknown) => graphRpc(f.app, f.writer.token, 'tools/call', { name, arguments: args })
    try {
      await f.engine.start(f.f.run.id)
      const resolution = await call('agent_chat_read', { resolve: { workspaceId: f.f.run.workspaceId,
        workflowId: f.f.run.workflowId, workflowNodeId: 'build', runId: f.f.run.id } })
      expect(resolution.result?.isError, JSON.stringify(resolution)).not.toBe(true)
      const selected = WorkflowExecutionChatResolutionSchema.parse(graphRpcValue(resolution.result))
      if (selected.kind !== 'selected' || selected.target.kind !== 'workflow_execution') throw new Error('Expected the live child')
      const target = selected.target
      const original = await f.runs.getExecution(target.execution.executionId)
      const queued = []
      for (const commandId of ['first-queued', 'second-queued']) {
        const response = await call('agent_chat_send', { commandId, target, intent: 'next_turn', content: commandId, attachments: [] })
        expect(response.result?.isError, JSON.stringify(response)).not.toBe(true)
        const receipt = ChatDeliveryReceiptSchema.parse(graphRpcValue(response.result))
        expect(receipt.state).toBe('queued')
        queued.push(receipt)
      }
      const cancel = { commandId: 'cancel-first', target, selection: { kind: 'one', receiptId: queued[0]!.id } }
      const first = await call('agent_chat_cancel_queued', cancel)
      expect(first.result?.isError, JSON.stringify(first)).not.toBe(true)
      expect(graphRpcValue(first.result)).toMatchObject({ state: 'completed', affectedReceiptIds: [queued[0]!.id] })
      const read = () => call('agent_chat_read', { target })
      const intermediate = EngineChatReadbackSchema.parse(graphRpcValue((await read()).result))
      expect(intermediate.receipts.map(receipt => receipt.state)).toEqual(['canceled', 'queued'])
      const replay = await call('agent_chat_cancel_queued', cancel)
      expect(graphRpcValue(replay.result)).toMatchObject({ replayed: true, state: 'completed' })
      const all = await call('agent_chat_cancel_all_queued', { commandId: 'cancel-rest', target, selection: { kind: 'all' } })
      expect(all.result?.isError, JSON.stringify(all)).not.toBe(true)
      const after = EngineChatReadbackSchema.parse(graphRpcValue((await read()).result))
      expect(after.receipts.map(receipt => receipt.state)).toEqual(['canceled', 'canceled'])
      expect(await f.runs.getExecution(target.execution.executionId)).toEqual(original)
      expect(f.provider.startedExecutions.filter(id => id === target.execution.executionId)).toHaveLength(1)
    } finally { await f.stop(); await f.close() }
  }, 60_000)
})
