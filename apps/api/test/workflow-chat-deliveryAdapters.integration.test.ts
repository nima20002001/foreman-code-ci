import { randomUUID } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/client'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { ChatControlReceiptSchema, ChatDeliveryReceiptSchema, CreateOperatorConversationResponseSchema,
  DeliveryTargetSchema, EngineChatReadbackSchema, GetOperatorConversationResponseSchema, SendOperatorMessageResponseSchema } from '@foreman-code/contracts'
import { AgentChatSendResponseSchema, ReadAgentChatResponseSchema, type ReadAgentChatRequestSchema } from '@foreman-code/contracts/agent-chat'
import { deliveryAdaptersFixture } from '../src/modules/workflow-chat/deliveryAdapters.test-support.js'

type Fixture = Awaited<ReturnType<typeof deliveryAdaptersFixture>>
type Call = Awaited<ReturnType<Client['callTool']>>
const fixtures: Fixture[] = []
const retained = z.object({ target: DeliveryTargetSchema, receipts: z.array(ChatDeliveryReceiptSchema).optional(),
  deliveryInputs: ReadAgentChatResponseSchema.shape.deliveryInputs.unwrap() })
const receiptRead = z.object({ target: DeliveryTargetSchema, receipts: z.array(ChatDeliveryReceiptSchema) })
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })
async function open(options?: Parameters<typeof deliveryAdaptersFixture>[0]) {
  const fixture = await deliveryAdaptersFixture(options); fixtures.push(fixture); return fixture
}
const headers = (token: string) => ({ authorization: `Bearer ${token}`, host: '127.0.0.1' })
function success<T>(schema: z.ZodType<T>, result: Call): T {
  expect(result.isError).not.toBe(true)
  return schema.parse(result.structuredContent)
}
function failure(result: Call) {
  expect(result.isError).toBe(true)
  for (const content of result.content) if (content.type === 'text') {
    return z.object({ error: z.object({ code: z.string(), message: z.string() }) }).parse(JSON.parse(content.text)).error
  }
  throw new Error('A public MCP error was expected.')
}
async function cold(fixture: Fixture) {
  const root = `/api/workspaces/${fixture.fixture.scope.workspaceId}/agent-chat`
  const response = await fixture.app.inject({ method: 'GET', url: `${root}?${new URLSearchParams(fixture.fixture.query)}`,
    headers: headers(fixture.owner.token) })
  expect(response.statusCode).toBe(200)
  const state = ReadAgentChatResponseSchema.parse(response.json())
  if (state.deliveryTarget?.kind !== 'agent_conversation') throw new Error('Expected the authoritative cold Agent candidate.')
  return { root, state, target: state.deliveryTarget }
}
async function operator(fixture: Fixture) {
  const response = await fixture.app.inject({ method: 'POST', url: '/api/operator/conversations',
    headers: headers(fixture.owner.token), payload: { commandId: randomUUID(), title: 'Adapter conversation' } })
  expect(response.statusCode).toBe(201)
  const { conversation } = CreateOperatorConversationResponseSchema.parse(response.json())
  return { id: conversation.id, target: { kind: 'operator_conversation' as const, conversationId: conversation.id },
    root: `/api/operator/conversations/${conversation.id}` }
}

type RetainedQuery = NonNullable<z.infer<typeof ReadAgentChatRequestSchema>['deliveryInputs']>
type RetainedPage = z.infer<typeof retained>
type RetainedIdentity = Pick<RetainedPage['deliveryInputs']['items'][number],
  'commandId' | 'receiptId' | 'target' | 'origin' | 'attachments' | 'intent'>
