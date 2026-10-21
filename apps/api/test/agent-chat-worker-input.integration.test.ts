import { createHash, randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentChatStateSchema, SendAgentChatMessageResponseSchema } from '@foreman-code/contracts/agent-chat'
import { AgentMutationResultSchema } from '@foreman-code/contracts/management'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { remoteAgentConversation } from './helpers/remoteAgentConversation.js'
import { graphHeaders } from './eng04-graph-composition-fixture.js'

it.each(['main', 'worker'] as const)('steers an active Codex turn on %s through authenticated MCP', async location => {
  const f = await remoteAgentConversation('codex', location)
  f.provider.holdReply()
  const sending = f.send('Keep working until released')
  try {
    let before = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
    await vi.waitFor(async () => {
      before = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
      expect(before.activeTurn?.nativeTurnId).toBeTruthy()
    }, { timeout: 5000 })
    const request = { requestId: randomUUID(), content: 'Use the second approach', intent: 'steer',
      expectedConversationId: f.conversation.id, expectedNativeTurnId: before.activeTurn!.nativeTurnId,
      context: f.context }
    const denied = await f.call('agent_chat_send', { request }, f.reader.token)
    expect(denied.error || denied.result?.isError).toBeTruthy()
    const stale = await f.call('agent_chat_send', { request: { ...request, expectedNativeTurnId: 'finished-turn' } })
    expect(stale.error || stale.result?.isError).toBeTruthy()
    expect(f.provider.calls.filter(method => method === 'turn/steer')).toHaveLength(0)
    const sent = SendAgentChatMessageResponseSchema.parse(await f.value('agent_chat_send', { request }))
    expect(sent.turn).toMatchObject({ requestId: request.requestId, intent: 'steer', delivery: 'accepted',
      targetNativeTurnId: before.activeTurn!.nativeTurnId })
    expect(sent.state.activeTurn).toEqual(before.activeTurn)
    expect(f.provider.calls.filter(method => method === 'turn/steer')).toHaveLength(1)
    expect(sent.state.messages.some(message => message.requestId === request.requestId
      && message.content === request.content)).toBe(true)
    const replay = SendAgentChatMessageResponseSchema.parse(await f.value('agent_chat_send', { request }))
    expect(replay.replayed).toBe(true)
    expect(f.provider.calls.filter(method => method === 'turn/steer')).toHaveLength(1)
  } finally {
    f.provider.releaseReply()
    await sending
    await f.close()
  }
}, 30_000)

