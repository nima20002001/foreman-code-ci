import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { SessionPreferencesSchema } from '@foreman-code/contracts'
import { WorkerConversationBindingSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })
async function journal(capacity = 1000) {
  const root = await mkdtemp(join(tmpdir(), 'worker-chat-journal-'))
  closing.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'operations.json')
  const store = await RemoteOperationJournal.open(path, { initializeNewInstallation: true, capacity })
  closing.push(() => store.close())
  return { path, store, chats: store.conversations }
}
async function opened(kind: 'operator' | 'agent' = 'operator') {
  const f = workerConversationFixture(kind)
  const j = await journal()
  await j.chats.receive(f.binding, f.connection)
  await j.chats.reserveCreation(f.binding, 'initial-message', commandInputHash({ mode: 'create' }))
  await j.chats.bindSession(f.binding, f.session, f.nativeOwner)
  return { ...j, ...f }
}

it('retains separate native session generations of the same conversation across restart', async () => {
  const f = await opened('agent')
  const binding = WorkerConversationBindingSchema.parse({ ...f.binding, generation: randomUUID() })
  await f.chats.runtimeReleased(f.binding)
  await expect(f.chats.receive(binding, f.connection)).rejects.toThrow('previous native session')
  await f.chats.closeRequested(f.binding)
  await f.chats.closeConfirmed(f.binding)
  const previous = await f.chats.read(f.binding)
  const session = { ...f.session, nativeSessionId: 'replacement-native-session' }
  await f.chats.receive(binding, f.connection)
  await f.chats.reserveCreation(binding, 'replacement-message', commandInputHash('replacement-message'))
  await f.chats.bindSession(binding, session, { ...f.nativeOwner, sessionId: session.nativeSessionId })
  expect(await f.chats.read(f.binding)).toEqual(previous)
  expect(await f.chats.read(binding)).toMatchObject({ session, closed: false })
  await f.store.close()
  const reopened = await RemoteOperationJournal.open(f.path)
  closing.push(() => reopened.close())
  expect(await reopened.conversations.read(f.binding)).toEqual(previous)
  expect(await reopened.conversations.read(binding)).toMatchObject({ session, closed: false })
  await expect(reopened.conversations.bindSession(binding, f.session, f.nativeOwner)).rejects.toThrow('replace')
})

it('keeps a persisted Agent session busy for runtime refresh until its own closure is confirmed', async () => {
  const f = await opened()
  await expect(f.store.assertRuntimeQuiescent()).rejects.toThrow('unfinished work')
  expect((await f.chats.read(f.binding))?.closed).toBe(false)
  await f.store.close()
  const reopened = await RemoteOperationJournal.open(f.path)
  closing.push(() => reopened.close())
  expect(await reopened.isRuntimeQuiescent()).toBe(false)
  expect((await reopened.conversations.read(f.binding))?.closed).toBe(false)
  await reopened.conversations.closeConfirmed(f.binding)
  expect(await reopened.isRuntimeQuiescent()).toBe(true)
  await expect(reopened.assertRuntimeQuiescent()).resolves.toBeUndefined()
})