async function fullRetainedBody(read: (input: RetainedQuery) => Promise<RetainedPage>, identity: RetainedIdentity) {
  const chunks: string[] = [], cursors = new Set<string>()
  let bodyCursor: string | undefined
  for (let page = 0; page < 64; page++) {
    const result = await read({ receiptId: identity.receiptId, ...(bodyCursor ? { bodyCursor } : {}) })
    expect(result.target).toEqual(identity.target); expect(result.receipts).toEqual([])
    expect(result.deliveryInputs.items).toHaveLength(1)
    const item = result.deliveryInputs.items[0]!
    expect(item).toMatchObject(identity)
    expect(item.content.length).toBeGreaterThan(0)
    chunks.push(item.content)
    if (!item.truncated) {
      expect(item.bodyCursor).toBeNull()
      expect(chunks.length).toBeGreaterThan(1)
      return chunks.join('')
    }
    expect(typeof item.bodyCursor).toBe('string')
    if (!item.bodyCursor || cursors.has(item.bodyCursor)) throw new Error('Retained body continuation did not advance.')
    cursors.add(item.bodyCursor); bodyCursor = item.bodyCursor
  }
  throw new Error('Retained body exceeded the bounded continuation window.')
}
async function reopenExecution(fixture: Fixture, kind: 'workflow_execution' | 'workflow_coordinator') {
  if (!fixture.execution) throw new Error('Expected the typed execution owner fixture.')
  await fixture.closeAdapter()
  await fixture.fixture.restart()
  const reopened = await deliveryAdaptersFixture({ executionKind: kind }, fixture.fixture, fixture.execution.ownerState)
  fixtures[fixtures.indexOf(fixture)] = reopened
  return reopened
}

