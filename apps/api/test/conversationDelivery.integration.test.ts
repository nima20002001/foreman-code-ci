import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatDeliveryReceipt, DeliveryTarget, SessionControlRequest } from '@foreman-code/contracts'
import { conversationDeliveryFixture } from '../src/modules/conversations/conversationDelivery.test-support.js'

describe('common conversation delivery through authenticated public services', () => {
  let f: Awaited<ReturnType<typeof conversationDeliveryFixture>>
  beforeEach(async () => { f = await conversationDeliveryFixture() })
  afterEach(async () => { await f.close() })

  async function target(kind: 'agent' | 'operator'): Promise<Extract<DeliveryTarget, { kind: 'agent_conversation' | 'operator_conversation' }>> {
    if (kind === 'operator') return { kind: 'operator_conversation', conversationId: (await f.operator.create(f.owner)).id }
    const state = await f.agent.read(f.owner, f.scope.workspaceId, f.query)
    if (!state.deliveryTarget || state.deliveryTarget.kind !== 'agent_conversation') throw new Error('Expected an exact cold candidate.')
    return state.deliveryTarget
  }
  async function retained(selected: DeliveryTarget, id: string): Promise<ChatDeliveryReceipt> {
    const read = await f.feature.router.read(f.owner, { target: selected, receiptId: id })
    const receipt = read.receipts[0]
    if (!receipt) throw new Error('Expected the retained exact receipt.')
    return receipt
  }
  async function waitState(selected: DeliveryTarget, id: string, state: ChatDeliveryReceipt['state']) {
    await vi.waitFor(async () => {
      await f.feature.router.read(f.owner, { target: selected })
      expect((await retained(selected, id)).state).toBe(state)
    })
  }
  const send = (selected: DeliveryTarget, commandId: string, content: string, sessionMode?: 'regular' | 'plan') =>
    f.feature.router.send(f.owner, { target: selected, commandId, content, intent: 'next_turn', ...(sessionMode ? { sessionMode } : {}) })
  async function mode(selected: DeliveryTarget, value: 'regular' | 'plan') {
    if (selected.kind !== 'agent_conversation' && selected.kind !== 'operator_conversation') throw new Error('Expected a conversation.')
    const state = selected.kind === 'agent_conversation'
      ? await f.agent.readSessionControls(f.owner, f.scope.workspaceId, selected.conversationId)
      : await f.operator.readSessionControls(selected.conversationId, f.owner)
    const request: SessionControlRequest = { kind: 'mode', requestId: `mode-${value}-${state.revision}`, mode: value, expectedRevision: state.revision }
    return selected.kind === 'agent_conversation'
      ? f.agent.changeSessionControls(f.owner, f.scope.workspaceId, selected.conversationId, request)
      : f.operator.changeSessionControls(selected.conversationId, request, f.owner)
  }

  it('reads a cold candidate without creating rows and rolls back cold creation with an invalid sibling', async () => {
    const selected = await target('agent')
    if (selected.kind !== 'agent_conversation') throw new Error('Expected Agent target.')
    const manager = f.native(selected.conversationId)
    expect((await f.agent.read(f.owner, f.scope.workspaceId, f.query)).conversation).toBeNull()
    expect((await f.agent.read(f.owner, f.scope.workspaceId, f.query)).deliveryTarget).toEqual(selected)
    const invalid = { ...selected, conversationId: 'unadmitted-other-candidate', agent: { ...selected.agent, workflowNodeId: 'missing-node' } }
    await expect(f.feature.service.post(f.owner, { ...f.scope, commandId: 'atomic-cold-post', body: '@Agent @Missing', cardIds: [],
      mentions: [{ workflowNodeId: selected.agent.workflowNodeId, start: 0, end: 6 }, { workflowNodeId: 'missing-node', start: 7, end: 15 }],
      deliveries: [{ workflowNodeId: selected.agent.workflowNodeId, target: selected, intent: 'auto' },
        { workflowNodeId: 'missing-node', target: invalid, intent: 'auto' }] })).rejects.toBeDefined()
    expect((await f.agent.read(f.owner, f.scope.workspaceId, f.query)).conversation).toBeNull()
    expect((await f.feature.service.read(f.owner, f.scope)).items).toEqual([])
    expect(manager.sessions).toBe(0)
    const post = await f.feature.service.post(f.owner, { ...f.scope, commandId: 'valid-cold-post', body: '@Agent preserve this body', cardIds: [],
      mentions: [{ workflowNodeId: selected.agent.workflowNodeId, start: 0, end: 6 }],
      deliveries: [{ workflowNodeId: selected.agent.workflowNodeId, target: selected, intent: 'auto' }] })
    await Promise.all([f.feature.router.drainPrepared(), f.feature.router.drainPrepared()])
    await waitState(selected, post.receipts[0]!.id, 'completed')
    expect(manager.sessions).toBe(1)
    expect(manager.inputs).toHaveLength(1)
    expect(manager.inputs[0]!.prompt).toContain(post.post.id)
    expect(manager.inputs[0]!.prompt).toContain('workflow_chat_post')
    expect((await f.feature.service.read(f.owner, f.scope, { commandId: 'valid-cold-post' })).items[0]!.body).toBe('@Agent preserve this body')
    await f.feature.projector.projectCommittedFacts()
    const linked = (await f.feature.service.read(f.owner, f.scope)).items.find(item => item.replyToPostId === post.post.id)
    expect(linked).toMatchObject({ body: 'final answer' })
    expect((await retained(selected, post.receipts[0]!.id)).replyPostId).toBe(linked!.id)
  })

  it('emits one committed Group queue cancellation and remains quiet for replay and already-canceled selection', async () => {
    const selected = await target('agent')
    if (selected.kind !== 'agent_conversation') throw new Error('Expected Agent target.')
    f.native(selected.conversationId).autoFinish = false
    const active = await send(selected, 'queue-cancel-active', 'Keep active')
    await waitState(selected, active.id, 'accepted')
    const post = await f.feature.service.post(f.owner, { ...f.scope, commandId: 'queue-cancel-post', body: '@Agent queued question', cardIds: [],
      mentions: [{ workflowNodeId: selected.agent.workflowNodeId, start: 0, end: 6 }],
      deliveries: [{ workflowNodeId: selected.agent.workflowNodeId, target: selected, intent: 'next_turn' }] })
    await f.feature.router.drainPrepared()
    const events: unknown[] = []
    const unsubscribe = f.feature.service.events.subscribe(f.scope.workflowId, event => events.push(event))
    try {
      await f.feature.service.cancel(f.owner, f.scope, post.receipts[0]!.id, 'one-group-cancel')
      const count = events.length
      expect(count).toBe(1)
      await f.feature.service.cancel(f.owner, f.scope, post.receipts[0]!.id, 'one-group-cancel')
      await f.feature.service.cancel(f.owner, f.scope, post.receipts[0]!.id, 'already-canceled-noop')
      expect(events).toHaveLength(count)
      expect(f.native(selected.conversationId).cancelCalls).toBe(0)
    } finally { unsubscribe() }
  })

  it.each(['agent', 'operator'] as const)('%s adopts one cold Plan input, steers only its qualified same-mode native turn, and queues mode changes', async kind => {
    const selected = await target(kind), manager = f.native(selected.conversationId)
    manager.autoFinish = false
    const first = await send(selected, `${kind}-plan-first`, 'Make a plan', 'plan')
    await waitState(selected, first.id, 'accepted')
    const read = await f.feature.router.read(f.owner, { target: selected })
    if (!('delivery' in read)) throw new Error('Expected qualified conversation readback.')
    expect(read.delivery).toMatchObject({ state: 'active', capabilities: { steer: 'native_expected_turn' }, nativeTurnId: 'turn-1' })
    const controls = kind === 'agent' ? await f.agent.readSessionControls(f.owner, f.scope.workspaceId, selected.conversationId)
      : await f.operator.readSessionControls(selected.conversationId, f.owner)
    expect(controls.appliedMode).toBe('plan')
    const steered = await f.feature.router.send(f.owner, { target: selected, commandId: `${kind}-same-plan`, intent: 'auto',
      content: 'Include the migration', sessionMode: 'plan', expectedNativeTurnId: 'turn-1' })
    expect(steered.appliedIntent).toBe('steer')
    expect(manager.steers).toHaveLength(1)
    expect(manager.steers[0]!.expectedTurnId).toBe('turn-1')
    const queued = await f.feature.router.send(f.owner, { target: selected, commandId: `${kind}-regular-next`, intent: 'auto',
      content: 'Then execute it', sessionMode: 'regular', expectedNativeTurnId: 'turn-1' })
    expect(queued).toMatchObject({ state: 'queued', appliedIntent: 'next_turn' })
    expect(manager.inputs).toHaveLength(1)
    await expect(f.feature.router.send(f.owner, { target: selected, commandId: `${kind}-wrong-turn`, intent: 'steer',
      content: 'Too late', sessionMode: 'plan', expectedNativeTurnId: 'other-turn' })).rejects.toBeDefined()
    expect(manager.steers).toHaveLength(1)
  })

  it.each(['agent', 'operator'] as const)('%s preserves its queue on active-only Stop and replays the original control without stopping the next input', async kind => {
    const selected = await target(kind), manager = f.native(selected.conversationId)
    manager.autoFinish = false
    const a = await send(selected, `${kind}-a`, 'First')
    await waitState(selected, a.id, 'accepted')
    const b = await send(selected, `${kind}-b`, 'Cancel only this queued input')
    const c = await send(selected, `${kind}-c`, 'Preserve this queued input')
    const canceled = await f.feature.router.cancel(f.owner, { target: selected, commandId: `${kind}-cancel-b`, selection: { kind: 'one', receiptId: b.id } })
    expect(canceled.affectedReceiptIds).toEqual([b.id])
    expect((await retained(selected, b.id)).state).toBe('canceled')
    const stop = { target: selected, commandId: `${kind}-stop-a`, scope: 'active_turn' as const, expectedNativeTurnId: 'turn-1' }
    await f.feature.router.stop(f.owner, stop)
    await waitState(selected, c.id, 'accepted')
    expect(manager.inputs.map(input => input.correlationId)).toHaveLength(2)
    expect(manager.inputs[1]!.prompt).toContain('Preserve this queued input')
    expect(manager.cancelCalls).toBe(1)
    const replay = await f.feature.router.stop(f.owner, stop)
    expect(replay).toMatchObject({ replayed: true, state: 'completed' })
    expect(manager.cancelCalls).toBe(1)
    await expect(f.feature.router.cancel(f.owner, { target: selected, commandId: `${kind}-race-cancel-c`,
      selection: { kind: 'one', receiptId: c.id } })).rejects.toMatchObject({ code: 'CHAT_QUEUE_TARGET_SETTLED' })
    expect(manager.cancelCalls).toBe(1)
    const d = await send(selected, `${kind}-d`, 'Another queued input')
    const all = await f.feature.router.cancel(f.owner, { target: selected, commandId: `${kind}-cancel-rest`, selection: { kind: 'all' } })
    expect(all.affectedReceiptIds).toEqual([d.id])
    expect((await retained(selected, c.id)).state).toBe('accepted')
    await expect(f.feature.router.send(f.owner, { target: selected, commandId: stop.commandId, intent: 'next_turn', content: 'Reused control identity' }))
      .rejects.toMatchObject({ code: 'CHAT_COMMAND_CONFLICT' })
    await expect(f.feature.router.stop(f.owner, { target: selected, commandId: `${kind}-a`, scope: 'active_turn' }))
      .rejects.toMatchObject({ code: 'CHAT_COMMAND_CONFLICT' })
  })

  it.each(['agent', 'operator'] as const)('%s keeps the settings revision stable when native preference key order differs', async kind => {
    const selected = await target(kind)
    const manager = f.native(selected.conversationId)
    manager.autoFinish = false
    const sent = await send(selected, `${kind}-stable-preferences`, 'Keep this turn active', 'plan')
    await waitState(selected, sent.id, 'accepted')
    const readControls = () => kind === 'agent'
      ? f.agent.readSessionControls(f.owner, f.scope.workspaceId, selected.conversationId)
      : f.operator.readSessionControls(selected.conversationId, f.owner)
    const before = await readControls()
    const applied = before.applied!
    expect(applied).not.toBeNull()
    await manager.configureSessionPreferences({ contextProfile: applied.contextProfile, contextBudget: applied.contextBudget,
      autoCompactTokens: applied.autoCompactTokens, autoCompact: applied.autoCompact })
    const after = await readControls()
    expect(after.applied).toEqual(before.applied)
    expect(after.revision).toBe(before.revision)
    expect((await readControls()).revision).toBe(before.revision)
  })

  it.each(['agent', 'operator'] as const)('%s retains queued mode and input proof across header changes and owner restart', async kind => {
    const selected = await target(kind), manager = f.native(selected.conversationId)
    manager.autoFinish = false
    manager.loseTurnObservation = true
    const a = await send(selected, `${kind}-unknown-original`, 'First original input', 'plan')
    await waitState(selected, a.id, 'unknown')
    const b = await send(selected, `${kind}-pinned-queue`, 'Queued under Plan', 'plan')
    await mode(selected, 'regular')
    const originalCorrelation = manager.inputs[0]!.correlationId
    await f.restart()
    manager.finish(originalCorrelation)
    manager.autoFinish = true
    if (kind === 'agent') await f.agent.recover(); else await f.operator.reconcileActive()
    await waitState(selected, b.id, 'completed')
    expect(manager.inputs.filter(input => input.correlationId === originalCorrelation)).toHaveLength(1)
    expect(manager.inputs[1]).toMatchObject({ mode: 'plan' })
    const controls = kind === 'agent' ? await f.agent.readSessionControls(f.owner, f.scope.workspaceId, selected.conversationId)
      : await f.operator.readSessionControls(selected.conversationId, f.owner)
    expect(controls.desiredMode).toBe('regular')
    expect(controls.appliedMode).toBe('plan')
    const settled = await retained(selected, a.id)
    expect(settled.state).toBe('completed')
    expect(settled.errorCode).toBeUndefined()
  })

  it.each(['agent', 'operator'] as const)('%s orders A, interrupt I, B, C without overlap while closure is unconfirmed', async kind => {
    const selected = await target(kind), manager = f.native(selected.conversationId)
    manager.autoFinish = false; manager.cancelAcknowledged = false
    const a = await send(selected, `${kind}-ordered-a`, 'Ordered A')
    await waitState(selected, a.id, 'accepted')
    const b = await send(selected, `${kind}-ordered-b`, 'Ordered B')
    const c = await send(selected, `${kind}-ordered-c`, 'Ordered C')
    const interrupt = await f.feature.router.send(f.owner, { target: selected, commandId: `${kind}-ordered-i`,
      intent: 'interrupt_and_send', content: 'Urgent I', expectedNativeTurnId: 'turn-1' })
    expect(interrupt.state).toBe('queued')
    await f.feature.router.read(f.owner, { target: selected })
    expect(manager.inputs).toHaveLength(1)
    expect((await retained(selected, b.id)).state).toBe('queued')
    expect((await retained(selected, c.id)).state).toBe('queued')
    // Only positive original-owner terminal evidence releases the reserved next input.
    manager.finish(manager.inputs[0]!.correlationId)
    // The cancellation detached its observer; emulate the application's scheduled native recovery.
    if (kind === 'operator') await f.operator.reconcileActive()
    await waitState(selected, interrupt.id, 'accepted')
    expect(manager.inputs[1]!.prompt).toContain('Urgent I')
    manager.finish(manager.inputs[1]!.correlationId)
    await waitState(selected, b.id, 'accepted')
    expect(manager.inputs[2]!.prompt).toContain('Ordered B')
    manager.finish(manager.inputs[2]!.correlationId)
    await waitState(selected, c.id, 'accepted')
    expect(manager.inputs[3]!.prompt).toContain('Ordered C')
    expect(manager.inputs).toHaveLength(4)
  })

  it.each(['agent', 'operator'] as const)('%s keeps the latest oversized hydrated user message discoverable with exact full history', async kind => {
    const selected = await target(kind), manager = f.native(selected.conversationId)
    const first = await send(selected, `${kind}-small-before-large`, 'Earlier small input')
    await waitState(selected, first.id, 'completed')
    manager.pauseBeforeInput = true
    const content = '🙂\\"exact original input\n'.repeat(16_000)
    await send(selected, `${kind}-large-visible`, content)
    const state = kind === 'agent' ? await f.agent.readConversation(f.owner, f.scope.workspaceId, selected.conversationId)
      : await f.operator.get(selected.conversationId, f.owner)
    expect(state.hasEarlierMessages).toBe(true)
    const latest = state.messages.at(-1)!
    expect(latest).toMatchObject({ role: 'user', requestId: `${kind}-large-visible`, truncation: { truncated: true } })
    expect(Buffer.byteLength(JSON.stringify(state.messages))).toBeLessThanOrEqual(256 * 1024)
    const history = kind === 'agent' ? await f.agent.history(f.owner, f.scope.workspaceId, selected.conversationId, undefined, 50)
      : await f.operator.history(selected.conversationId, f.owner, { limit: 50 })
    const messages = 'messages' in history ? history.messages : history.entries.map(entry => entry.message)
    expect(messages.find(message => message.id === latest.id)?.content).toBe(content)
  })

  it.each(['agent', 'operator'] as const)('%s recovers a cold Codex bind/observation loss from the original input without creating or sending again', async kind => {
    const selected = await target(kind), manager = f.native(selected.conversationId)
    manager.lostInitialObservation = true
    const receipt = await send(selected, `${kind}-lost-first-bind`, 'The first input may already have completed', 'plan')
    await vi.waitFor(() => expect(manager.inputs).toHaveLength(1))
    await f.restart()
    if (kind === 'agent') await f.agent.recover(); else await f.operator.reconcileActive()
    await waitState(selected, receipt.id, 'completed')
    expect(manager.sessions).toBe(1)
    expect(manager.inputs).toHaveLength(1)
    expect((await retained(selected, receipt.id)).errorCode).toBeUndefined()
  })

  it('enforces exact owner/scope read authority on every retained body branch and never broadens narrowed credentials', async () => {
    const selected = await target('operator')
    const receipt = await send(selected, 'owner-private-input', 'Private retained input')
    const foreign = (await f.access.issue({ name: 'Another reader', audience: 'operator', expiresAt: new Date(Date.now() + 60_000),
      grants: [{ scope: {}, actions: ['operator_chat:read', 'agent_chat:read'] }] })).principal
    await expect(f.feature.router.read(foreign, { target: selected, receiptId: receipt.id })).rejects.toMatchObject({ status: 404 })
    await expect(f.feature.router.read(foreign, { target: selected, deliveryInputs: { receiptId: receipt.id } })).rejects.toMatchObject({ status: 404 })
    const narrowed = { ...f.owner, grants: [{ scope: {}, actions: ['operator_chat:read' as const, 'agent_chat:read' as const] }] }
    await expect(f.feature.router.send(narrowed, { target: selected, commandId: 'narrowed-send', intent: 'next_turn', content: 'Denied' }))
      .rejects.toMatchObject({ status: 403 })
    await expect(f.feature.router.cancel(narrowed, { target: selected, commandId: 'narrowed-cancel', selection: { kind: 'all' } }))
      .rejects.toMatchObject({ status: 403 })
    expect((await f.feature.router.read(narrowed, { target: selected, receiptId: receipt.id })).receipts[0]!.id).toBe(receipt.id)
    const agent = await target('agent')
    if (agent.kind !== 'agent_conversation') throw new Error('Expected Agent target.')
    const agentReceipt = await send(agent, 'scoped-agent-input', 'An exact node input')
    await expect(f.feature.router.read(f.owner, { target: { ...agent, agent: { ...agent.agent, workflowNodeId: 'different-node' } },
      deliveryInputs: { receiptId: agentReceipt.id } })).rejects.toMatchObject({ code: 'CHAT_TARGET_SCOPE_MISMATCH' })
  })
})