it('retains Claude callback consumption across reopen and rejects changed input or another native session', async () => {
  const f = workerConversationFixture('agent', 'claude')
  const j = await journal()
  await j.chats.receive(f.binding, f.connection)
  await j.chats.reserveCreation(f.binding, 'create', commandInputHash('create'))
  await j.chats.bindSession(f.binding, f.session, f.nativeOwner)
  const identity = { ownerPrincipalId: 'sender', attemptId: 'request', nativeSessionId: f.session.nativeSessionId,
    nativeMessageId: 'native-message', clientCorrelationId: 'message', generation: 'generation', toolUseId: 'tool',
    nativeRequestId: 'permission', nativeRequestType: 'can_use_tool' as const }
  const record = { identity, toolName: 'Read', inputHash: commandInputHash({ path: 'accepted.md' }),
    state: 'submitted' as const, selectedOptionId: 'allow_once', acknowledged: false }
  const key = commandInputHash(identity)
  const callbacks = j.chats.claudeCallbackJournal(f.binding)
  await callbacks.write(key, record)
  await callbacks.write(key, { ...record, acknowledged: true })
  await callbacks.write(key, record)
  await j.store.close()
  const reopened = await RemoteOperationJournal.open(j.path)
  closing.push(() => reopened.close())
  const recovered = reopened.conversations.claudeCallbackJournal(f.binding)
  expect(await recovered.read(key)).toEqual({ ...record, acknowledged: true })
  expect(await recovered.forTool(identity)).toEqual({ ...record, acknowledged: true })
  expect(await recovered.acknowledged(f.session.nativeSessionId)).toHaveLength(1)
  await expect(recovered.write(key, { ...record, inputHash: commandInputHash('different-input') }))
    .rejects.toThrow('different input')
  const foreign = { ...record, identity: { ...identity, nativeSessionId: 'other-session' } }
  await expect(recovered.write(commandInputHash(foreign.identity), foreign)).rejects.toThrow('another native session')
})

it('persists the effective Plan mode with the accepted worker turn and rejects changed-mode replay', async () => {
  const f = await opened()
  const hash = commandInputHash({ prompt: 'Accepted Plan task', mode: 'plan' })
  await f.chats.reserveTurn(f.binding, 'plan-task', hash, { mode: 'plan' })
  await f.store.close()
  const reopened = await RemoteOperationJournal.open(f.path)
  closing.push(() => reopened.close())
  expect((await reopened.conversations.read(f.binding))?.turns.find(turn => turn.correlationId === 'plan-task')?.sessionMode)
    .toBe('plan')
  await expect(reopened.conversations.reserveTurn(f.binding, 'plan-task', hash, { mode: 'regular' }))
    .rejects.toThrow('original turn input changed')
})

it('reserves one native creation concurrently and retains its real session across reopen', async () => {
  const f = workerConversationFixture()
  const j = await journal()
  await j.chats.receive(f.binding, f.connection)
  const create = () => j.chats.reserveCreation(f.binding, 'original-request', commandInputHash({ mode: 'create' }))
  const reservations = await Promise.all([create(), create()])
  expect(reservations.filter(value => value.dispatch)).toHaveLength(1)
  await j.chats.bindSession(f.binding, f.session, f.nativeOwner)
  await j.store.close()
  const reopened = await RemoteOperationJournal.open(j.path)
  closing.push(() => reopened.close())
  expect((await reopened.conversations.read(f.binding))?.session).toEqual(f.session)
  expect((await reopened.conversations.reserveCreation(f.binding, 'original-request', commandInputHash({ mode: 'create' }))).dispatch)
    .toBe(false)
  await expect(reopened.conversations.reserveCreation(f.binding, 'replacement', commandInputHash({ mode: 'create' })))
    .rejects.toThrow('another request')
})

it('keeps successive turns on one chat session and fences an unresolved turn', async () => {
  const f = await opened()
  const reserve = (id: string) => f.chats.reserveTurn(f.binding, id, commandInputHash({ prompt: id }))
  expect((await reserve('first')).dispatch).toBe(true)
  await expect(reserve('second')).rejects.toThrow('pending')
  await f.chats.submitted(f.binding, 'first', { nativeTurnId: 'native-first' })
  await f.chats.finishTurn(f.binding, 'first', { outcome: 'succeeded' })
  expect((await reserve('second')).dispatch).toBe(true)
  expect((await reserve('second')).dispatch).toBe(false)
  expect((await f.chats.read(f.binding))?.session).toEqual(f.session)
  await expect(f.chats.reserveTurn(f.binding, 'second', commandInputHash({ prompt: 'changed' })))
    .rejects.toThrow('input changed')
})

