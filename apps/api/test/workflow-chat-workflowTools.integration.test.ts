import { randomUUID } from 'node:crypto'
import type { Client } from '@modelcontextprotocol/client'
import { afterEach, expect, it } from 'vitest'
import { z } from 'zod'
import { ChatDeliveryReceiptSchema, WorkflowChatPostResponseSchema, WorkflowChatPostSchema } from '@foreman-code/contracts'
import { ReadAgentChatResponseSchema } from '@foreman-code/contracts/agent-chat'
import { deliveryAdaptersFixture } from '../src/modules/workflow-chat/deliveryAdapters.test-support.js'

type Fixture = Awaited<ReturnType<typeof deliveryAdaptersFixture>>
type Result = Awaited<ReturnType<Client['callTool']>>
const fixtures: Fixture[] = []
const postPage = z.object({ items: z.array(WorkflowChatPostSchema), nextCursor: z.string().nullable(), hasMore: z.boolean(), revision: z.number() })
const receiptPage = z.object({ items: z.array(ChatDeliveryReceiptSchema), nextCursor: z.string().nullable(), hasMore: z.boolean(), revision: z.number() })
const bodyPage = z.object({ postId: z.string(), body: z.string(), nextBodyCursor: z.string().nullable(), revision: z.number() })
afterEach(async () => { for (const fixture of fixtures.splice(0)) await fixture.close() })
async function open() { const fixture = await deliveryAdaptersFixture(); fixtures.push(fixture); return fixture }
function success<T>(schema: z.ZodType<T>, result: Result): T {
  expect(result.isError).not.toBe(true)
  return schema.parse(result.structuredContent)
}
function error(result: Result) {
  expect(result.isError).toBe(true)
  for (const content of result.content) if (content.type === 'text') {
    return z.object({ error: z.object({ code: z.string(), message: z.string() }) }).parse(JSON.parse(content.text)).error
  }
  throw new Error('Expected an authenticated MCP error.')
}
async function candidate(fixture: Fixture, client: Client) {
  const state = success(ReadAgentChatResponseSchema, await client.callTool({ name: 'agent_chat_read', arguments: {
    workspaceId: fixture.fixture.scope.workspaceId, query: fixture.fixture.query,
  } }))
  if (state.deliveryTarget?.kind !== 'agent_conversation') throw new Error('The cold read must resolve an exact standalone candidate.')
  return { state, target: state.deliveryTarget }
}

it('posts and reads exact Group text through authenticated tools without waking an Agent for raw @ text', async () => {
  const fixture = await open(), client = await fixture.connect(fixture.owner.token), scope = fixture.fixture.scope
  const { state, target } = await candidate(fixture, client)
  expect(state.conversation).toBeNull()
  const request = { ...scope, commandId: randomUUID(), body: '  🙂 literal @Agent\nsecond line  ', mentions: [], deliveries: [], cardIds: [] }
  const listed = await client.listTools()
  expect(listed.tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
    'workflow_chat_post', 'workflow_chat_read', 'workflow_chat_deliveries_read', 'workflow_chat_delivery_cancel',
  ]))
  const posted = success(WorkflowChatPostResponseSchema, await client.callTool({ name: 'workflow_chat_post', arguments: request }))
  expect(posted.post.body).toBe(request.body); expect(posted.receipts).toEqual([])
  expect(posted.post.author).toMatchObject({ kind: 'operator', principalId: fixture.owner.principal.id })
  const read = success(postPage, await client.callTool({ name: 'workflow_chat_read', arguments: { ...scope, commandId: request.commandId } }))
  expect(read.items).toEqual([posted.post])
  const body = success(bodyPage, await client.callTool({ name: 'workflow_chat_read', arguments: {
    ...scope, postId: posted.post.id, mode: 'body',
  } }))
  expect(body).toMatchObject({ postId: posted.post.id, body: request.body, nextBodyCursor: null })
  await fixture.fixture.feature.router.drainPrepared()
  expect(fixture.fixture.native(target.conversationId).inputs).toHaveLength(0)
  expect((await candidate(fixture, client)).state.conversation).toBeNull()
  const replay = success(WorkflowChatPostResponseSchema, await client.callTool({ name: 'workflow_chat_post', arguments: request }))
  expect(replay).toEqual({ ...posted, replayed: true })
  const receipts = success(receiptPage, await client.callTool({ name: 'workflow_chat_deliveries_read', arguments: { ...scope, commandId: request.commandId } }))
  expect(receipts.items).toEqual([])
  expect(success(postPage, await client.callTool({ name: 'workflow_chat_read', arguments: scope })).items).toHaveLength(1)
})

