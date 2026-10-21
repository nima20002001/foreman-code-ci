import { createHash, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { NativeHarnessSessionManager, NativeHistory, NativeSessionStart } from '../harnesses/port.js'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import { MainWorkerConversationBridge, type WorkerConversationChannel } from './workerBridge.js'
import { WorkerConversationManager } from './workerManager.js'
import { WorkerConversationHost, type WorkerConversationAllocation } from './workerHost.js'
import { WorkerConversationJournal } from './workerJournal.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

function fixture() {
  const f = workerConversationFixture()
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  const bridge = new MainWorkerConversationBridge()
  let connection = f.connection
  let starts = 0
  let closes = 0
  let turns = 0
  let allowed = true
  const start = { kind: 'operator', configuration: f.configuration,
    workingDirectory: f.binding.workingDirectory, correlationId: 'creation' } as NativeSessionStart
  const allocation = (): WorkerConversationAllocation => {
    const processIdentityDigest = createHash('sha256').update(String(++starts)).digest('hex')
    let closed = false
    let history: NativeHistory = { events: [], pendingInteractions: [] }
    const manager: NativeHarnessSessionManager = {
      harness: 'codex', createSession: async () => f.session, attachSession: async () => f.session,
      capabilities: async () => { throw new Error('No capability inspection in this provider replay.') },
      inspectMcp: async () => { throw new Error('No MCP inspection in this provider replay.') },
      pending: async () => undefined, respond: async () => {}, cancel: async () => false,
      async *startTurn(_session, input) {
        const nativeTurnId = `turn-${++turns}`
        await input.onSubmitted?.(nativeTurnId)
        history = { correlationId: input.clientCorrelationId, nativeTurnId,
          terminalResult: { outcome: 'succeeded', output: input.prompt }, pendingInteractions: [],
          events: [{ sequence: turns, type: 'assistant.delta', occurredAt: new Date().toISOString(),
            payload: { text: input.prompt } }], nextSequence: turns + 1 }
        yield* history.events
      },
      history: async () => structuredClone(history), reconcile: async () => structuredClone(history),
      retireTurn: async (_session, correlation) => {
        if (history.correlationId !== correlation || !history.terminalResult) throw new Error('Turn is still active.')
      },
      close: async () => {},
    }
    return { manager, start: async () => start,
      nativeOwner: async () => ({ sessionId: f.session.nativeSessionId, processIdentityDigest }),
      close: async () => { if (!closed) { closed = true; closes++ } } }
  }
  const createHost = () => new WorkerConversationHost({ journal, currentBinding: () => connection,
    authorize: async () => { if (!allowed) throw new Error('Caller denied') },
    observeSession: async () => {}, observeSubmission: async () => {}, allocate: async () => allocation(),
    recover: async record => {
      const resumed = allocation()
      await resumed.manager.attachSession(f.session, start)
      await journal.recoveredOwner(f.binding, connection, record.nativeOwner!, await resumed.nativeOwner(f.session))
      return resumed
    } })
  let host = createHost()
  const channel = (): WorkerConversationChannel => ({ binding: connection,
    request: async (request, options) => ({ payload: await host.handle(request, connection, options?.signal) }) })
  const manager = new WorkerConversationManager({ binding: f.binding, configuration: f.configuration, bridge,
    channel: channel(), currentChannel: channel,
    current: async () => { if (!allowed) throw new Error('Caller denied') } })
  const turn = async (correlationId: string) => {
    const received = []
    for await (const event of manager.startTurn(f.session, { prompt: correlationId, clientCorrelationId: correlationId })) received.push(event)
    expect(received.map(event => event.payload.text)).toEqual([correlationId])
    await manager.retireTurn(f.session, correlationId)
  }
  return { manager, start, session: f.session, turn, journal, binding: f.binding,
    starts: () => starts, closes: () => closes, turns: () => turns,
    deny: () => { allowed = false }, allow: () => { allowed = true },
    restart: async () => {
      await host.shutdown()
      connection = { ...connection, bootId: randomUUID(), connectionEpoch: randomUUID(),
        connectionGeneration: connection.connectionGeneration + 1 }
      host = createHost()
    },
    close: async () => { await manager.dispose(); await host.shutdown(); await bridge.close() } }
}

it('still releases its acquired runtime after a failed read and restored access', async () => {
  const f = fixture()
  try {
    await f.manager.createSession(f.start)
    await f.turn('first')
    f.deny()
    await expect(f.manager.history(f.session)).rejects.toThrow('Caller denied')
    f.allow()
    await f.manager.dispose()
    expect(f.closes()).toBe(1)
    expect(await f.journal.read(f.binding)).toMatchObject({ runtimeReleased: true, closed: false })
  } finally { f.allow(); await f.close() }
})

it('closes an idle Worker process without closing its conversation and cold-resumes the saved identity', async () => {
  const f = fixture()
  try {
    await f.manager.createSession(f.start)
    await f.turn('first')
    await f.turn('second')
    expect(f.starts()).toBe(1)
    await f.manager.closeForResume(f.session)
    expect(f.closes()).toBe(1)
    expect(await f.journal.read(f.binding)).toMatchObject({ closed: false, session: f.session, runtimeReleased: true })
    await f.manager.attachSession(f.session, f.start)
    await f.turn('resumed')
    expect(f.starts()).toBe(2)
    expect(f.turns()).toBe(3)
    f.deny()
    await expect(f.manager.closeForResume(f.session)).rejects.toThrow('Caller denied')
    expect(f.closes()).toBe(1)
  } finally { f.allow(); await f.close() }
})

it('cold-resumes after a Worker restart while keeping completed turns and the same session identity', async () => {
  const f = fixture()
  try {
    await f.manager.createSession(f.start)
    await f.turn('first')
    await f.turn('second')
    expect(f.starts()).toBe(1)
    await f.restart()
    expect(f.closes()).toBe(1)
    await f.turn('after-restart')
    expect(f.starts()).toBe(2)
    expect(f.turns()).toBe(3)
    expect(await f.journal.read(f.binding)).toMatchObject({ closed: false, session: f.session,
      turns: [{ correlationId: 'first', status: 'completed' }, { correlationId: 'second', status: 'completed' },
        { correlationId: 'after-restart', status: 'completed' }] })
  } finally { await f.close() }
})