it('retains one access handoff across reopen and changes only the native process and App MCP access', async () => {
  const f = await opened()
  const next = { ...f.binding, appMcpAccess: 'scoped' as const }
  const reserved = await f.chats.reserveApplicationAccess(f.binding, next, 'access-change', f.session)
  expect(reserved).toMatchObject({ applied: false, reserved: true })
  await expect(f.chats.reserveTurn(f.binding, 'new-message', commandInputHash('new-message')))
    .rejects.toThrow('access change needs recovery')
  await f.store.close()
  const reopened = await RemoteOperationJournal.open(f.path)
  closing.push(() => reopened.close())
  expect(await reopened.conversations.reserveApplicationAccess(f.binding, next, 'access-change', f.session))
    .toMatchObject({ applied: false, reserved: false })
  await expect(reopened.conversations.reserveApplicationAccess(f.binding, next, 'different-change', f.session))
    .rejects.toThrow('needs recovery')
  const newOwner = { ...f.nativeOwner, processIdentityDigest: 'c'.repeat(64) }
  await reopened.conversations.recoveredOwner(f.binding, f.connection, f.nativeOwner, newOwner, { targetBinding: next })
  const saved = await reopened.conversations.read(next)
  expect(saved?.session).toEqual(f.session)
  expect(saved?.binding).toEqual(next)
  expect(saved?.nativeOwner).toEqual(newOwner)
  expect(saved?.creation).toEqual(reserved.record.creation)
  expect(saved?.applicationAccessChange?.state).toBe('applied')
  expect(await reopened.conversations.reserveApplicationAccess(f.binding, next, 'access-change', f.session))
    .toMatchObject({ applied: true, reserved: false })
})

it('rejects pending work, foreign sessions and changed saved owners before reserving an access handoff', async () => {
  const f = await opened()
  const next = { ...f.binding, appMcpAccess: 'scoped' as const }
  const before = await f.chats.read(f.binding)
  await expect(f.chats.reserveApplicationAccess(f.binding, next, 'foreign-session', {
    ...f.session, nativeSessionId: 'another-session',
  })).rejects.toThrow('settled Operator')
  await expect(f.chats.reserveApplicationAccess(f.binding, { ...next, workingDirectory: '/other-project' },
    'changed-directory', f.session)).rejects.toThrow('settled Operator')
  expect(await f.chats.read(f.binding)).toEqual(before)
  await f.chats.reserveTurn(f.binding, 'active-message', commandInputHash('active-message'))
  await expect(f.chats.reserveApplicationAccess(f.binding, next, 'active-change', f.session))
    .rejects.toThrow('settled Operator')
  expect((await f.chats.read(f.binding))?.applicationAccessChange).toBeUndefined()
})

it('does not reoffer uncertain input or lose a completed result on an empty history read', async () => {
  const f = await opened()
  await f.chats.reserveTurn(f.binding, 'uncertain', commandInputHash({ prompt: 'task' }))
  await f.chats.finishTurn(f.binding, 'uncertain')
  expect((await f.chats.reserveTurn(f.binding, 'uncertain', commandInputHash({ prompt: 'task' }))).dispatch).toBe(false)
  await expect(f.chats.reserveTurn(f.binding, 'next', commandInputHash({ prompt: 'next' }))).rejects.toThrow('pending')
  await f.chats.finishTurn(f.binding, 'uncertain', { outcome: 'succeeded' })
  await f.chats.finishTurn(f.binding, 'uncertain')
  expect((await f.chats.read(f.binding))?.turns[0]).toMatchObject({ status: 'completed', result: { outcome: 'succeeded' } })
})