it.each(['workflow_execution', 'workflow_coordinator'] as const)(
  'recovers never-native %s input and exact file pins after TARGET_SETTLED and an authenticated adapter restart', async kind => {
    let fixture = await open({ executionKind: kind })
    if (!fixture.execution) throw new Error('Expected the typed execution owner fixture.')
    const initialOwner = fixture.execution, target = initialOwner.target, token = fixture.owner.token
    const workspaceId = fixture.fixture.scope.workspaceId, root = `/api/workspaces/${workspaceId}/agent-chat`
    const command = { target, commandId: randomUUID(), intent: 'next_turn' as const,
      content: '  Exact retained input 🙂\nsecond line\t  '.repeat(3000),
      attachments: [{ fileId: 'retained-file-a', revisionId: 'immutable-revision-a' },
        { fileId: 'retained-file-b', revisionId: 'immutable-revision-b' }] }
    const sent = await fixture.app.inject({ method: 'POST', url: `${root}/deliveries/send`, headers: headers(token), payload: command })
    expect(sent.statusCode).toBe(200)
    const receipt = ChatDeliveryReceiptSchema.parse(sent.json())
    expect(receipt).toMatchObject({ target, commandId: command.commandId, state: 'queued', requestedIntent: 'next_turn' })
    expect(receipt.nativeTurnId).toBeUndefined(); expect(initialOwner.deliveries()).toBe(1)
    const identity: RetainedIdentity = { target, receiptId: receipt.id, commandId: command.commandId,
      origin: 'direct', attachments: command.attachments, intent: command.intent }
    const firstClient = await fixture.connect(token)
    const queued = success(retained, await firstClient.callTool({ name: 'agent_chat_read', arguments: {
      workspaceId, target, deliveryInputs: { limit: 1 },
    } }))
    expect(queued.deliveryInputs.items).toEqual([expect.objectContaining({ ...identity, truncated: true, bodyCursor: expect.any(String) })])
    await initialOwner.settle()
    const settled = success(receiptRead, await firstClient.callTool({ name: 'agent_chat_read', arguments: {
      workspaceId, target, receiptId: receipt.id,
    } }))
    expect(settled.receipts).toEqual([expect.objectContaining({ id: receipt.id, state: 'failed', errorCode: 'TARGET_SETTLED' })])

    fixture = await reopenExecution(fixture, kind)
    if (!fixture.execution) throw new Error('Expected the reopened typed execution owner fixture.')
    const client = await fixture.connect(token)
    const httpRead = async (deliveryInputs: RetainedQuery) => {
      const response = await fixture.app.inject({ method: 'POST', url: `${root}/deliveries/read`, headers: headers(token),
        payload: { target, deliveryInputs } })
      expect(response.statusCode).toBe(200)
      expect(response.body).not.toContain('"conversationId"'); expect(response.body).not.toContain('"nativeTurnId"')
      return retained.parse(response.json())
    }
    const mcpRead = async (deliveryInputs: RetainedQuery) => {
      const response = await client.callTool({ name: 'agent_chat_read', arguments: { workspaceId, target, deliveryInputs } })
      expect(JSON.stringify(response.structuredContent)).not.toContain('"conversationId"')
      expect(JSON.stringify(response.structuredContent)).not.toContain('"nativeTurnId"')
      return success(retained, response)
    }
    for (const read of [httpRead, mcpRead]) {
      const page = await read({ limit: 1 })
      expect(page.deliveryInputs.items).toEqual([expect.objectContaining({ ...identity, truncated: true })])
      expect(page.deliveryInputs.items[0]?.content).toBe(command.content.slice(0, page.deliveryInputs.items[0]?.content.length))
      expect(page.deliveryInputs.hasMore).toBe(false); expect(page.deliveryInputs.nextCursor).toBeNull()
      expect(await fullRetainedBody(read, identity)).toBe(command.content)
    }
    const snapshot = success(EngineChatReadbackSchema,
      await client.callTool({ name: 'agent_chat_read', arguments: { workspaceId, target } }))
    expect(snapshot.target).toEqual(target); expect(snapshot.messages).toEqual([])
    expect(snapshot.receipts).toEqual(settled.receipts)
    expect(snapshot.receipts[0]?.nativeTurnId).toBeUndefined()
    const httpSnapshot = await fixture.app.inject({ method: 'POST', url: `${root}/deliveries/read`, headers: headers(token), payload: { target } })
    expect(httpSnapshot.statusCode).toBe(200)
    expect(EngineChatReadbackSchema.parse(httpSnapshot.json())).toEqual(snapshot)

    const wrongTarget = target.kind === 'workflow_execution'
      ? { ...target, execution: { ...target.execution, attempt: target.execution.attempt + 1 } }
      : { ...target, waitingActivationId: 'another-waiting-activation' }
    const denied = await fixture.app.inject({ method: 'POST', url: `${root}/deliveries/read`, headers: headers(token),
      payload: { target: wrongTarget, deliveryInputs: { receiptId: receipt.id } } })
    expect(denied.statusCode).toBe(404); expect(denied.json()).toMatchObject({ error: { code: 'CHAT_INPUT_NOT_FOUND' } })
    expect(denied.body).not.toContain('Exact retained input')
    expect(failure(await client.callTool({ name: 'agent_chat_read', arguments: {
      workspaceId, target: wrongTarget, deliveryInputs: { receiptId: receipt.id },
    } })).code).toBe('CHAT_INPUT_NOT_FOUND')
    const wrongScope = await fixture.app.inject({ method: 'POST', url: '/api/workspaces/another-workspace/agent-chat/deliveries/read',
      headers: headers(token), payload: { target, deliveryInputs: { receiptId: receipt.id } } })
    expect(wrongScope.statusCode).toBe(403)
    expect(failure(await client.callTool({ name: 'agent_chat_read', arguments: {
      workspaceId: 'another-workspace', target, deliveryInputs: { receiptId: receipt.id },
    } })).code).toBe('CHAT_TARGET_SCOPE_MISMATCH')
    expect(failure(await client.callTool({ name: 'agent_chat_send', arguments: {
      workspaceId, ...command, commandId: randomUUID(),
    } })).code).toBe('TARGET_SETTLED')
    const replay = success(ChatDeliveryReceiptSchema,
      await client.callTool({ name: 'agent_chat_send', arguments: { workspaceId, ...command } }))
    expect(replay).toEqual(settled.receipts[0])
    const httpReplay = await fixture.app.inject({ method: 'POST', url: `${root}/deliveries/send`, headers: headers(token), payload: command })
    expect(httpReplay.statusCode).toBe(200); expect(ChatDeliveryReceiptSchema.parse(httpReplay.json())).toEqual(replay)
    expect(initialOwner.deliveries()).toBe(1); expect(fixture.execution.deliveries()).toBe(1)
  },
)