it.each((['codex', 'claude'] as const).flatMap(harness => [false, true].map(existing => ({ harness, existing }))))(
  'delivers attachment-only messages to Worker $harness through MCP (existing session: $existing)', async ({ harness, existing }) => {
  let stage = 'setup'
  let fixture: Awaited<ReturnType<typeof remoteAgentConversation>> | undefined
  const watchdog = new Promise<never>((_, reject) => setTimeout(async () => {
    const bounded = <T,>(work: Promise<T> | undefined) => Promise.race([work, new Promise(r => setTimeout(() => r('hung'), 1500))]).catch(e => String(e))
    const detail = { snapshot: await bounded(fixture?.snapshot()),
      turns: await bounded(fixture?.value('agent_chat_read', { query: fixture.context }).then(v => AgentChatStateSchema.parse(v).turns.map(t => [t.requestId.slice(0, 4), t.intent, t.delivery]))),
      row: await bounded(fixture?.repository.get(fixture.conversation.id).then(r => r && { active: r.active_request_id, native: r.active_native_turn_id, state: r.turn_state, phase: r.active_phase, err: r.last_error })) }
    reject(new Error(`DIAG stuck at stage ${stage}: ${JSON.stringify(detail)}`))
  }, 22_000))
  watchdog.catch(() => undefined)
  await Promise.race([watchdog, (async () => {
  const f = fixture = await remoteAgentConversation(harness)
  try {
    stage = 'establish'
    if (existing) await f.send('Establish the session')
    stage = 'upload'
    const text = 'The attachment is the complete follow-up request.'
    const attachment = await f.upload(Buffer.from(text))
    const requestId = randomUUID()
    stage = 'send'
    await f.value('agent_chat_send', { request: { requestId, content: '', intent: 'next_turn',
      expectedConversationId: f.conversation.id, context: f.context, attachments: [attachment] } })
    stage = 'wait-completed'
    await vi.waitFor(async () => {
      const state = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
      expect(state.turns.find(turn => turn.requestId === requestId)?.delivery).toBe('completed')
    }, { timeout: 5000 })
    stage = 'assert'
    expect(f.receivedAttachments).toEqual([text])
    const read = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
    expect(read.messages.find(message => message.requestId === requestId && message.role === 'user'))
      .toMatchObject({ content: '', originalInput: { requestId, content: '', attachments: [attachment] },
        attachments: [{
          file: { fileId: attachment.fileId, state: 'ready' },
          revision: { ...attachment, filename: 'attached.md', mediaType: 'text/markdown',
            byteSize: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') },
        }] })
    expect(read.turns.find(turn => turn.requestId === requestId)?.delivery).toBe('completed')
  } finally { stage = 'close'; await f.close() }
  })()])
}, 30_000)

it('delivers an admitted large Worker message within the complete serialized RPC limit', async () => {
  const f = await remoteAgentConversation('codex')
  try {
    await f.send('Establish the session')
    const content = 'Large pasted log line\n'.repeat(20_000).trim()
    const sent = await f.send(content)
    expect(sent.turn?.delivery).toBe('completed')
    const input = f.frames.find(frame => frame.method === 'conversation.start-turn' && frame.prompt === content)
    expect(input).toMatchObject({ method: 'conversation.start-turn', prompt: content })
    for (const frame of f.frames) expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(1024 * 1024)
    expect(await f.repository.turnContent(f.conversation.id, sent.requestId)).toBe(content)
  } finally { await f.close() }
}, 30_000)

it.each([
  ['ASCII characters', 'x'.repeat(1_000_001)],
  ['multibyte text', '界'.repeat(350_000)],
  ['JSON escapes', '\u0001'.repeat(200_000)],
] as const)('rejects oversized %s through HTTP and MCP before a Worker message is saved', async (_name, content) => {
  const f = await remoteAgentConversation('codex')
  try {
    const before = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
    for (const source of ['http', 'mcp'] as const) {
      const request = { requestId: randomUUID(), content, intent: 'next_turn',
        expectedConversationId: f.conversation.id, context: f.context }
      if (source === 'http') {
        const { workspaceId, ...context } = f.context
        const response = await f.app.inject({ method: 'POST',
          url: `/api/workspaces/${workspaceId}/agent-chat/messages`,
          headers: graphHeaders(f.writer.token), payload: { ...request, context } })
        expect(response.statusCode).toBe(400)
        expect(response.body).toMatch(/768 KiB|1000000|1,000,000/)
      } else {
        const response = await f.call('agent_chat_send', { request })
        expect(response.error || response.result?.isError).toBeTruthy()
        expect(JSON.stringify(response)).toMatch(/768 KiB|1000000|1,000,000/)
      }
      const after = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
      expect(after.messages).toEqual(before.messages)
      expect(after.turns).toEqual(before.turns)
      expect(after.activeTurn).toBeNull()
    }
    expect(f.provider.prompts).toHaveLength(0)
    expect(f.frames.some(frame => ['conversation.start-turn', 'conversation.initial-turn'].includes(frame.method))).toBe(false)
  } finally { await f.close() }
}, 30_000)

it('rejects individually valid message and System prompt sizes whose Worker envelope exceeds one MiB', async () => {
  const f = await remoteAgentConversation('codex')
  try {
    // Both inputs fit their individual public contracts; their actual binding+prompt does not.
    await f.db.pool.query(`update operator_conversations set record=record || $2::jsonb where id=$1`,
      [f.conversation.id, JSON.stringify({ systemPrompt: {
        value: { text: '界'.repeat(100_000) }, revision: 1, versionId: 'saved-system-prompt',
      } })])
    const before = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
    const response = await f.call('agent_chat_send', { request: { requestId: randomUUID(), content: 'x'.repeat(750 * 1024),
      intent: 'next_turn', expectedConversationId: f.conversation.id, context: f.context } })
    expect(response.error || response.result?.isError).toBeTruthy()
    expect(JSON.stringify(response)).toContain('CHAT_MESSAGE_TOO_LARGE')
    const after = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
    expect(after.messages).toEqual(before.messages)
    expect(after.turns).toEqual(before.turns)
    expect(f.provider.prompts).toHaveLength(0)
  } finally { await f.close() }
}, 30_000)

it.each(['codex', 'claude'] as const)('delivers Worker %s follow-ups with a large saved system prompt', async harness => {
  const f = await remoteAgentConversation(harness)
  try {
    const systemPrompt = { value: { text: '界'.repeat(100_000) }, revision: 1, versionId: 'saved-system-prompt' }
    await f.db.pool.query('update operator_conversations set record=record || $2::jsonb where id=$1',
      [f.conversation.id, JSON.stringify({ systemPrompt })])
    await f.send('Establish the session')
    const sent = await f.send('Continue the same task')
    expect(sent.turn?.delivery).toBe('completed')
    expect(await f.repository.turnContent(f.conversation.id, sent.requestId)).toBe('Continue the same task')
    expect(f.frames).toEqual(expect.arrayContaining([expect.objectContaining({
      method: 'conversation.start-turn', prompt: 'Continue the same task',
      binding: expect.objectContaining({ systemPrompt }),
    })]))
    for (const frame of f.frames) {
      expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(1024 * 1024)
      const callback = { method: 'conversation.authorize', admissionId: frame.admissionId,
        binding: frame.binding, request: frame }
      expect(Buffer.byteLength(JSON.stringify(callback))).toBeLessThanOrEqual(1024 * 1024)
    }
    const before = await f.repository.state(f.conversation.id)
    const rejected = await f.call('agent_chat_send', { request: { requestId: randomUUID(), content: 'x'.repeat(500_000),
      intent: 'next_turn', expectedConversationId: f.conversation.id, context: f.context } })
    expect(rejected.result?.isError).toBe(true)
    expect(JSON.stringify(rejected)).toContain('CHAT_MESSAGE_TOO_LARGE')
    expect(await f.repository.state(f.conversation.id)).toEqual(before)
    expect(f.provider.prompts).toHaveLength(2)
  } finally { await f.close() }
}, 30_000)

it.each((['http', 'mcp'] as const).flatMap(transport =>
  [800_000, 1_000_001, 1_048_576].map(characters => ({ transport, characters }))))(
  'recovers a historical $characters-character Agent message through $transport without admitting another turn', async ({ transport, characters }) => {
  const f = await remoteAgentConversation('codex')
  try {
    const { workspaceId, ...context } = f.context
    const request = { requestId: randomUUID(), content: 'x'.repeat(characters), intent: 'next_turn' as const,
      expectedConversationId: f.conversation.id, context }
    const row = (await f.repository.get(f.conversation.id))!
    await f.repository.admit({ key: row.agent_key, request, context: f.context, delivery: 'queued',
      ownerPrincipalId: f.writer.principal.id })
    expect(await f.repository.claim(f.conversation.id, request.requestId)).toBe(true)
    expect(await f.repository.finish(f.conversation.id, request.requestId, { outcome: 'succeeded' })).toBe(true)
    const before = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
    if (transport === 'http') {
      const send = (input: typeof request, token = f.writer.token) => f.app.inject({ method: 'POST',
        url: `/api/workspaces/${workspaceId}/agent-chat/messages`, headers: graphHeaders(token), payload: input })
      expect((await send(request, f.reader.token)).statusCode).toBe(403)
      const recovered = await send(request)
      expect(recovered.statusCode, recovered.body).toBe(200)
      expect(SendAgentChatMessageResponseSchema.parse(recovered.json())).toMatchObject({
        replayed: true, turn: { requestId: request.requestId, delivery: 'completed' },
      })
      const conflict = await send({ ...request, content: `${request.content.slice(0, -1)}y` })
      expect(conflict.statusCode, conflict.body).toBe(409)
      expect(conflict.body).toContain('AGENT_CHAT_REQUEST_CONFLICT')
      const fresh = await send({ ...request, requestId: randomUUID() })
      expect(fresh.statusCode, fresh.body).toBe(400)
      expect(fresh.body).toContain('768 KiB')
    } else {
      const denied = await f.call('agent_chat_send', { request }, f.reader.token)
      expect(denied.error || denied.result?.isError).toBeTruthy()
      const recovered = SendAgentChatMessageResponseSchema.parse(await f.value('agent_chat_send', { request }))
      expect(recovered).toMatchObject({ replayed: true, turn: { requestId: request.requestId, delivery: 'completed' } })
      const conflict = await f.call('agent_chat_send', { request: { ...request, content: `${request.content.slice(0, -1)}y` } })
      expect(conflict.result?.isError).toBe(true)
      expect(JSON.stringify(conflict)).toContain('AGENT_CHAT_REQUEST_CONFLICT')
      const fresh = await f.call('agent_chat_send', { request: { ...request, requestId: randomUUID() } })
      expect(fresh.error || fresh.result?.isError).toBeTruthy()
      expect(JSON.stringify(fresh)).toContain('768 KiB')
    }
    expect(AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))).toEqual(before)
    expect(await f.repository.turnContent(f.conversation.id, request.requestId)).toBe(request.content)
    expect(f.provider.prompts).toHaveLength(0)
    expect(f.frames).toHaveLength(0)
  } finally { await f.close() }
}, 30_000)