it('persists compaction reservation/outcome and never dispatches the same request twice', async () => {
  const f = await opened()
  const hash = commandInputHash({ correlationId: 'compact' })
  const reserved = await f.chats.reserveCompact(f.binding, 'compact-request', hash)
  expect(reserved.dispatch).toBe(true)
  await f.chats.compactProgress(f.binding, { ...reserved.state, status: 'uncertain', dispatchPhase: 'dispatched' })
  expect((await f.chats.reserveCompact(f.binding, 'compact-request', hash)).dispatch).toBe(false)
  await expect(f.chats.reserveTurn(f.binding, 'task', commandInputHash({ prompt: 'task' }))).rejects.toThrow('pending')
  const completed = { ...reserved.state, status: 'completed' as const, nativeOperationId: 'observed-boundary' }
  await f.chats.compactProgress(f.binding, completed)
  await f.store.close()
  const reopened = await RemoteOperationJournal.open(f.path)
  closing.push(() => reopened.close())
  expect((await reopened.conversations.reserveCompact(f.binding, 'compact-request', hash))).toMatchObject({
    dispatch: false, state: { status: 'completed', nativeOperationId: 'observed-boundary' } })
  await expect(reopened.conversations.compactProgress(f.binding, { ...completed, nativeSessionId: 'another-session' }))
    .rejects.toThrow('does not belong')
})

it('isolates two nodes with the same Agent and rejects another role/profile binding', async () => {
  const f = workerConversationFixture('agent')
  const j = await journal()
  const second = { ...f.binding, owner: { ...f.binding.owner, conversationId: randomUUID(), workflowNodeId: 'second-node' } }
  await j.chats.receive(f.binding, f.connection)
  await j.chats.receive(second, f.connection)
  const preferences = SessionPreferencesSchema.parse({ autoCompact: 'off' })
  await j.chats.preferences(f.binding, preferences, null)
  expect((await j.chats.read(second))?.desiredPreferences).toBeNull()
  await expect(j.chats.read({ ...f.binding, profile: { ...f.binding.profile, instanceRevision: 'replacement' } }))
    .rejects.toThrow('binding changed')
  await expect(j.chats.receive({ ...f.binding, owner: { kind: 'operator', operatorId: 'application-operator',
    conversationId: f.binding.owner.conversationId, configurationVersionId: f.configuration.id,
    configurationHash: f.binding.owner.configurationHash } }, f.connection)).rejects.toThrow('another owner')
})

it('fences a closing chat before physical closure and preserves it when capacity is exhausted', async () => {
  const f = workerConversationFixture()
  const j = await journal(1)
  await j.chats.receive(f.binding, f.connection)
  await j.chats.closeRequested(f.binding)
  await expect(j.chats.reserveCreation(f.binding, 'late', commandInputHash({ mode: 'create' }))).rejects.toThrow('closing')
  expect((await j.chats.read(f.binding))?.closed).toBe(false)
  await j.chats.closeConfirmed(f.binding)
  await expect(j.chats.receive({ ...f.binding, owner: { ...f.binding.owner, conversationId: randomUUID() } }, f.connection))
    .rejects.toThrow('full')
  expect((await j.chats.read(f.binding))?.closed).toBe(true)
})

it('retains native session and input records when a settled owner is recovered on the same paired installation', async () => {
  const f = await opened()
  const next = { ...f.nativeOwner, processIdentityDigest: 'd'.repeat(64) }
  const connection = { ...f.connection, bootId: randomUUID(), connectionEpoch: randomUUID(), connectionGeneration: 2 }
  const before = await f.chats.read(f.binding)
  await f.chats.recoveredOwner(f.binding, connection, f.nativeOwner, next)
  const after = await f.chats.read(f.binding)
  expect(after?.nativeOwner).toEqual(next)
  expect(after?.session).toEqual(before?.session)
  expect(after?.turns).toEqual(before?.turns)
  expect(after?.creation).toEqual(before?.creation)
  expect(after?.connection).toEqual(connection)
})

it('refuses owner recovery across a pending input, foreign session or changed device authority', async () => {
  const f = await opened()
  const next = { ...f.nativeOwner, processIdentityDigest: 'd'.repeat(64) }
  await expect(f.chats.recoveredOwner(f.binding, { ...f.connection, authorizationRevision: 2 }, f.nativeOwner, next))
    .rejects.toThrow('authority changed')
  await expect(f.chats.recoveredOwner(f.binding, f.connection, f.nativeOwner, { ...next, sessionId: 'foreign-session' }))
    .rejects.toThrow('settled conversation')
  await f.chats.reserveTurn(f.binding, 'pending-message', commandInputHash('pending-input'))
  await expect(f.chats.recoveredOwner(f.binding, f.connection, f.nativeOwner, next)).rejects.toThrow('settled conversation')
  expect((await f.chats.read(f.binding))?.nativeOwner).toEqual(f.nativeOwner)
})