it('preserves first-read cold identity and canonical receipt/retained-body envelopes through authenticated MCP and HTTP', async () => {
  const fixture = await open(), { root, state, target } = await cold(fixture)
  const client = await fixture.connect(fixture.owner.token), workspaceId = fixture.fixture.scope.workspaceId
  expect(state.conversation).toBeNull(); expect(state.deliveryTargetState).toBe('not_created')
  const firstRead = await client.callTool({ name: 'agent_chat_read', arguments: { workspaceId, target } })
  const nativeRead = success(z.object({ target: DeliveryTargetSchema, state: ReadAgentChatResponseSchema }), firstRead)
  expect(nativeRead.state.conversation).toBeNull()
  expect(nativeRead.state.deliveryTarget).toEqual(target)
  expect(nativeRead.state.deliveryTargetState).toBe('not_created')
  expect(fixture.fixture.native(target.conversationId).lastSession).toBeUndefined()
  const command = { target, commandId: randomUUID(), intent: 'auto', content: '  Preserve this exact input\nsecond line  ' }
  const receipt = success(ChatDeliveryReceiptSchema,
    await client.callTool({ name: 'agent_chat_send', arguments: { workspaceId, ...command } }))
  expect(receipt.commandId).toBe(command.commandId); expect(receipt.target).toEqual(target)
  expect(receipt.requestedIntent).toBe('auto'); expect(typeof receipt.state).toBe('string')
  const page = success(retained, await client.callTool({ name: 'agent_chat_read', arguments: {
    workspaceId, target, deliveryInputs: { receiptId: receipt.id },
  } }))
  expect(page.receipts).toEqual([])
  expect(page.deliveryInputs.items).toEqual([expect.objectContaining({ commandId: command.commandId,
    receiptId: receipt.id, target, origin: 'direct', content: command.content, attachments: [], truncated: false, bodyCursor: null })])
  const httpRead = await fixture.app.inject({ method: 'POST', url: `${root}/deliveries/read`, headers: headers(fixture.owner.token),
    payload: { target, deliveryInputs: { receiptId: receipt.id } } })
  expect(httpRead.statusCode).toBe(200)
  expect(retained.parse(httpRead.json()).deliveryInputs.items[0]?.content).toBe(command.content)
  const legacyRead = await fixture.app.inject({ method: 'GET', headers: headers(fixture.owner.token),
    url: `${root}?${new URLSearchParams({ ...fixture.fixture.query, deliveryInputReceiptId: receipt.id })}` })
  expect(legacyRead.statusCode).toBe(200)
  expect(ReadAgentChatResponseSchema.parse(legacyRead.json()).deliveryInputs?.items[0]?.receiptId).toBe(receipt.id)
  const replay = success(ChatDeliveryReceiptSchema,
    await client.callTool({ name: 'agent_chat_send', arguments: { workspaceId, ...command } }))
  expect(replay.id).toBe(receipt.id)
  await expect.poll(() => fixture.fixture.native(target.conversationId).inputs.length).toBe(1)
})

it('retains an explicit Agent command before owner adoption without fabricating native state or replaying it', async () => {
  const fixture = await open({ beforeOwnerAdoption: true }), { root, target } = await cold(fixture)
  const client = await fixture.connect(fixture.owner.token), workspaceId = fixture.fixture.scope.workspaceId
  const command = { requestId: randomUUID(), context: fixture.fixture.query, expectedConversationId: null,
    content: 'Accepted input whose owner has not adopted it', intent: 'auto' }
  const result = success(AgentChatSendResponseSchema, await client.callTool({ name: 'agent_chat_send',
    arguments: { workspaceId, request: command } }))
  if (!('receipt' in result) || !result.receipt) throw new Error('Expected the durable common receipt arm.')
  expect(result.receipt).toMatchObject({ commandId: command.requestId, target, state: 'queued' })
  expect('turn' in result ? result.turn : undefined).toBeUndefined()
  expect(fixture.fixture.native(target.conversationId).inputs).toHaveLength(0)
  const replay = await fixture.app.inject({ method: 'POST', url: `${root}/messages`, headers: headers(fixture.owner.token), payload: command })
  expect(replay.statusCode).toBe(200)
  const repeated = AgentChatSendResponseSchema.parse(replay.json())
  expect(repeated).toMatchObject({ replayed: true, receipt: { id: result.receipt.id } })
  expect('turn' in repeated ? repeated.turn : undefined).toBeUndefined()
  const page = success(retained, await client.callTool({ name: 'agent_chat_read', arguments: { workspaceId, target, deliveryInputs: {} } }))
  expect(page.deliveryInputs.items[0]).toMatchObject({ content: command.content, commandId: command.requestId, receiptId: result.receipt.id })
  expect(fixture.dispatchAttempts()).toBe(1)
  const changed = await client.callTool({ name: 'agent_chat_send', arguments: { workspaceId, request: { ...command, content: 'Different body' } } })
  expect(failure(changed).code).toBe('CHAT_COMMAND_CONFLICT')
  expect(fixture.dispatchAttempts()).toBe(1)
})

