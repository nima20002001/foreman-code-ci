import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { RemoteOperationJournal } from '../runs/remote/operationJournal.js'
import { RUNTIME_JOURNAL_RETENTION_MS } from '../runs/remote/runtimeJournalArchive.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

const closing: Array<() => Promise<void>> = []
afterEach(async () => { for (const close of closing.splice(0).reverse()) await close() })

it('persists a workflow receipt with the conversation fixture device identity', async () => {
  const root = await mkdtemp(join(process.cwd(), '.conversation-retention-'))
  closing.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'operations.json')
  let journal = await RemoteOperationJournal.open(path, { initializeNewInstallation: true })
  closing.push(() => journal.close())
  const fixture = workerConversationFixture()
  const intent = { schemaVersion: 1 as const, protocolVersion: 1 as const, mainId: fixture.connection.mainId,
    runId: 'run', nodeId: 'node', executionId: 'execution', occurrenceId: 'occurrence', occurrenceIndex: 0,
    technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', bindingHash: 'a'.repeat(64),
    inputDigest: `sha256:${'a'.repeat(64)}`, owner: { grantId: 'grant', epoch: '1' } }
  const receipt = await journal.accept(intent, fixture.deviceConnection, randomUUID())
  await journal.close()
  journal = await RemoteOperationJournal.open(path)
  expect(await journal.status(intent.operationId)).toEqual({ status: 'known', receipt })
})

it('reads a retired conversation after reopening the journal and rejects a replayed creation', async () => {
  const root = await mkdtemp(join(process.cwd(), '.conversation-retention-'))
  closing.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'operations.json')
  let now = Date.parse('2026-01-01T00:00:00Z')
  const options = { capacity: 1, now: () => now }
  let journal = await RemoteOperationJournal.open(path, { ...options, initializeNewInstallation: true })
  closing.push(() => journal.close())
  const fixture = workerConversationFixture()
  await journal.conversations.receive(fixture.binding, fixture.connection)
  await journal.conversations.reserveCreation(fixture.binding, 'create', commandInputHash('create'))
  await journal.conversations.closeConfirmed(fixture.binding)
  now += RUNTIME_JOURNAL_RETENTION_MS + 1
  await journal.pruneFinishedRuntime()
  const next = workerConversationFixture()
  expect((await journal.conversations.receive(next.binding, next.connection)).closed).toBe(false)
  await journal.close()
  journal = await RemoteOperationJournal.open(path, options)
  expect(await journal.conversations.read(fixture.binding)).toMatchObject({
    binding: fixture.binding,
    closed: true,
    creation: { operationId: 'create', inputHash: commandInputHash('create') },
  })
  await expect(journal.conversations.reserveCreation(fixture.binding, 'create', commandInputHash('create')))
    .rejects.toThrow('closed')
})

