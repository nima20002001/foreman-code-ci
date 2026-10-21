import { NativeHarnessEventSchema, type NativeSessionReference } from '@foreman-code/contracts'
import { describe, expect, it, vi } from 'vitest'
import { nativeCorrelation } from '../src/modules/conversations/operatorChatRepository.js'
import { DomainError } from '../src/modules/errors.js'
import { registerOperatorChatFixture, type OperatorChatFixture, waitFor } from './helpers/operatorChatFixture.js'

const connectionString = process.env.TEST_DATABASE_URL

let pool: OperatorChatFixture['pool']
let access: OperatorChatFixture['access']
let owner: OperatorChatFixture['owner']
let repository: OperatorChatFixture['repository']
let manager: OperatorChatFixture['manager']
let authority: OperatorChatFixture['authority']
let chat: OperatorChatFixture['chat']

registerOperatorChatFixture(fixture => {
  ({ pool, access, owner, repository, manager, authority, chat } = fixture)
}, () => chat)

describe.skipIf(!connectionString)('Operator chat persistence and native binding with stubbed authority', () => {
  it('blocks an existing native session when its Operator MCP installation is removed', async () => {
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: 'before-removal', content: 'Hello' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    const turns = manager.turns
    authority.setup = async () => ({ harness: 'codex', status: 'setup_required', endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() })
    authority.prepare = async () => { throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'Install and enable Operator MCP first.', 409) }
    await chat.send(conversation.id, { requestId: 'after-removal', content: 'Continue' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'error')
    expect(manager.turns).toBe(turns)
    expect((await chat.get(conversation.id, owner)).error).toContain('Install and enable')
  })
  it('keeps sidebar order tied to messages, not background status reconciliation', async () => {
    const first = await chat.create(owner)
    const second = await chat.create(owner)
    await repository.beginTurn(first.id, { requestId: 'order-first', content: 'First topic' }, owner.id)
    await repository.beginTurn(second.id, { requestId: 'order-second', content: 'Second topic' }, owner.id)
    await repository.pending(first.id, 'order-first')
    expect((await chat.summaries(owner)).map((entry) => entry.conversationId)).toEqual([second.id, first.id])
    expect((await chat.summaries(owner, 1)).map((entry) => entry.conversationId)).toEqual([second.id])
    expect(await chat.summaries(owner, undefined, true)).toEqual([])
  })

  it('persists activity monotonically, fences late events, and pages exact bigint identities', async () => {
    const conversation = await chat.create(owner)
    manager.autoFinish = false
    await chat.send(conversation.id, { requestId: 'activity-request', content: 'Read the fixture' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'active')
    await pool.query("select setval(pg_get_serial_sequence('operator_conversation_activity','sequence'),$1::bigint,false)", ['9007199254740993'])
    const started = { id: 'native-read', requestId: 'activity-request', kind: 'file_read' as const, title: 'Read fixture', status: 'running' as const, input: 'fixture.txt' }
    const first = await repository.activity.append(conversation.id, 'activity-request', started)
    expect(first?.activity.sequence).toBe('9007199254740993')
    const completed = { ...started, status: 'completed' as const, output: 'Read result' }
    await repository.activity.append(conversation.id, 'activity-request', completed)
    expect(await repository.activity.append(conversation.id, 'activity-request', started)).toBeUndefined()
    expect(await repository.activity.append(conversation.id, 'activity-request', completed)).toBeUndefined()
    const second = await repository.activity.append(conversation.id, 'activity-request', { ...started, id: 'native-command', kind: 'tool' })
    expect(await chat.summaries(owner)).toEqual([
      expect.objectContaining({ conversationId: conversation.id, backgroundActivity: 'running' }),
    ])
    const page = await chat.activityPage(conversation.id, owner, { limit: 1 })
    expect(page.nextCursor).toBe(second?.activity.sequence)
    const older = await chat.activityPage(conversation.id, owner, { limit: 1, before: page.nextCursor! })
    expect(older.activities[0]).toMatchObject({ sequence: '9007199254740993', status: 'completed', output: 'Read result' })
    expect(older.nextCursor).toBeNull()
    manager.finish(nativeCorrelation(conversation.id, 'activity-request'))
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    const final = await chat.get(conversation.id, owner)
    expect(final.messages[0]?.requestId).toBe('activity-request')
    expect(final.activities?.find((entry) => entry.id === 'native-command')?.status).toBe('unknown')
    expect(await chat.summaries(owner)).toEqual([
      expect.objectContaining({ conversationId: conversation.id, backgroundActivity: 'unknown' }),
    ])
    expect(await repository.activity.append(conversation.id, 'activity-request', completed)).toBeUndefined()
    const other = (await access.issue({ name: 'activity other owner', audience: 'operator', grants: owner.grants, expiresAt: new Date(Date.now() + 600_000) })).principal
    expect(await chat.summaries(other)).toEqual([])
    await expect(chat.activityPage(conversation.id, other, {})).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
  })

  it('settles a completed native turn after authoritative tool history corrects its streamed result', async () => {
    const turnId = 'reconciled-turn'
    const toolEvent = (session: NativeSessionReference, type: string, output: string) => NativeHarnessEventSchema.parse({
      connectionId: 'native-connection', sequence: type === 'item.completed' ? 12 : 0,
      occurredAt: '2026-10-01T00:00:00Z', type,
      payload: { threadId: session.nativeSessionId, turnId, item: {
        id: 'completed-tool', type: 'commandExecution', status: 'completed',
        command: 'read fixture', aggregatedOutput: output,
      } },
    })
    const start = vi.spyOn(manager, 'startTurn').mockImplementation(async function* (session, input) {
      await input.onSubmitted?.(turnId)
      yield toolEvent(session, 'item.completed', 'streamed result')
    })
    vi.spyOn(manager, 'reconcile').mockImplementation(async (session, correlationId) => ({
      correlationId, nativeTurnId: turnId,
      events: [toolEvent(session, 'item.snapshot', 'saved result')], pendingInteractions: [],
      terminalResult: { outcome: 'succeeded', output: 'Native result' },
    }))
    const conversation = await chat.create(owner)
    await chat.send(conversation.id, { requestId: 'reconciled-tool', content: 'Read the fixture' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    const state = await chat.get(conversation.id, owner)
    expect(state.activeRequestId).toBeNull()
    expect(state.lastResult).toEqual({ outcome: 'succeeded', output: 'Native result' })
    expect(state.activities).toContainEqual(expect.objectContaining({ id: 'completed-tool',
      status: 'completed', output: 'saved result' }))
    expect(start).toHaveBeenCalledTimes(1)
    expect(manager.disposals).toBe(1)
    const retained = await pool.query(`select native_closure_state as "closureState",
      terminal_history_persisted as "historyPersisted",result from operator_conversation_turns
      where conversation_id=$1 and request_id=$2`, [conversation.id, 'reconciled-tool'])
    expect(retained.rows).toEqual([{ closureState: 'closed', historyPersisted: true, result: state.lastResult }])
  })

  it('hides empty drafts until the first message and supports owner-scoped deletion and Undo', async () => {
    const conversation = await chat.create(owner)
    const abandoned = await chat.create(owner, 'An abandoned named draft')
    expect(await chat.summaries(owner)).toEqual([])
    expect(await chat.list(owner)).toEqual([])
    expect((await chat.get(conversation.id, owner)).messages).toEqual([])
    expect((await chat.get(abandoned.id, owner)).messages).toEqual([])
    await chat.send(conversation.id, { requestId: 'visible-message', content: 'A named topic' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
    expect(await chat.summaries(owner)).toEqual([expect.objectContaining({ conversationId: conversation.id, title: 'A named topic' })])
    expect((await chat.list(owner)).map(item => item.id)).toEqual([conversation.id])
    const other = (await access.issue({ name: 'other', audience: 'operator', grants: owner.grants, expiresAt: new Date(Date.now() + 600_000) })).principal
    expect(await chat.summaries(other)).toEqual([])
    await expect(chat.setDeleted(conversation.id, other, true)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
    await chat.setDeleted(conversation.id, owner, true)
    expect(await chat.summaries(owner)).toEqual([])
    await expect(chat.get(conversation.id, owner)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
    await expect(chat.send(conversation.id, { requestId: 'deleted', content: 'No' }, owner)).rejects.toMatchObject({ code: 'CONVERSATION_NOT_FOUND' })
    await chat.setDeleted(conversation.id, owner, true)
    await chat.setDeleted(conversation.id, owner, false)
    expect((await chat.get(conversation.id, owner)).messages).toHaveLength(2)
    expect(await chat.summaries(owner)).toHaveLength(1)
  })

  it('requires an active response to stop before a chat can be deleted', async () => {
    const conversation = await chat.create(owner)
    manager.autoFinish = false
    await chat.send(conversation.id, { requestId: 'delete-busy', content: 'Running' }, owner)
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'active')
    await expect(chat.setDeleted(conversation.id, owner, true)).rejects.toMatchObject({ code: 'CONVERSATION_TURN_ACTIVE' })
    expect((await repository.active(conversation.id))?.deleted_at).toBeNull()
    manager.finish(nativeCorrelation(conversation.id, 'delete-busy'))
    await waitFor(async () => (await chat.get(conversation.id, owner)).turnState === 'idle')
  })

})