it('denies missing credentials, read-only writes and workspace target substitution without admitting an input', async () => {
  const fixture = await open(), { root, target } = await cold(fixture), workspaceId = fixture.fixture.scope.workspaceId
  const reader = await fixture.issue('Read-only Agent caller', [{ actions: ['agent_chat:read'], scope: { workspaceIds: [workspaceId] } }])
  const client = await fixture.connect(reader.token)
  const tools = await client.listTools()
  expect(tools.tools.some(tool => tool.name === 'agent_chat_read')).toBe(true)
  expect(tools.tools.some(tool => tool.name === 'agent_chat_send')).toBe(false)
  const input = { target, commandId: randomUUID(), intent: 'auto', content: 'Must not be admitted' }
  expect(failure(await client.callTool({ name: 'agent_chat_send', arguments: { workspaceId, ...input } })).code).toBe('FORBIDDEN')
  const deniedHttp = await fixture.app.inject({ method: 'POST', url: `${root}/deliveries/send`, headers: headers(reader.token), payload: input })
  expect(deniedHttp.statusCode).toBe(403)
  const invalid = await fixture.app.inject({ method: 'POST', url: `${root}/deliveries/read`, headers: headers('invalid'), payload: { target } })
  expect(invalid.statusCode).toBe(401)
  const otherWorkspace = await fixture.app.inject({ method: 'POST', url: '/api/workspaces/not-selected/agent-chat/deliveries/read',
    headers: headers(fixture.owner.token), payload: { target, deliveryInputs: {} } })
  expect(otherWorkspace.statusCode).toBe(403)
  const owner = await fixture.connect(fixture.owner.token)
  expect(failure(await owner.callTool({ name: 'agent_chat_read', arguments: { workspaceId: 'not-selected', target } })).code).toBe('CHAT_TARGET_SCOPE_MISMATCH')
  const page = success(retained, await client.callTool({ name: 'agent_chat_read', arguments: { workspaceId, target, deliveryInputs: {} } }))
  expect(page.deliveryInputs.items).toEqual([])
  expect(fixture.fixture.native(target.conversationId).inputs).toHaveLength(0)
})

it('keeps Operator old and exact envelopes distinct and restricts retained inputs to their conversation owner', async () => {
  const fixture = await open(), selected = await operator(fixture), client = await fixture.connect(fixture.owner.token)
  const old = success(GetOperatorConversationResponseSchema,
    await client.callTool({ name: 'operator_chat_get', arguments: { conversationId: selected.id } }))
  expect(old.conversation.id).toBe(selected.id)
  const command = { target: selected.target, commandId: randomUUID(), intent: 'next_turn', content: 'Owner-only original input' }
  const receipt = success(ChatDeliveryReceiptSchema,
    await client.callTool({ name: 'operator_chat_send', arguments: { conversationId: selected.id, request: command } }))
  expect(receipt.target).toEqual(selected.target)
  const input = { conversationId: selected.id, target: selected.target, deliveryInputs: { receiptId: receipt.id } }
  const page = success(retained, await client.callTool({ name: 'operator_chat_get', arguments: input }))
  expect(page.deliveryInputs.items[0]?.content).toBe(command.content)
  const other = await fixture.issue('Different Operator owner'), stranger = await fixture.connect(other.token)
  expect(failure(await stranger.callTool({ name: 'operator_chat_get', arguments: input })).code).toBe('CONVERSATION_NOT_FOUND')
  const denied = await fixture.app.inject({ method: 'POST', url: `${selected.root}/deliveries/read`, headers: headers(other.token),
    payload: { target: selected.target, deliveryInputs: { receiptId: receipt.id } } })
  expect(denied.statusCode).toBe(404); expect(denied.body).not.toContain(command.content)
  const mismatched = await client.callTool({ name: 'operator_chat_get', arguments: { ...input, conversationId: 'another-conversation' } })
  expect(failure(mismatched).code).toBe('CHAT_TARGET_SCOPE_MISMATCH')
})