it('archives acknowledged closed conversations while retaining replay identities and unresolved owners across restart', async () => {
  const root = await mkdtemp(join(process.cwd(), '.conversation-retention-'))
  closing.push(() => rm(root, { recursive: true, force: true }))
  const path = join(root, 'operations.json')
  let now = Date.parse('2026-01-01T00:00:00Z')
  const options = { capacity: 2, byteLimit: 16 * 1024, now: () => now }
  let journal = await RemoteOperationJournal.open(path, { ...options, initializeNewInstallation: true })
  closing.push(() => journal.close())
  const uncertain = workerConversationFixture()
  await journal.conversations.receive(uncertain.binding, uncertain.connection)
  await journal.conversations.reserveTurn(uncertain.binding, 'uncertain-turn', commandInputHash('uncertain'))
  await journal.conversations.finishTurn(uncertain.binding, 'uncertain-turn')
  const completed = []
  for (let index = 0; index < 4; index++) {
    const fixture = workerConversationFixture('agent', 'claude')
    const chats = journal.conversations
    await chats.receive(fixture.binding, fixture.connection)
    await chats.reserveCreation(fixture.binding, 'create', commandInputHash('create'))
    await chats.bindSession(fixture.binding, fixture.session, fixture.nativeOwner)
    await chats.reserveTurn(fixture.binding, 'turn', commandInputHash('turn'))
    await chats.finishTurn(fixture.binding, 'turn', { outcome: 'succeeded', output: 'x'.repeat(7_000) })
    const identity = { ownerPrincipalId: 'sender', attemptId: 'request', nativeSessionId: fixture.session.nativeSessionId,
      nativeMessageId: 'message', clientCorrelationId: 'turn', generation: 'generation', toolUseId: 'tool',
      nativeRequestId: 'permission', nativeRequestType: 'can_use_tool' as const }
    const callback = { identity, toolName: 'Read', inputHash: commandInputHash('read'),
      state: 'submitted' as const, selectedOptionId: 'allow_once', acknowledged: true }
    await chats.claudeCallbackJournal(fixture.binding).write(commandInputHash(identity), callback)
    await chats.closeRequested(fixture.binding)
    await chats.closeConfirmed(fixture.binding)
    now += RUNTIME_JOURNAL_RETENTION_MS + 1
    await journal.pruneFinishedRuntime()
    completed.push({ fixture, callback })
  }
  await journal.close()
  journal = await RemoteOperationJournal.open(path, options)
  expect((await journal.conversations.read(uncertain.binding))?.turns[0]?.status).toBe('uncertain')
  for (const { fixture, callback } of completed) {
    expect((await journal.conversations.read(fixture.binding))?.closed).toBe(true)
    expect((await journal.conversations.receive(fixture.binding, fixture.connection)).closed).toBe(true)
    await expect(journal.conversations.reserveCreation(fixture.binding, 'create', commandInputHash('create')))
      .rejects.toThrow()
    await expect(journal.conversations.reserveTurn(fixture.binding, 'turn', commandInputHash('turn'))).rejects.toThrow()
    const callbacks = journal.conversations.claudeCallbackJournal(fixture.binding)
    expect(await callbacks.read(commandInputHash(callback.identity))).toEqual(callback)
    await expect(callbacks.write(commandInputHash(callback.identity), { ...callback, inputHash: commandInputHash('changed') }))
      .rejects.toThrow()
  }
  const fixture = workerConversationFixture()
  const intent = { schemaVersion: 1 as const, protocolVersion: 1 as const, mainId: fixture.connection.mainId,
    runId: 'run', nodeId: 'node', executionId: 'execution', occurrenceId: 'occurrence', occurrenceIndex: 0,
    technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', bindingHash: 'a'.repeat(64),
    inputDigest: `sha256:${'a'.repeat(64)}`, owner: { grantId: 'grant', epoch: '1' } }
  await journal.accept(intent, fixture.deviceConnection, randomUUID())
  expect((await journal.status('operation')).status).toBe('known')
  await expect(journal.conversations.receive(fixture.binding, fixture.connection)).rejects.toThrow('full')
})

it('keeps closed conversations charged until callback acknowledgement and retention are complete', async () => {
  const root = await mkdtemp(join(process.cwd(), '.conversation-retention-'))
  closing.push(() => rm(root, { recursive: true, force: true }))
  let now = Date.parse('2026-01-01T00:00:00Z')
  const journal = await RemoteOperationJournal.open(join(root, 'operations.json'), {
    initializeNewInstallation: true, capacity: 1, now: () => now,
  })
  closing.push(() => journal.close())
  const fixture = workerConversationFixture('agent', 'claude')
  const chats = journal.conversations
  await chats.receive(fixture.binding, fixture.connection)
  await chats.reserveCreation(fixture.binding, 'create', commandInputHash('create'))
  await chats.bindSession(fixture.binding, fixture.session, fixture.nativeOwner)
  const identity = { ownerPrincipalId: 'sender', attemptId: 'request', nativeSessionId: fixture.session.nativeSessionId,
    nativeMessageId: 'message', clientCorrelationId: 'turn', generation: 'generation', toolUseId: 'tool',
    nativeRequestId: 'permission', nativeRequestType: 'can_use_tool' as const }
  const callback = { identity, toolName: 'Read', inputHash: commandInputHash('read'),
    state: 'submitted' as const, selectedOptionId: 'allow_once', acknowledged: false }
  const callbacks = chats.claudeCallbackJournal(fixture.binding)
  await callbacks.write(commandInputHash(identity), callback)
  await chats.closeConfirmed(fixture.binding)
  const next = { ...fixture.binding, owner: { ...fixture.binding.owner, conversationId: randomUUID() } }
  await expect(chats.receive(next, fixture.connection)).rejects.toThrow('full')
  now += RUNTIME_JOURNAL_RETENTION_MS + 1
  await journal.pruneFinishedRuntime()
  await expect(chats.receive(next, fixture.connection)).rejects.toThrow('full')
  await callbacks.write(commandInputHash(identity), { ...callback, acknowledged: true })
  await journal.pruneFinishedRuntime()
  expect((await chats.receive(next, fixture.connection)).closed).toBe(false)
})
