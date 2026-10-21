import { OperatorConversationStateSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GetOperatorConversationResponseSchema, OperatorActivityPageSchema,
  CreateOperatorConversationResponseSchema, ListOperatorConversationsResponseSchema,
  OperatorChatSetupSchema, SendOperatorMessageResponseSchema,
  ListOperatorConversationSummariesResponseSchema } from '@foreman-code/contracts'
import { OperatorConversationHistoryPageSchema } from '@foreman-code/contracts/operator-chat'
import type { ManagementAction, ManagementScope } from '@foreman-code/contracts/management'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { registerOperatorChatRoutes } from '../src/routes/operatorChat.js'
import { ReviewManager } from './fixtures/agent1OperatorChat.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { rejectableDeferred } from './helpers/deferred.js'

describe.skipIf(!postgresEnabled)('Authenticated Operator conversation tools', () => {
  let database: Awaited<ReturnType<typeof agent3Database>>
  let access: PostgresAccessService
  let operators: PostgresOperatorRepository
  let repository: PostgresOperatorConversationRepository
  let manager: ReviewManager
  let chat: OperatorChatService
  let app: ReturnType<typeof buildApp>
  let address: string
  let clients: Client[]

  beforeEach(async () => {
    database = await agent3Database()
    access = new PostgresAccessService(database.pool)
    operators = new PostgresOperatorRepository(database.pool)
    repository = new PostgresOperatorConversationRepository(database.pool)
    manager = new ReviewManager()
    chat = new OperatorChatService(repository, operators, () => manager, database.directory, {
      current: (id) => access.currentOperator(id),
      assertConfiguration() {},
      setup: async (selected) => ({
        harness: selected.harness,
        status: 'configured',
        endpoint: 'http://127.0.0.1:3000/mcp',
        checkedAt: new Date().toISOString(),
      }),
      prepare: async (_manager, configuration) => ({ agentId: configuration.operatorId, variables: {} }),
      release: async () => {},
    })
    app = buildApp({
      logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: {
        access,
        services: {
          operatorChat: chat,
          commands: new PostgresCommandCoordinator(database.pool),
        } as unknown as OperatorServices,
      },
    })
    registerOperatorChatRoutes(app, chat)
    clients = []
    address = await app.listen({ host: '127.0.0.1', port: 0 })
  }, 30_000)

  afterEach(async () => {
    await Promise.allSettled((clients ?? []).map((client) => client.close()))
    await chat?.shutdown()
    await app?.close()
    await database?.close()
  })

  async function connect(token: string) {
    const client = new Client({ name: 'operator-conversation-test', version: '1' })
    clients.push(client)
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
      authProvider: { token: async () => token },
    }))
    return client
  }

  async function issue(actions: ManagementAction[], scope: ManagementScope = {}) {
    const issued = await access.issue({
      name: 'Conversation caller',
      audience: 'operator',
      grants: [{ actions, scope }],
      expiresAt: new Date(Date.now() + 600_000),
    })
    return { ...issued, client: await connect(issued.token) }
  }

  async function denied(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: args })
    expect(result.isError).toBe(true)
    expect(result.structuredContent).toBeUndefined()
    expect(JSON.stringify(result.content)).toContain('ACCESS_DENIED')
    return JSON.stringify(result)
  }

  it('requires read and write for fresh sends and receipt-only recovery without exposing protected state', async () => {
    const writer = await issue(['operator_chat:write', 'capabilities:read'])
    const conversation = await chat.create(writer.principal)
    const request = { requestId: randomUUID(), content: 'Protected transcript from an earlier turn' }
    await repository.beginTurn(conversation.id, request, writer.principal.id)
    await repository.activity.append(conversation.id, request.requestId, {
      id: 'private-tool', requestId: request.requestId, kind: 'tool', status: 'completed',
      title: 'Protected activity', output: 'Private tool output',
    })
    await repository.finish(conversation.id, request.requestId, { outcome: 'succeeded' })
    const before = await repository.get(conversation.id)
    expect((await writer.client.listTools()).tools.map((tool) => tool.name)).not.toContain('operator_chat_send')
    const capabilities = await writer.client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })
    expect(decodeMcpToolResult(capabilities)).toMatchObject({ tools: expect.not.arrayContaining(['operator_chat_send']) })

    const fresh = { requestId: randomUUID(), content: 'A fresh request' }
    for (const command of [fresh, { ...request, recovery: 'receipt' as const }]) {
      const response = await denied(writer.client, 'operator_chat_send', {
        conversationId: conversation.id, request: command,
      })
      expect(response).not.toContain(request.content)
      expect(response).not.toContain('Private tool output')
      await expect(chat.send(conversation.id, command, writer.principal)).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    }
    expect(await repository.get(conversation.id)).toEqual(before)
    expect(manager.turns).toBe(0)

    const grants = [{ actions: ['operator_chat:read', 'operator_chat:write', 'capabilities:read'], scope: {} }]
    await database.pool.query('update management_principals set grants=$2::jsonb where id=$1', [
      writer.principal.id, JSON.stringify(grants),
    ])
    const reader = await connect(writer.token)
    const recovered = await reader.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: conversation.id, request: { ...request, recovery: 'receipt' },
    } })
    expect(recovered.isError).not.toBe(true)
    const result = SendOperatorMessageResponseSchema.parse(decodeMcpToolResult(recovered))
    expect(result.replayed).toBe(true)
    expect(OperatorConversationStateSchema.parse(result.state).messages.map((message) => message.content)).toContain(request.content)
    expect(OperatorConversationStateSchema.parse(result.state).activities?.[0]?.output).toBe('Private tool output')
    expect(await repository.get(conversation.id)).toEqual(before)
    expect(manager.turns).toBe(0)

    const beginTurn = repository.beginTurn.bind(repository)
    const admission = vi.spyOn(repository, 'beginTurn').mockImplementationOnce(async (...args) => {
      const begun = await beginTurn(...args)
      await database.pool.query('update management_principals set grants=$2::jsonb where id=$1', [
        writer.principal.id, JSON.stringify([{ actions: ['operator_chat:write'], scope: {} }]),
      ])
      return begun
    })
    try {
      const revoked = await reader.callTool({ name: 'operator_chat_send', arguments: {
        conversationId: conversation.id, request: fresh,
      } })
      expect(revoked.isError).toBe(true)
      expect(revoked.structuredContent).toBeUndefined()
      expect(JSON.stringify(revoked)).toContain('ACCESS_DENIED')
      expect(JSON.stringify(revoked)).not.toContain('Private tool output')
      const settled = await repository.get(conversation.id)
      expect(settled).toMatchObject({ activeRequestId: null, turnState: 'error',
        lastResult: { outcome: 'failed', error: { code: 'ACCESS_DENIED' } } })
      expect(manager.turns).toBe(0)
    } finally {
      admission.mockRestore()
    }
  })

  it('settles fresh sends when read access is revoked during the accepted configuration lookup', async () => {
    const owner = await issue(['operator_chat:read', 'operator_chat:write'])
    const conversation = await chat.create(owner.principal)
    const earlier = { requestId: randomUUID(), content: 'Protected earlier transcript' }
    await repository.beginTurn(conversation.id, earlier, owner.principal.id)
    await repository.finish(conversation.id, earlier.requestId, { outcome: 'succeeded' })
    const admitted = rejectableDeferred()
    const resume = rejectableDeferred()
    const configuration = repository.configuration.bind(repository)
    const lookup = vi.spyOn(repository, 'configuration').mockImplementation(async (id) => {
      const saved = await configuration(id)
      if ((await repository.active(conversation.id))?.active_request_id === request.requestId) {
        admitted.resolve()
        await resume.promise
      }
      return saved
    })
    const request = { requestId: randomUUID(), content: 'Fresh protected request' }
    try {
      const sending = owner.client.callTool({ name: 'operator_chat_send', arguments: {
        conversationId: conversation.id, request,
      } })
      await admitted.promise
      await database.pool.query('update management_principals set grants=$2::jsonb where id=$1', [
        owner.principal.id, JSON.stringify([{ actions: ['operator_chat:write'], scope: {} }]),
      ])
      resume.resolve()
      const result = await sending
      expect(result.isError).toBe(true)
      expect(result.structuredContent).toBeUndefined()
      expect(JSON.stringify(result)).toContain('ACCESS_DENIED')
      expect(JSON.stringify(result)).not.toContain(earlier.content)
      expect(JSON.stringify(result)).not.toContain(request.content)
      expect(manager.turns).toBe(0)
      expect(manager.attachments).toBe(0)
      expect(await repository.get(conversation.id)).toMatchObject({
        activeRequestId: null, turnState: 'error',
        lastResult: { outcome: 'failed', error: { code: 'ACCESS_DENIED' } },
      })
      const fresh = new PostgresOperatorConversationRepository(database.pool)
      expect((await fresh.get(conversation.id))?.lastResult?.error?.code).toBe('ACCESS_DENIED')
    } finally {
      resume.resolve()
      lookup.mockRestore()
    }
  })

  it('pages owned messages and activities omitted from snapshots with scoped cursors and denied callers', async () => {
    const owner = await issue(['operator_chat:read', 'operator_chat:write', 'capabilities:read'])
    const conversation = await chat.create(owner.principal)
    const contents: string[] = []
    const activityIds: string[] = []
    for (let turn = 0; turn < 40; turn++) {
      const requestId = `history-${turn}`
      const content = `Message ${turn}`
      contents.push(content)
      await repository.beginTurn(conversation.id, { requestId, content }, owner.principal.id)
      for (let index = 0; index < 3; index++) {
        const id = `activity-${turn}-${index}`
        activityIds.push(id)
        await repository.activity.append(conversation.id, requestId, {
          id, requestId, kind: 'tool', status: 'completed', title: id,
        })
      }
      await repository.finish(conversation.id, requestId, { outcome: 'succeeded' })
    }
    const snapshotReply = await owner.client.callTool({ name: 'operator_chat_get', arguments: {
      conversationId: conversation.id,
    } })
    const snapshot = GetOperatorConversationResponseSchema.parse(decodeMcpToolResult(snapshotReply))
    expect(snapshot.messages).toHaveLength(32)
    expect(snapshot.hasEarlierMessages).toBe(true)
    expect(snapshot.activities).toHaveLength(100)
    expect(snapshot.activityNextCursor).not.toBeNull()
    expect(snapshot.activityNextCursor).toBe(snapshot.activities![0]!.sequence)
    const capabilities = await owner.client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })
    expect(decodeMcpToolResult(capabilities)).toMatchObject({ tools: expect.arrayContaining([
      'operator_chat_history_get', 'operator_chat_activity_get',
    ]) })

    const messages: string[] = []
    let before: string | null = null
    do {
      const reply = await owner.client.callTool({ name: 'operator_chat_history_get', arguments: {
        conversationId: conversation.id, limit: 7, ...(before ? { before } : {}),
      } })
      expect(reply.isError).not.toBe(true)
      const page = OperatorConversationHistoryPageSchema.parse(decodeMcpToolResult(reply))
      expect(page.revision).toBe(snapshot.revision)
      expect(page.entries.every((entry) => entry.receipt?.outcome === 'succeeded')).toBe(true)
      expect(page.nextCursor === null || page.nextCursor !== before).toBe(true)
      messages.unshift(...page.entries.map((entry) => entry.message.content))
      before = page.nextCursor
    } while (before)
    expect(messages).toEqual(contents)

    for (const initial of [
      { activities: [], before: null },
      { activities: snapshot.activities!.map(activity => activity.id), before: snapshot.activityNextCursor! },
    ]) {
      const activities: string[] = [...initial.activities]
      let activityBefore: string | null = initial.before
      do {
        const reply = await owner.client.callTool({ name: 'operator_chat_activity_get', arguments: {
          conversationId: conversation.id, limit: 17, ...(activityBefore ? { before: activityBefore } : {}),
        } })
        expect(reply.isError).not.toBe(true)
        const page = OperatorActivityPageSchema.parse(decodeMcpToolResult(reply))
        expect(page.nextCursor === null || page.nextCursor !== activityBefore).toBe(true)
        activities.unshift(...page.activities.map(activity => activity.id))
        activityBefore = page.nextCursor
      } while (activityBefore)
      expect(activities).toEqual(activityIds)
    }
    expect(manager.turns).toBe(0)

    const foreign = await issue(['operator_chat:read', 'operator_chat:write'])
    const other = await chat.create(foreign.principal)
    const otherTurn = { requestId: randomUUID(), content: 'Another owner message' }
    await repository.beginTurn(other.id, otherTurn, foreign.principal.id)
    const otherActivity = await repository.activity.append(other.id, otherTurn.requestId, {
      id: 'other-tool', requestId: otherTurn.requestId, kind: 'tool', status: 'completed', title: 'Other activity',
    })
    const otherPage = await repository.history(other.id)
    await repository.finish(other.id, otherTurn.requestId, { outcome: 'succeeded' })
    for (const [name, cursor] of [
      ['operator_chat_history_get', otherPage!.entries[0]!.sequence],
      ['operator_chat_activity_get', otherActivity!.activity.sequence],
    ] as const) {
      const wrongCursor = await owner.client.callTool({ name, arguments: {
        conversationId: conversation.id, before: cursor,
      } })
      expect(wrongCursor.isError).toBe(true)
      expect(JSON.stringify(wrongCursor)).toContain('CURSOR_SCOPE_CONFLICT')
      const wrongOwner = await owner.client.callTool({ name, arguments: { conversationId: other.id } })
      expect(wrongOwner.isError).toBe(true)
      expect(JSON.stringify(wrongOwner)).toContain('CONVERSATION_NOT_FOUND')
    }
    const ungranted = await issue(['operator_chat:write'])
    const scoped = await issue(['operator_chat:read'], { workspaceIds: [randomUUID()] })
    for (const caller of [ungranted, scoped]) {
      const names = (await caller.client.listTools()).tools.map((tool) => tool.name)
      for (const name of ['operator_chat_history_get', 'operator_chat_activity_get']) {
        expect(names).not.toContain(name)
        await denied(caller.client, name, { conversationId: conversation.id })
      }
    }
    expect((await repository.get(conversation.id))?.revision).toBe(snapshot.revision)
    expect((await repository.history(conversation.id))?.entries).toHaveLength(40)
  })

  it('keeps MCP and HTTP drafts hidden until the first send while preserving saved readback and access checks', async () => {
    const owner = await issue(['operator_chat:read', 'operator_chat:write'])
    const reader = await issue(['operator_chat:read'])
    const created = await owner.client.callTool({ name: 'operator_chat_create', arguments: {} })
    expect(created.isError).not.toBe(true)
    const conversation = CreateOperatorConversationResponseSchema.parse(decodeMcpToolResult(created)).conversation
    const abandoned = await chat.create(owner.principal, 'Abandoned draft')
    const list = async () => ListOperatorConversationsResponseSchema.parse(decodeMcpToolResult(
      await owner.client.callTool({ name: 'operator_chat_list', arguments: {} })))
    const summaries = async () => {
      const response = await fetch(new URL('/api/operator/conversations/summaries?limit=1', address), {
        headers: { authorization: `Bearer ${owner.token}` },
      })
      expect(response.status).toBe(200)
      return ListOperatorConversationSummariesResponseSchema.parse(await response.json())
    }
    expect((await list()).conversations).toEqual([])
    expect(await summaries()).toMatchObject({ conversations: [], hasMore: false, attention: [] })
    const draft = await owner.client.callTool({ name: 'operator_chat_get', arguments: { conversationId: conversation.id } })
    expect(GetOperatorConversationResponseSchema.parse(decodeMcpToolResult(draft))).toMatchObject({
      conversation, messages: [],
    })
    await denied(reader.client, 'operator_chat_create', {})
    await denied(reader.client, 'operator_chat_send', {
      conversationId: conversation.id, request: { requestId: randomUUID(), content: 'Denied message' },
    })
    expect((await repository.get(conversation.id))?.messages).toEqual([])
    const content = 'Plan the workspace'
    const request = { requestId: randomUUID(), content }
    const sent = await owner.client.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: conversation.id, request,
    } })
    expect(sent.isError).not.toBe(true)
    expect(OperatorConversationStateSchema.parse(SendOperatorMessageResponseSchema.parse(decodeMcpToolResult(sent)).state).messages)
      .toContainEqual(expect.objectContaining({ role: 'user', content, requestId: request.requestId }))
    await vi.waitFor(async () => expect((await chat.get(conversation.id, owner.principal)).turnState).toBe('active'))
    const persisted = await new PostgresOperatorConversationRepository(database.pool).get(conversation.id)
    expect(persisted).toBeDefined()
    expect(persisted!.conversation).toEqual({
      ...conversation, title: content, updatedAt: persisted!.conversation.updatedAt,
    })
    expect(Date.parse(persisted!.conversation.updatedAt!)).toBeGreaterThan(Date.parse(conversation.updatedAt!))
    expect((await list()).conversations).toEqual([persisted!.conversation])
    expect(await summaries()).toMatchObject({
      conversations: [{ conversationId: conversation.id, title: content }], hasMore: false,
    })
    expect(persisted?.conversation.title).toBe(content)
    expect(persisted?.messages).toContainEqual(expect.objectContaining({ role: 'user', content }))
    expect((await repository.get(abandoned.id))?.messages).toEqual([])
    const otherList = await reader.client.callTool({ name: 'operator_chat_list', arguments: {} })
    expect(ListOperatorConversationsResponseSchema.parse(decodeMcpToolResult(otherList)).conversations).toEqual([])
  })

  it('hides empty owned drafts and recovers creation after response loss without duplicates', async () => {
    const owner = await issue(['operator_chat:read', 'operator_chat:write', 'capabilities:read'])
    const command = { commandId: randomUUID(), title: 'Recover this empty conversation' }
    const create = () => owner.client.callTool({ name: 'operator_chat_create', arguments: command })
    // Recover a lost creation response by replaying its command.
    expect((await create()).isError).not.toBe(true)
    const discovery = await owner.client.callTool({ name: 'operator_chat_list', arguments: {} })
    const listed = ListOperatorConversationsResponseSchema.parse(decodeMcpToolResult(discovery))
    expect(listed.conversations).toEqual([])
    const recovered = await create()
    const original = CreateOperatorConversationResponseSchema.parse(decodeMcpToolResult(recovered)).conversation
    expect(original.title).toBe(command.title)
    expect((await repository.get(original.id))?.messages).toEqual([])
    expect(await chat.summaries(owner.principal)).toEqual([])
    const initial = await operators.ensure()
    const defaults = new PostgresFoundationSettingsRepository(database.pool)
    const snapshot = await defaults.getAgentDefaults()
    const harness = { ...initial.configuration.harness, model: 'changed-default-model' }
    await defaults.updateAgentDefaults({
      ...snapshot.value, operator: { ...snapshot.value.operator, harness },
    }, snapshot.revision)
    await operators.update(harness, initial.configuration.id)

    const retries = await Promise.all([create(), create()])
    for (const retry of retries) {
      expect(retry.isError).not.toBe(true)
      expect(CreateOperatorConversationResponseSchema.parse(decodeMcpToolResult(retry)).conversation).toEqual(original)
    }
    const httpRetry = await fetch(new URL('/api/operator/conversations', address), {
      method: 'POST',
      headers: { authorization: `Bearer ${owner.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(command),
    })
    expect(httpRetry.status).toBe(201)
    expect(CreateOperatorConversationResponseSchema.parse(await httpRetry.json()).conversation).toEqual(original)
    const read = await owner.client.callTool({ name: 'operator_chat_get', arguments: { conversationId: original.id } })
    expect(GetOperatorConversationResponseSchema.parse(decodeMcpToolResult(read)).conversation).toEqual(original)
    const conflict = await owner.client.callTool({ name: 'operator_chat_create', arguments: {
      ...command, title: 'Different title',
    } })
    expect(conflict.isError).toBe(true)
    expect(JSON.stringify(conflict)).toContain('COMMAND_ID_CONFLICT')

    const another = await issue(['operator_chat:read', 'operator_chat:write'])
    const independent = await another.client.callTool({ name: 'operator_chat_create', arguments: command })
    const other = CreateOperatorConversationResponseSchema.parse(decodeMcpToolResult(independent)).conversation
    expect(other.id).not.toBe(original.id)
    const originalTurn = await repository.beginTurn(original.id,
      { requestId: randomUUID(), content: 'First saved message' }, owner.principal.id)
    const otherTurn = await repository.beginTurn(other.id,
      { requestId: randomUUID(), content: 'Another saved message' }, another.principal.id)
    const savedOriginal = { ...original, updatedAt: originalTurn.state.conversation.updatedAt }
    const savedOther = { ...other, updatedAt: otherTurn.state.conversation.updatedAt }
    expect(originalTurn.state.conversation).toEqual(savedOriginal)
    expect(otherTurn.state.conversation).toEqual(savedOther)
    expect(Date.parse(savedOriginal.updatedAt!)).toBeGreaterThan(Date.parse(original.updatedAt!))
    expect(Date.parse(savedOther.updatedAt!)).toBeGreaterThan(Date.parse(other.updatedAt!))
    const ownList = await owner.client.callTool({ name: 'operator_chat_list', arguments: {} })
    expect(ListOperatorConversationsResponseSchema.parse(decodeMcpToolResult(ownList)).conversations).toEqual([savedOriginal])
    const otherList = await another.client.callTool({ name: 'operator_chat_list', arguments: {} })
    expect(ListOperatorConversationsResponseSchema.parse(decodeMcpToolResult(otherList)).conversations).toEqual([savedOther])
    const capabilities = await owner.client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })
    expect(decodeMcpToolResult(capabilities)).toMatchObject({ tools: expect.arrayContaining(['operator_chat_list']) })

    const reader = await issue(['operator_chat:read'])
    const scoped = await issue(['operator_chat:write', 'operator_chat:read'], { workspaceIds: [randomUUID()] })
    await denied(reader.client, 'operator_chat_create', command)
    await denied(scoped.client, 'operator_chat_create', command)
    await denied(scoped.client, 'operator_chat_list', {})
    const writeOnly = await issue(['operator_chat:write'])
    await denied(writeOnly.client, 'operator_chat_list', {})
    expect((await repository.list(owner.principal.id)).map((conversation) => conversation.id)).toEqual([original.id])
    const receipts = await database.pool.query('select result from management_command_receipts where principal_id=$1', [
      owner.principal.id,
    ])
    expect(receipts.rows).toEqual([{ result: original }])
    const audits = await database.pool.query(
      "select source,outcome from management_audit where principal_id=$1 and action='operator_chat_create' and outcome='succeeded'",
      [owner.principal.id],
    )
    expect(audits.rows).toEqual([{ source: 'mcp', outcome: 'succeeded' }])
  })

  it('deletes and restores owned chats with persisted readback, command replay and audits', async () => {
    const owner = await issue(['operator_chat:read', 'operator_chat:write', 'capabilities:read'])
    const conversation = await chat.create(owner.principal)
    const otherChat = await chat.create(owner.principal)
    const fresh = new PostgresOperatorConversationRepository(database.pool)
    const initialRevision = Number((await fresh.active(conversation.id))!.revision)
    const deletion = { conversationId: conversation.id, commandId: randomUUID() }
    const restoration = { conversationId: conversation.id, commandId: randomUUID() }
    const call = (name: string, input: typeof deletion) => owner.client.callTool({ name, arguments: input })
    const names = ['operator_chat_delete', 'operator_chat_restore']
    expect((await owner.client.listTools()).tools.map(tool => tool.name)).toEqual(expect.arrayContaining(names))
    const capabilities = await owner.client.callTool({ name: 'operator_get_capabilities', arguments: { detail: 'full' } })
    expect(decodeMcpToolResult(capabilities)).toMatchObject({ tools: expect.arrayContaining(names) })

    const delegated = await access.issue({ name: 'Chat credential', audience: 'operator',
      grants: [{ actions: ['capabilities:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    await database.pool.query('insert into operator_chat_credentials(principal_id,conversation_id) values($1,$2)',
      [delegated.principal.id, conversation.id])
    expect(decodeMcpToolResult((await call('operator_chat_delete', deletion)))).toEqual({ conversationId: conversation.id, revision: initialRevision + 1 })
    const deleted = await fresh.active(conversation.id)
    expect(deleted?.deleted_at).toBeTruthy()
    expect(Number(deleted!.revision)).toBe(initialRevision + 1)
    const list = await owner.client.callTool({ name: 'operator_chat_list', arguments: {} })
    expect(ListOperatorConversationsResponseSchema.parse(decodeMcpToolResult(list)).conversations.map(item => item.id))
      .not.toContain(conversation.id)
    const missing = await owner.client.callTool({ name: 'operator_chat_get', arguments: { conversationId: conversation.id } })
    expect(missing.isError).toBe(true)
    expect(JSON.stringify(missing.content)).toContain('CONVERSATION_NOT_FOUND')
    await expect(access.authenticate(delegated.token)).rejects.toThrow()
    for (const retry of await Promise.all([call('operator_chat_delete', deletion), call('operator_chat_delete', deletion)])) {
      expect(decodeMcpToolResult(retry)).toEqual({ conversationId: conversation.id, revision: initialRevision + 1 })
    }
    expect(Number((await fresh.active(conversation.id))!.revision)).toBe(initialRevision + 1)

    expect(decodeMcpToolResult((await call('operator_chat_restore', restoration)))).toEqual({ conversationId: conversation.id, revision: initialRevision + 2 })
    expect((await fresh.active(conversation.id))?.deleted_at).toBeNull()
    expect(Number((await fresh.active(conversation.id))!.revision)).toBe(initialRevision + 2)
    await expect(access.authenticate(delegated.token)).rejects.toThrow()
    const restored = await owner.client.callTool({ name: 'operator_chat_get', arguments: { conversationId: conversation.id } })
    expect(GetOperatorConversationResponseSchema.parse(decodeMcpToolResult(restored)).conversation).toEqual(conversation)
    expect((await call('operator_chat_delete', deletion)).isError).not.toBe(true)
    expect((await fresh.active(conversation.id))?.deleted_at).toBeNull()

    const secondDeletion = { ...deletion, commandId: randomUUID() }
    expect((await call('operator_chat_delete', secondDeletion)).isError).not.toBe(true)
    expect((await call('operator_chat_restore', restoration)).isError).not.toBe(true)
    expect((await fresh.active(conversation.id))?.deleted_at).toBeTruthy()
    expect(Number((await fresh.active(conversation.id))!.revision)).toBe(initialRevision + 3)
    const conflict = await call('operator_chat_delete', { ...deletion, conversationId: otherChat.id })
    expect(conflict.isError).toBe(true)
    expect(JSON.stringify(conflict.content)).toContain('COMMAND_ID_CONFLICT')
    expect((await fresh.active(otherChat.id))?.deleted_at).toBeNull()

    const audits = await database.pool.query(
      `select source,action,outcome from management_audit where principal_id=$1
        and action in ('operator_chat_delete','operator_chat_restore') and outcome='succeeded' order by sequence`,
      [owner.principal.id])
    expect(audits.rows).toEqual([
      { source: 'mcp', action: 'operator_chat_delete', outcome: 'succeeded' },
      { source: 'mcp', action: 'operator_chat_restore', outcome: 'succeeded' },
      { source: 'mcp', action: 'operator_chat_delete', outcome: 'succeeded' },
    ])
    await database.pool.query('update management_principals set grants=$2::jsonb where id=$1', [
      owner.principal.id, JSON.stringify([{ actions: ['operator_chat:read'], scope: {} }]),
    ])
    await denied(owner.client, 'operator_chat_delete', deletion)
    await denied(owner.client, 'operator_chat_restore', restoration)
    expect(Number((await fresh.active(conversation.id))!.revision)).toBe(initialRevision + 3)
    expect((await fresh.active(conversation.id))?.deleted_at).toBeTruthy()
  })

  it('denies read-only, scoped and other-owner callers and refuses chat changes during a turn', async () => {
    const owner = await issue(['operator_chat:read', 'operator_chat:write'])
    const conversation = await chat.create(owner.principal)
    const reader = await issue(['operator_chat:read'])
    const scoped = await issue(['operator_chat:read', 'operator_chat:write'], { workspaceIds: [randomUUID()] })
    const stranger = await issue(['operator_chat:read', 'operator_chat:write'])
    const input = { conversationId: conversation.id, commandId: randomUUID() }
    for (const name of ['operator_chat_delete', 'operator_chat_restore']) {
      await denied(reader.client, name, input)
      await denied(scoped.client, name, input)
      const notOwned = await stranger.client.callTool({ name, arguments: input })
      expect(notOwned.isError).toBe(true)
      expect(JSON.stringify(notOwned.content)).toContain('CONVERSATION_NOT_FOUND')
    }
    const request = { requestId: randomUUID(), content: 'An active response' }
    await repository.beginTurn(conversation.id, request, owner.principal.id)
    const activeRevision = Number((await repository.active(conversation.id))!.revision)
    for (const name of ['operator_chat_delete', 'operator_chat_restore']) {
      const active = await owner.client.callTool({ name, arguments: input })
      expect(active.isError).toBe(true)
      expect(JSON.stringify(active.content)).toContain('CONVERSATION_TURN_ACTIVE')
    }
    const persisted = await new PostgresOperatorConversationRepository(database.pool).active(conversation.id)
    expect(persisted?.deleted_at).toBeNull()
    expect(Number(persisted!.revision)).toBe(activeRevision)
    await repository.finish(conversation.id, request.requestId, { outcome: 'succeeded', output: 'Done' })
    expect((await owner.client.callTool({ name: 'operator_chat_delete', arguments: input })).isError).not.toBe(true)
    const deniedAudits = await database.pool.query(
      "select principal_id,action from management_audit where outcome='denied' and principal_id=any($1::text[])",
      [[reader.principal.id, scoped.principal.id]])
    expect(deniedAudits.rows).toEqual(expect.arrayContaining([
      { principal_id: reader.principal.id, action: 'operator_chat_delete' },
      { principal_id: reader.principal.id, action: 'operator_chat_restore' },
      { principal_id: scoped.principal.id, action: 'operator_chat_delete' },
      { principal_id: scoped.principal.id, action: 'operator_chat_restore' },
    ]))
  })

  it('inspects conversation and accepted-message pins after defaults change while retaining owner and configuration checks', async () => {
    const owner = await issue(['operator_chat:read', 'operator_chat:write', 'harnesses:read'])
    const created = await owner.client.callTool({ name: 'operator_chat_create', arguments: {
      commandId: randomUUID(), title: 'Keep the original configuration',
    } })
    const conversation = CreateOperatorConversationResponseSchema.parse(decodeMcpToolResult(created)).conversation
    const requestId = randomUUID()
    await repository.beginTurn(conversation.id, { requestId, content: 'Accepted on the original configuration' }, owner.principal.id)
    await repository.finish(conversation.id, requestId, { outcome: 'succeeded' })
    const original = await operators.ensure()
    const defaults = new PostgresFoundationSettingsRepository(database.pool)
    const beforeDefaults = await defaults.getAgentDefaults()
    const harness = { ...original.configuration.harness, model: 'different-setup-model' }
    const moved = await defaults.updateAgentDefaults({
      ...beforeDefaults.value, operator: { ...beforeDefaults.value.operator, harness },
    }, beforeDefaults.revision)
    const next = await operators.update(harness, original.configuration.id)
    const inspect = (args: Record<string, unknown>) => owner.client.callTool({ name: 'operator_mcp_setup_get', arguments: args })
    const publicSetup = await inspect({ harness: 'codex', expectedDefaultsRevision: moved.revision })
    expect(OperatorChatSetupSchema.parse(decodeMcpToolResult(publicSetup)).configurationVersionId).toBe(next.configuration.id)
    for (const query of [
      { conversationId: conversation.id },
      { configurationVersionId: original.configuration.id },
      { conversationId: conversation.id, requestId, configurationVersionId: original.configuration.id,
        harness: 'codex', expectedDefaultsRevision: beforeDefaults.revision },
    ]) {
      const result = await inspect(query)
      expect(result.isError).not.toBe(true)
      expect(OperatorChatSetupSchema.parse(decodeMcpToolResult(result))).toMatchObject({
        configurationVersionId: original.configuration.id, harness: 'codex', status: 'configured',
      })
    }
    const stale = await inspect({ expectedDefaultsRevision: beforeDefaults.revision })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale)).toContain('OPERATOR_DEFAULTS_CHANGED')
    const mismatch = await inspect({ conversationId: conversation.id, configurationVersionId: original.configuration.id,
      harness: 'claude' })
    expect(mismatch.isError).toBe(true)
    expect(JSON.stringify(mismatch)).toContain('OPERATOR_CONFIGURATION_CONFLICT')

    const another = await issue(['operator_chat:read', 'harnesses:read'])
    const foreignConversation = await another.client.callTool({ name: 'operator_mcp_setup_get', arguments: {
      conversationId: conversation.id,
    } })
    expect(foreignConversation.isError).toBe(true)
    expect(JSON.stringify(foreignConversation)).toContain('CONVERSATION_NOT_FOUND')
    for (const caller of [another, await issue(['harnesses:read'])]) {
      const privatePin = await caller.client.callTool({ name: 'operator_mcp_setup_get', arguments: {
        configurationVersionId: original.configuration.id,
      } })
      expect(privatePin.isError).toBe(true)
      expect(JSON.stringify(privatePin)).toContain('ACCESS_DENIED')
      expect(JSON.stringify(privatePin)).not.toContain('different-setup-model')
    }
    const ungranted = await issue(['operator_chat:read'])
    const scoped = await issue(['harnesses:read'], { workspaceIds: [randomUUID()] })
    for (const caller of [ungranted, scoped]) {
      expect((await caller.client.listTools()).tools.map((tool) => tool.name)).not.toContain('operator_mcp_setup_get')
      await denied(caller.client, 'operator_mcp_setup_get', { conversationId: conversation.id })
    }
    const readback = await owner.client.callTool({ name: 'operator_chat_get', arguments: { conversationId: conversation.id } })
    expect(GetOperatorConversationResponseSchema.parse(decodeMcpToolResult(readback)).conversation.operatorConfigurationVersionId)
      .toBe(original.configuration.id)
    expect((await repository.acceptedConfiguration(conversation.id, requestId))?.id).toBe(original.configuration.id)
    expect((await operators.ensure()).configuration.id).toBe(next.configuration.id)
    expect(await defaults.getAgentDefaults()).toEqual(moved)
    expect(manager.turns).toBe(0)
  })

  it('keeps a thinking-only accepted configuration and controls profile transition readable through authenticated MCP', async () => {
    const owner = await issue(['operator_chat:read', 'operator_chat:write'])
    const reader = await issue(['operator_chat:read'])
    const conversation = await chat.create(owner.principal)
    const firstRequest = { requestId: 'first-message', content: 'Original request' }
    await repository.beginTurn(conversation.id, firstRequest, owner.principal.id)
    await repository.bind(conversation.id, firstRequest.requestId, manager.session.providerVersion, manager.session.nativeSessionId)
    await repository.journalTerminal(conversation.id, firstRequest.requestId, { outcome: 'succeeded' }, {
      retryable: false, requiresRuntimeClosure: true,
    })
    await repository.closurePending(conversation.id, firstRequest.requestId)
    await manager.close()
    await repository.closureProven(conversation.id, firstRequest.requestId)
    await repository.finish(conversation.id, firstRequest.requestId, { outcome: 'succeeded' })
    const original = (await repository.acceptedConfiguration(conversation.id, firstRequest.requestId))!
    const controlsBefore = await chat.readSessionControls(conversation.id, owner.principal)
    const history = async () => ({ ...manager.nativeHistory,
      ...(manager.turns ? { terminalResult: { outcome: 'succeeded' as const } } : {}) })
    vi.spyOn(manager, 'history').mockImplementation(history)
    vi.spyOn(manager, 'reconcile').mockImplementation(history)
    const request = { requestId: 'thinking-message', content: 'Continue', settings: {
      ...((await chat.get(conversation.id, owner.principal)).settings!), showThinking: !(original.showThinking ?? false),
    } }
    await denied(reader.client, 'operator_chat_send', { conversationId: conversation.id, request })
    expect(manager.turns).toBe(0)
    const response = await owner.client.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: conversation.id, request,
    } })
    expect(response.isError).not.toBe(true)
    await vi.waitFor(async () => expect((await chat.get(conversation.id, owner.principal)).turnState).toBe('idle'),
      { timeout: 10000, interval: 50 })
    const read = await owner.client.callTool({ name: 'operator_chat_get', arguments: { conversationId: conversation.id } })
    const snapshot = GetOperatorConversationResponseSchema.parse(decodeMcpToolResult(read))
    expect(snapshot.settings?.showThinking).toBe(request.settings.showThinking)
    expect(snapshot.conversation.id).toBe(conversation.id)
    expect(manager.turns).toBe(1)
    const accepted = (await repository.acceptedConfiguration(conversation.id, request.requestId))!
    expect(accepted.id).not.toBe(original.id)
    expect(await repository.configuration(original.id)).toEqual(original)
    expect(await repository.acceptedConfiguration(conversation.id, firstRequest.requestId)).toEqual(original)
    expect((await repository.active(conversation.id))?.native_session_id).toBe(manager.session.nativeSessionId)
    const controls = await owner.client.callTool({ name: 'operator_chat_controls_get', arguments: { conversationId: conversation.id } })
    expect(decodeMcpToolResult(controls)).toMatchObject({ profileKey: accepted.contentHash,
      revision: expect.any(Number) })
    const persisted = await chat.readSessionControls(conversation.id, owner.principal)
    expect(persisted.profileKey).toBe(accepted.contentHash)
    expect(persisted.revision).toBeGreaterThan(controlsBefore.revision)
  })

})