it.each((['codex', 'claude'] as const).flatMap(harness =>
  (['model', 'harness'] as const).map(change => ({ harness, change }))))(
  'applies a Worker $harness $change transition with a large saved system prompt', async ({ harness, change }) => {
    const f = await remoteAgentConversation(harness)
    try {
      const systemPrompt = { value: { text: '界'.repeat(100_000) }, revision: 1, versionId: 'saved-system-prompt' }
      await f.db.pool.query('update operator_conversations set record=record || $2::jsonb where id=$1',
        [f.conversation.id, JSON.stringify({ systemPrompt })])
      await f.send('Establish the session and retain these details')
      const original = (await f.repository.get(f.conversation.id))!
      const configuration = change === 'model' ? { ...f.configuration.harness, model: 'changed-model' }
        : workerConversationFixture('agent', harness === 'codex' ? 'claude' : 'codex').configuration.harness
      const saved = AgentMutationResultSchema.parse(await f.update(configuration, { matchingProfile: true }))
      const before = await f.repository.state(f.conversation.id)
      const rejected = await f.call('agent_chat_send', { request: { requestId: randomUUID(), content: 'x'.repeat(500_000),
        intent: 'next_turn', expectedConversationId: f.conversation.id, context: f.context } })
      expect(rejected.result?.isError).toBe(true)
      expect(JSON.stringify(rejected)).toContain('CHAT_MESSAGE_TOO_LARGE')
      expect(await f.repository.state(f.conversation.id)).toEqual(before)
      expect(f.providers.reduce((count, provider) => count + provider.prompts.length, 0)).toBe(1)
      const sent = await f.send('Continue using the saved settings')
      expect(sent.turn?.delivery).toBe('completed')
      expect(sent.turn?.error).toBeUndefined()
      const applied = (await f.repository.get(f.conversation.id))!
      expect(applied.agent_configuration_version_id).toBe(saved.value.agent.configurationVersionId)
      if (change === 'model') expect(applied.native_session_id).toBe(original.native_session_id)
      else expect(applied.native_session_id).not.toBe(original.native_session_id)
      expect(await f.binding()).toMatchObject({ systemPrompt,
        owner: { configurationVersionId: saved.value.agent.configurationVersionId } })
      expect(f.providers.reduce((count, provider) => count + provider.prompts.length, 0)).toBe(2)
      for (const frame of f.frames) {
        expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(1024 * 1024)
        expect(Buffer.byteLength(JSON.stringify({ method: 'conversation.authorize', admissionId: frame.admissionId,
          binding: frame.binding, request: frame }))).toBeLessThanOrEqual(1024 * 1024)
      }
    } finally { await f.close() }
  }, 30_000)