it('returns the original canonical Operator receipt after deletion without requiring a current snapshot', async () => {
  const fixture = await open({ beforeOwnerAdoption: true }), selected = await operator(fixture), client = await fixture.connect(fixture.owner.token)
  const request = { requestId: randomUUID(), intent: 'auto', content: 'Original input retained after deletion' }
  const sent = success(SendOperatorMessageResponseSchema, await client.callTool({ name: 'operator_chat_send',
    arguments: { conversationId: selected.id, request } }))
  if (!('receipt' in sent) || !sent.receipt) throw new Error('Expected the canonical receipt wrapper.')
  const deleted = await fixture.app.inject({ method: 'DELETE', url: selected.root, headers: headers(fixture.owner.token) })
  expect(deleted.statusCode).toBe(200)
  const replay = success(SendOperatorMessageResponseSchema, await client.callTool({ name: 'operator_chat_send',
    arguments: { conversationId: selected.id, request } }))
  expect(replay).toMatchObject({ receipt: { id: sent.receipt.id }, replayed: true })
  expect(replay.state).toBeUndefined()
  const page = success(retained, await client.callTool({ name: 'operator_chat_get', arguments: {
    conversationId: selected.id, target: selected.target, deliveryInputs: { receiptId: sent.receipt.id },
  } }))
  expect(page.deliveryInputs.items[0]?.content).toBe(request.content)
  expect(fixture.dispatchAttempts()).toBe(1)
})

it('exposes queue-only cancellation and exact active-only Stop through the same authenticated Operator tools', async () => {
  const fixture = await open(), selected = await operator(fixture), client = await fixture.connect(fixture.owner.token)
  fixture.fixture.native(selected.id).autoFinish = false
  const send = (content: string) => client.callTool({ name: 'operator_chat_send', arguments: { conversationId: selected.id,
    request: { target: selected.target, commandId: randomUUID(), intent: 'next_turn', content } } })
  const active = success(ChatDeliveryReceiptSchema, await send('Active reply'))
  await expect.poll(async () => success(receiptRead, await client.callTool({ name: 'operator_chat_get', arguments: {
    conversationId: selected.id, target: selected.target, receiptId: active.id,
  } })).receipts[0]?.state).toBe('accepted')
  const queued = success(ChatDeliveryReceiptSchema, await send('Queued reply'))
  expect(queued.state).toBe('queued')
  const request = { target: selected.target, commandId: randomUUID(), selection: { kind: 'all' } }
  const canceled = success(ChatControlReceiptSchema, await client.callTool({ name: 'operator_chat_cancel_all_queued',
    arguments: { conversationId: selected.id, request } }))
  expect(canceled.operation).toBe('cancel_all_queued'); expect(canceled.affectedReceiptIds).toContain(queued.id)
  expect(fixture.fixture.native(selected.id).cancelCalls).toBe(0)
  const status = success(receiptRead, await client.callTool({ name: 'operator_chat_get', arguments: {
    conversationId: selected.id, target: selected.target, receiptId: queued.id,
  } }))
  expect(status.receipts[0]?.state).toBe('canceled')
  const stop = { target: selected.target, commandId: randomUUID(), scope: 'active_turn' }
  const stopped = success(ChatControlReceiptSchema, await client.callTool({ name: 'operator_chat_cancel',
    arguments: { conversationId: selected.id, request: stop } }))
  expect(stopped.operation).toBe('stop_active')
  const repeated = success(ChatControlReceiptSchema, await client.callTool({ name: 'operator_chat_cancel',
    arguments: { conversationId: selected.id, request: stop } }))
  expect(repeated.commandId).toBe(stopped.commandId); expect(repeated.replayed).toBe(true)
  await expect.poll(() => fixture.fixture.native(selected.id).cancelCalls).toBe(1)
})