it('deduplicates repeated UTF-16 chips and exposes the same exact receipt after real native adoption and replay', async () => {
  const fixture = await open(), client = await fixture.connect(fixture.owner.token), scope = fixture.fixture.scope
  const { target } = await candidate(fixture, client), node = fixture.fixture.query.workflowNodeId
  fixture.fixture.native(target.conversationId).autoFinish = false
  const request = { ...scope, commandId: randomUUID(), body: '  🙂 Ask @Agent and @Agent  ',
    mentions: [{ workflowNodeId: node, start: 9, end: 15 }, { workflowNodeId: node, start: 20, end: 26 }],
    deliveries: [{ workflowNodeId: node, target, intent: 'auto' }], cardIds: [] }
  const posted = success(WorkflowChatPostResponseSchema, await client.callTool({ name: 'workflow_chat_post', arguments: request }))
  expect(posted.post.body).toBe(request.body); expect(posted.post.mentions).toEqual(request.mentions)
  expect(posted.receipts).toHaveLength(1)
  const receipt = posted.receipts[0]!
  expect(receipt).toMatchObject({ target, requestedIntent: 'auto', appliedIntent: 'next_turn', state: 'queued' })
  expect(fixture.fixture.native(target.conversationId).inputs).toHaveLength(0)
  await fixture.fixture.feature.router.drainPrepared()
  await expect.poll(async () => success(receiptPage, await client.callTool({ name: 'workflow_chat_deliveries_read', arguments: {
    ...scope, receiptId: receipt.id,
  } })).items[0]?.state).toBe('accepted')
  expect(fixture.fixture.native(target.conversationId).inputs).toHaveLength(1)
  expect(fixture.fixture.native(target.conversationId).inputs[0]?.prompt).toContain(request.body)
  const replay = success(WorkflowChatPostResponseSchema, await client.callTool({ name: 'workflow_chat_post', arguments: request }))
  expect(replay.post.id).toBe(posted.post.id); expect(replay.replayed).toBe(true)
  expect(replay.receipts).toMatchObject([{ id: receipt.id, target, state: 'accepted' }])
  await fixture.fixture.feature.router.drainPrepared()
  expect(fixture.fixture.native(target.conversationId).inputs).toHaveLength(1)
  const focused = success(postPage, await client.callTool({ name: 'workflow_chat_read', arguments: {
    ...scope, receiptId: receipt.id, runId: 'unrelated-filter',
  } }))
  expect(focused.items).toEqual([posted.post])
  const recovered = success(receiptPage, await client.callTool({ name: 'workflow_chat_deliveries_read', arguments: {
    ...scope, commandId: request.commandId,
  } }))
  expect(recovered.items.map(value => value.id)).toEqual([receipt.id])
  const peer = await fixture.issue('Authorized Group reader'), other = await fixture.connect(peer.token)
  expect(success(receiptPage, await other.callTool({ name: 'workflow_chat_deliveries_read', arguments: {
    ...scope, commandId: request.commandId,
  } })).items).toEqual([])
  expect(success(receiptPage, await other.callTool({ name: 'workflow_chat_deliveries_read', arguments: {
    ...scope, receiptId: receipt.id,
  } })).items.map(value => value.id)).toEqual([receipt.id])
})

it('keeps lost-response command lookup scoped to its authenticated sender while exact authorized posts remain shared', async () => {
  const fixture = await open(), first = await fixture.connect(fixture.owner.token), scope = fixture.fixture.scope
  const other = await fixture.issue('Another Group sender'), second = await fixture.connect(other.token)
  const commandId = randomUUID(), request = { ...scope, commandId, body: 'First sender’s post', mentions: [], deliveries: [], cardIds: [] }
  const original = success(WorkflowChatPostResponseSchema, await first.callTool({ name: 'workflow_chat_post', arguments: request }))
  expect(success(postPage, await second.callTool({ name: 'workflow_chat_read', arguments: { ...scope, commandId } })).items).toEqual([])
  expect(success(postPage, await second.callTool({ name: 'workflow_chat_read', arguments: { ...scope, postId: original.post.id } })).items)
    .toEqual([original.post])
  const independent = success(WorkflowChatPostResponseSchema, await second.callTool({ name: 'workflow_chat_post', arguments: {
    ...request, body: 'Second sender’s independent post',
  } }))
  expect(independent.post.id).not.toBe(original.post.id)
  expect(independent.post.author).toMatchObject({ kind: 'operator', principalId: other.principal.id })
  expect(success(postPage, await first.callTool({ name: 'workflow_chat_read', arguments: { ...scope, commandId } })).items).toEqual([original.post])
  expect(success(postPage, await second.callTool({ name: 'workflow_chat_read', arguments: { ...scope, commandId } })).items).toEqual([independent.post])
  const changed = await first.callTool({ name: 'workflow_chat_post', arguments: { ...request, body: 'Changed immutable input' } })
  expect(error(changed).code).toBe('CHAT_COMMAND_CONFLICT')
})

it('denies Group reads, exact bodies, receipt lookup and posts outside the bearer’s authorized workflow', async () => {
  const fixture = await open(), owner = await fixture.connect(fixture.owner.token), scope = fixture.fixture.scope
  const posted = success(WorkflowChatPostResponseSchema, await owner.callTool({ name: 'workflow_chat_post', arguments: {
    ...scope, commandId: randomUUID(), body: 'Protected Group body', mentions: [], deliveries: [], cardIds: [],
  } }))
  const credential = await fixture.issue('Unrelated workflow', [{ scope: { workspaceIds: [scope.workspaceId], workflowIds: ['different-workflow'] },
    actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel'] }])
  const denied = await fixture.connect(credential.token)
  for (const call of [
    { name: 'workflow_chat_read', arguments: scope },
    { name: 'workflow_chat_read', arguments: { ...scope, postId: posted.post.id, mode: 'body' } },
    { name: 'workflow_chat_deliveries_read', arguments: { ...scope, postId: posted.post.id } },
    { name: 'workflow_chat_post', arguments: { ...scope, commandId: randomUUID(), body: 'Denied write', mentions: [], deliveries: [], cardIds: [] } },
  ]) {
    const response = await denied.callTool(call)
    expect(error(response).code).toBe('ACCESS_DENIED')
    expect(JSON.stringify(response)).not.toContain('Protected Group body')
  }
  expect(success(postPage, await owner.callTool({ name: 'workflow_chat_read', arguments: scope })).items).toEqual([posted.post])
})