it('persists a rejected turn across reopen and allows new input while retaining the old receipt', async () => {
  const f = await opened()
  const result = { outcome: 'failed' as const, error: { code: 'NATIVE_INPUT_NOT_DELIVERED', message: 'Not offered', retryable: true } }
  const hash = commandInputHash('rejected')
  await f.chats.reserveTurn(f.binding, 'rejected', hash)
  await f.chats.rejectTurn(f.binding, 'rejected', result)
  await f.store.close()
  const reopened = await RemoteOperationJournal.open(f.path)
  closing.push(() => reopened.close())
  expect((await reopened.conversations.read(f.binding))?.turns[0]).toMatchObject({ status: 'rejected', result })
  expect((await reopened.conversations.reserveTurn(f.binding, 'rejected', hash)).dispatch).toBe(false)
  await reopened.conversations.finishTurn(f.binding, 'rejected')
  expect((await reopened.conversations.read(f.binding))?.turns[0]?.status).toBe('rejected')
  await expect(reopened.conversations.submitted(f.binding, 'rejected', { nativeTurnId: 'late-native-id' }))
    .rejects.toThrow('rejected native input')
  expect((await reopened.conversations.reserveTurn(f.binding, 'later', commandInputHash('later'))).dispatch).toBe(true)
})

it('updates a replacement owner before its reserved input but refuses submitted or unrelated pending input', async () => {
  const f = await opened()
  const next = { ...f.nativeOwner, processIdentityDigest: 'd'.repeat(64) }
  await f.chats.reserveTurn(f.binding, 'pending', commandInputHash('pending'))
  await expect(f.chats.recoveredOwner(f.binding, f.connection, f.nativeOwner, next, { pendingCorrelationId: 'foreign' }))
    .rejects.toThrow('settled conversation')
  await f.chats.recoveredOwner(f.binding, f.connection, f.nativeOwner, next, { pendingCorrelationId: 'pending' })
  expect((await f.chats.read(f.binding))?.ownerTransitions).toEqual([{ previous: f.nativeOwner, next }])
  await f.chats.submitted(f.binding, 'pending', { nativeTurnId: 'submitted' })
  await expect(f.chats.recoveredOwner(f.binding, f.connection, next, f.nativeOwner, { pendingCorrelationId: 'pending' }))
    .rejects.toThrow('settled conversation')
})

it('reserves initial creation and input together and preserves rejected startup replay after another reservation', async () => {
  const f = workerConversationFixture('operator', 'claude')
  const j = await journal()
  await j.chats.receive(f.binding, f.connection)
  const first = () => j.chats.reserveInitialTurn(f.binding, 'first-operation', commandInputHash('create'),
    'first-turn', commandInputHash('prompt'), 'regular')
  expect((await first()).dispatch).toBe(true)
  await j.chats.rejectTurn(f.binding, 'first-turn', { outcome: 'failed', error: {
    code: 'NATIVE_INPUT_NOT_DELIVERED', message: 'Startup failed', retryable: true,
  } }, 'first-operation')
  await expect(j.chats.reserveInitialTurn(f.binding, 'other-operation', commandInputHash('other'),
    'first-turn', commandInputHash('prompt'), 'regular')).rejects.toThrow('initial turn input changed')
  expect((await j.chats.read(f.binding))?.creation).toMatchObject({ operationId: 'first-operation', status: 'rejected' })
  expect((await j.chats.reserveInitialTurn(f.binding, 'later-operation', commandInputHash('later-create'),
    'later-turn', commandInputHash('later'), 'regular')).dispatch).toBe(true)
  expect((await first()).dispatch).toBe(false)
  expect((await j.chats.read(f.binding))?.creation?.operationId).toBe('later-operation')
})
