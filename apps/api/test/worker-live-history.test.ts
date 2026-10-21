import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeHistory } from '../src/modules/harnesses/port.js'
import { WorkerConversationHost } from '../src/modules/conversations/workerHost.js'
import { WorkerConversationJournal } from '../src/modules/conversations/workerJournal.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { collect, until } from './fixtures/codex-test-helpers.js'
import { manager, source, wire, useCodexFixture } from './codex-app-server.test-support.js'

useCodexFixture()

it.each([false, true])('reads live Worker history without reconciliation after reattachment: %s', async reattach => {
  const f = workerConversationFixture('agent')
  let connection = f.connection
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  const host = new WorkerConversationHost({ journal, currentBinding: () => connection,
    authorize: async () => {}, observeSession: async () => {}, observeSubmission: async () => {},
    allocate: async () => ({ manager, start: async () => source,
      nativeOwner: async session => ({ ...f.nativeOwner, sessionId: session.nativeSessionId }),
      close: async () => manager.dispose() }) })
  try {
    const opened = await host.handle({ method: 'conversation.open', binding: f.binding,
      configuration: f.configuration, mode: 'create', operationId: 'create' }, f.connection) as { receipt: WorkerConversationReceipt }
    const session = opened.receipt.session!
    await host.handle({ method: 'conversation.start-turn', binding: f.binding, session,
      correlationId: 'live-turn', prompt: 'wait' }, f.connection)
    await until(async () => (await journal.read(f.binding))?.turns[0]?.status === 'submitted')
    if (reattach) {
      connection = { ...connection, connectionGeneration: connection.connectionGeneration + 1, connectionEpoch: randomUUID() }
      await host.handle({ method: 'conversation.open', binding: f.binding, configuration: f.configuration,
        mode: 'attach', source: session, operationId: 'reattach' }, connection)
    }
    const before = await manager.history(session)
    const nativeReads = await wire('thread/read')
    for (let read = 0; read < 3; read++) {
      const response = await host.handle({ method: 'conversation.history', binding: f.binding, session,
        correlationId: 'live-turn', afterSequence: before.nextSequence! - 1 }, connection) as { history: NativeHistory }
      expect(response.history.events).toEqual([])
      expect(response.history.nextSequence).toBe(before.nextSequence)
    }
    expect(await wire('thread/read')).toEqual(nativeReads)
    await host.handle({ method: 'conversation.cancel', binding: f.binding, session }, connection)
    await host.drainForUpdate()
  } finally { await host.shutdown() }
})

it('keeps the output cursor unchanged when reconciling an already observed terminal result', async () => {
  const session = await manager.createSession(source)
  await collect(manager.startTurn(session, { prompt: 'complete', clientCorrelationId: 'finished-turn' }))
  const before = await manager.history(session)
  const reconciled = await manager.reconcile(session, 'finished-turn')
  expect(reconciled.terminalTurn?.result).toEqual(before.terminalResult)
  expect(reconciled.events).toEqual(before.events)
  expect(reconciled.nextSequence).toBe(before.nextSequence)
})
