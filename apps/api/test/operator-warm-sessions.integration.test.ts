import { performance } from 'node:perf_hooks'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import type { OperatorChatSettings, OperatorConversationState } from '@foreman-code/contracts'
import { OperatorChatService } from '../src/modules/conversations/operatorChat.js'
import { PostgresOperatorRepository } from '../src/modules/operators/postgres.js'
import { useCodexChatDelivery } from './codex-chat-delivery.helpers.js'
import { calls, processesForRequests, until } from './fixtures/codex-test-helpers.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

describe.skipIf(!process.env.TEST_DATABASE_URL)('Operator warm Codex sessions', () => {
  const f = useCodexChatDelivery()
  const processes = () => processesForRequests(f.native.directory, 'thread/start', 'thread/resume', 'turn/start')
  const idle = (id: string) => until(async () => (await f.readOperator(id)).turnState === 'idle' || undefined)

  async function turn(id: string, requestId: string) {
    const startedAt = performance.now()
    let firstOutput!: (milliseconds: number) => void
    const output = new Promise<number>(resolve => { firstOutput = resolve })
    const unsubscribe = f.operatorChat.events.subscribe(id, event => {
      if (event.type === 'delta' && event.data.requestId === requestId) firstOutput(performance.now() - startedAt)
    })
    try {
      await f.sendOperator(id, requestId, 'Reply once')
      const milliseconds = await output
      await idle(id)
      return milliseconds
    } finally { unsubscribe() }
  }

  async function closed(processPid: unknown) {
    await until(async () => (await calls(f.native.directory)).some(entry => entry.exited === processPid) || undefined)
  }

  function restart() {
    f.operatorChat = new OperatorChatService(f.messages, new PostgresOperatorRepository(f.database.pool),
      f.resolver, f.native.directory, f.authority)
    f.services.operatorChat = f.operatorChat
  }

  it('reuses the live process through authenticated MCP and emits the second reply faster than a cold turn', async () => {
    const id = await f.createOperator()
    const coldMs = await turn(id, 'cold')
    const original = await processes()
    const first = await f.readOperator(id)
    const sessionId = (await f.messages.active(id))!.native_session_id
    const warmMs = await turn(id, 'warm')
    console.info('Operator Codex process timing', { coldMs, warmMs,
      coldProcessStarts: original.length, secondTurnProcessStarts: (await processes()).length - original.length })
    expect(await processes()).toEqual(original)
    expect(warmMs).toBeLessThan(coldMs)
    expect((await f.readOperator(id)).messages.map(message => message.requestId)).toEqual(['cold', 'cold', 'warm', 'warm'])
    expect((await f.messages.active(id))?.native_session_id).toBe(sessionId)
    await expectMcpAccessDenied(f.reader.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: id, request: { requestId: 'denied', content: 'Must not start a turn' },
    } }))
    expect((await f.readOperator(id)).messages).toHaveLength(4)
    expect((await f.readOperator(id)).conversation.operatorConfigurationVersionId).toBe(first.conversation.operatorConfigurationVersionId)
  })

  it('closes the warm process on deletion and cold-resumes the saved session after restore', async () => {
    const id = await f.createOperator()
    await turn(id, 'before-delete')
    const original = (await processes())[0]!
    const sessionId = (await f.messages.active(id))!.native_session_id
    expect((await calls(f.native.directory)).some(entry => entry.exited === original.pid)).toBe(false)
    const deleted = await f.writer.callTool({ name: 'operator_chat_delete', arguments: { conversationId: id } })
    expect(deleted.isError).not.toBe(true)
    await closed(original.pid)
    const restored = await f.writer.callTool({ name: 'operator_chat_restore', arguments: { conversationId: id } })
    expect(restored.isError).not.toBe(true)
    await turn(id, 'after-restore')
    expect(await processes()).toHaveLength(2)
    expect((await f.messages.active(id))!.native_session_id).toBe(sessionId)
  })

  it('cold-resumes after service shutdown without replaying the completed turn', async () => {
    const id = await f.createOperator()
    await turn(id, 'before-restart')
    const original = (await processes())[0]!
    const sessionId = (await f.messages.active(id))!.native_session_id
    expect((await calls(f.native.directory)).some(entry => entry.exited === original.pid)).toBe(false)
    await f.operatorChat.shutdown()
    await closed(original.pid)
    restart()
    await turn(id, 'after-restart')
    expect(await processes()).toHaveLength(2)
    expect((await f.messages.active(id))!.native_session_id).toBe(sessionId)
    expect(await f.native.wire('turn/start')).toHaveLength(2)
  })

  it('expires idle sessions after five minutes and retains their cold resume identity', async () => {
    const id = await f.createOperator()
    const schedule = globalThis.setTimeout
    let expire: (() => void) | undefined
    const clock = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, milliseconds, ...args) => {
      if (milliseconds === 5 * 60_000) expire = () => callback(...args)
      return schedule(callback, milliseconds, ...args)
    })
    let original: Awaited<ReturnType<typeof processes>>[number]
    let sessionId: string | null
    try {
      await turn(id, 'before-idle')
      original = (await processes())[0]!
      sessionId = (await f.messages.active(id))!.native_session_id
      expect((await calls(f.native.directory)).some(entry => entry.exited === original.pid)).toBe(false)
      expect(expire).toBeTypeOf('function')
      expire!()
    } finally { clock.mockRestore() }
    await closed(original.pid)
    await turn(id, 'after-idle')
    expect(await processes()).toHaveLength(2)
    expect((await f.messages.active(id))!.native_session_id).toBe(sessionId)
  })

  it('retains presentation changes and closes the process when execution settings change', async () => {
    const id = await f.createOperator()
    await turn(id, 'original-settings')
    const original = await processes()
    const send = async (requestId: string, settings: OperatorChatSettings) => {
      const result = await f.writer.callTool({ name: 'operator_chat_send', arguments: {
        conversationId: id, request: { requestId, content: 'Reply once', settings },
      } })
      const state = result.isError ? await f.readOperator(id) : undefined
      expect(result.isError, JSON.stringify({ result, state })).not.toBe(true)
      await idle(id)
    }
    await send('thinking-settings', { ...f.settings, showThinking: true })
    expect(await processes()).toEqual(original)
    await send('effort-settings', { ...f.settings, reasoningEffort: 'medium' })
    expect(await processes()).toHaveLength(original.length + 1)
    await closed(original[0]!.pid)
    const read = await f.writer.callTool({ name: 'operator_chat_get', arguments: { conversationId: id } })
    expect((decodeMcpToolResult(read) as OperatorConversationState).settings).toMatchObject({ reasoningEffort: 'medium' })
  })

  it('closes the source warm process when a provider account change creates a linked conversation', async () => {
    const id = await f.createOperator()
    await turn(id, 'source')
    const original = (await processes())[0]!
    const before = await f.readOperator(id)
    const result = await f.writer.callTool({ name: 'operator_chat_send', arguments: {
      conversationId: id, request: { requestId: 'account-change', content: 'Reply once',
        settings: { ...f.settings, accountId: randomUUID() }, forkExpectedRevision: before.revision },
    } })
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    const next = (decodeMcpToolResult(result) as { state: OperatorConversationState }).state
    expect(next.conversation.id).not.toBe(id)
    await idle(next.conversation.id)
    expect((await calls(f.native.directory)).some(entry => entry.exited === original.pid)).toBe(true)
    expect(await processes()).toHaveLength(2)
    expect((await f.readOperator(id)).conversation.operatorConfigurationVersionId)
      .toBe(before.conversation.operatorConfigurationVersionId)
  })
})
