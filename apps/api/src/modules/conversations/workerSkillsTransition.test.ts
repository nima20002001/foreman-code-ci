import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentConfigurationVersionSchema, type CompactionState } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationReceipt, WorkerConversationConfiguration, WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import type { NativeCompactInput, NativeHarnessSessionManager, NativeHistory, NativeSessionStart, NativeTurnInput } from '../harnesses/port.js'
import { WorkerConversationHost } from './workerHost.js'
import { WorkerConversationJournal } from './workerJournal.js'
import { workerConversationFixture } from './workerFixtures.test-support.js'

async function fixture() {
  const f = workerConversationFixture('agent')
  const base = AgentConfigurationVersionSchema.parse(f.configuration)
  const instructions = 'Use the node skill.'
  const configuration = { ...base, assignedSkills: [{ skillId: 'node-skill', version: '1' }],
    resolvedSkills: [{ skillId: 'node-skill', version: '1', instructions,
      contentHash: `sha256:${createHash('sha256').update(instructions).digest('hex')}` }] }
  const binding = { ...f.binding, owner: { ...f.binding.owner, configurationHash: commandInputHash(configuration) } }
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => structuredClone(apply(records)) }, 8)
  await journal.receive(f.binding, f.connection)
  await journal.reserveCreation(f.binding, 'original-create', commandInputHash('original-create'))
  await journal.bindSession(f.binding, f.session, f.nativeOwner)
  const close = vi.fn(async () => {})
  const start = { kind: 'agent-chat', configuration: base, conversationId: f.binding.owner.conversationId,
    workflowId: 'workflow', workflowNodeId: 'node', workingDirectory: f.binding.workingDirectory } as NativeSessionStart
  let finish!: () => void
  const held = new Promise<void>(resolve => { finish = resolve })
  let entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const reconcile = vi.fn(async (): Promise<NativeHistory> => ({ events: [], pendingInteractions: [], correlationId: 'active-input',
    nativeTurnId: 'active-turn', terminalResult: { outcome: 'succeeded' as const } }))
  const reconcileCompaction = vi.fn(async (_session: unknown, state: CompactionState) => ({ ...state, status: 'completed' as const }))
  const native = { harness: 'codex',
    reconcileCompaction,
    async *startTurn(_session: unknown, input: NativeTurnInput) {
      await input.onSubmitted?.('active-turn')
      entered()
      await held
      yield { type: 'turn.completed', sequence: 1, occurredAt: '2026-10-01T00:00:00Z', payload: {} }
    },
    reconcile,
    async compactSession(_session: unknown, input: NativeCompactInput) {
      await input.onDispatch?.()
      entered()
      await held
      return { requestId: input.requestId, nativeSessionId: f.session.nativeSessionId,
        nativeOperationId: 'native-compact', status: 'completed' as const, beforeTokens: null,
        observedAt: '2026-10-01T00:00:00Z', message: 'Compacted' }
    },
  } as unknown as NativeHarnessSessionManager
  const allocation = { manager: native, close, start: async () => start, nativeOwner: async () => f.nativeOwner }
  const recover = vi.fn(async (record: WorkerConversationReceipt, target: WorkerConversationConfiguration,
    _connection: unknown, _signal: unknown, request: WorkerConversationRpcRequest) => {
    if (request.method === 'conversation.open' && request.previousConfiguration) {
      await journal.recoveredOwner(record.binding, f.connection, f.nativeOwner, f.nativeOwner,
        { targetBinding: request.binding, previousConfiguration: request.previousConfiguration, configuration: target })
    }
    return allocation
  })
  const host = new WorkerConversationHost({ journal, currentBinding: () => f.connection,
    authorize: async () => {}, observeSession: async () => {}, observeSubmission: async () => {},
    allocate: async () => allocation, recover })
  await host.handle({ method: 'conversation.open', binding: f.binding, configuration: base,
    operationId: 'attach', mode: 'attach', source: f.session }, f.connection)
  recover.mockClear()
  const transition = () => host.handle({ method: 'conversation.open', binding, configuration,
    previousBinding: f.binding, previousConfiguration: base, operationId: 'skills',
    mode: 'attach', source: f.session }, f.connection)
  return { ...f, journal, host, close, recover, reconcile, reconcileCompaction, transition, started, finish,
    cleanup: async () => { finish(); await host.shutdown() } }
}

it('keeps the native owner open while a Run chat turn is still pumping after its journal result', async () => {
  const f = await fixture()
  try {
    await f.host.handle({ method: 'conversation.start-turn', binding: f.binding, session: f.session,
      prompt: 'Continue', correlationId: 'active-input' }, f.connection)
    await f.started
    // The native stream can still be draining after another observer saves its terminal result.
    await f.journal.finishTurn(f.binding, 'active-input', { outcome: 'succeeded' })
    await expect(f.transition()).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_UNAVAILABLE' })
    expect(f.close).not.toHaveBeenCalled()
    expect(f.recover).not.toHaveBeenCalled()
    expect((await f.journal.read(f.binding))?.session).toEqual(f.session)
  } finally { await f.cleanup() }
})

it.each(['reserved', 'submitted', 'uncertain', 'compacting'] as const)(
  'keeps the original Run chat owner while the journal has %s work after restart', async state => {
    const f = await fixture()
    try {
      if (state === 'compacting') {
        await f.journal.reserveCompact(f.binding, 'compact', commandInputHash('compact'))
      } else {
        await f.journal.reserveTurn(f.binding, 'unfinished', commandInputHash('unfinished'))
        if (state === 'submitted') await f.journal.submitted(f.binding, 'unfinished', { nativeTurnId: 'original-turn' })
        if (state === 'uncertain') await f.journal.finishTurn(f.binding, 'unfinished')
      }
      const before = await f.journal.read(f.binding)
      await expect(f.transition()).rejects.toThrow()
      expect(f.close).not.toHaveBeenCalled()
      expect(f.recover).not.toHaveBeenCalled()
      expect(await f.journal.read(f.binding)).toEqual(before)
    } finally { await f.cleanup() }
  })

it.each(['succeeded', 'failed'] as const)(
  'settles an inactive resident turn with its native %s result before migrating skills', async outcome => {
    const f = await fixture()
    const result = outcome === 'succeeded' ? { outcome } : {
      outcome, error: { code: 'NATIVE_FAILURE', message: 'Native failure', retryable: false },
    }
    f.reconcile.mockResolvedValue({ events: [], pendingInteractions: [], correlationId: 'active-input',
      nativeTurnId: 'active-turn', terminalResult: result })
    try {
      await f.journal.reserveTurn(f.binding, 'active-input', commandInputHash('input'))
      await f.journal.submitted(f.binding, 'active-input', { nativeTurnId: 'active-turn' })
      await f.journal.finishTurn(f.binding, 'active-input')
      const response = await f.transition() as { receipt: WorkerConversationReceipt }
      expect(response.receipt.turns[0]).toMatchObject({ status: 'completed', nativeTurnId: 'active-turn', result })
      expect(response.receipt.binding.owner.configurationHash).not.toBe(f.binding.owner.configurationHash)
      expect(response.receipt.session).toEqual(f.session)
      expect(f.reconcile).toHaveBeenCalledWith(f.session, 'active-input', expect.any(AbortSignal))
      expect(f.close).toHaveBeenCalledOnce()
      expect(f.recover).toHaveBeenCalledOnce()
      expect(f.recover.mock.calls[0]?.[0].turns[0]).toMatchObject({ status: 'completed', result })
    } finally { await f.cleanup() }
  })

it.each(['foreign-turn', 'missing-result', 'pending-interaction'] as const)(
  'keeps an inactive resident on its old skills when native recovery has %s', async fault => {
    const f = await fixture()
    const history: NativeHistory = { events: [], pendingInteractions: [], correlationId: 'active-input',
      nativeTurnId: fault === 'foreign-turn' ? 'another-turn' : 'active-turn',
      ...(fault === 'missing-result' ? {} : { terminalResult: { outcome: 'succeeded' as const } }) }
    if (fault === 'pending-interaction') history.pendingInteractions = [{ id: 'pending' } as never]
    f.reconcile.mockResolvedValue(history)
    try {
      await f.journal.reserveTurn(f.binding, 'active-input', commandInputHash('input'))
      await f.journal.submitted(f.binding, 'active-input', { nativeTurnId: 'active-turn' })
      await f.journal.finishTurn(f.binding, 'active-input')
      const before = await f.journal.read(f.binding)
      await expect(f.transition()).rejects.toThrow()
      expect(await f.journal.read(f.binding)).toEqual(before)
      expect(f.close).not.toHaveBeenCalled()
      expect(f.recover).not.toHaveBeenCalled()
    } finally { await f.cleanup() }
  })

it('keeps the native owner open while compaction is still running after its journal result', async () => {
  const f = await fixture()
  try {
    await f.host.handle({ method: 'conversation.compact', binding: f.binding, session: f.session,
      requestId: 'compact', correlationId: 'compact-input' }, f.connection)
    await f.started
    const state = (await f.journal.read(f.binding))!.compactions[0]!.state
    await f.journal.compactProgress(f.binding, { ...state, status: 'completed' })
    await expect(f.transition()).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_UNAVAILABLE' })
    expect(f.close).not.toHaveBeenCalled()
    expect(f.recover).not.toHaveBeenCalled()
  } finally { await f.cleanup() }
})

it('settles an inactive resident compaction through its old binding before migrating skills', async () => {
  const f = await fixture()
  try {
    const reserved = await f.journal.reserveCompact(f.binding, 'compact', commandInputHash('compact'))
    const dispatched = { ...reserved.state, dispatchPhase: 'dispatched' as const,
      status: 'uncertain' as const, nativeOperationId: 'native-compact' }
    await f.journal.compactProgress(f.binding, dispatched)
    const response = await f.transition() as { receipt: WorkerConversationReceipt }
    expect(response.receipt.compactions[0]?.state).toMatchObject({ status: 'completed', nativeOperationId: 'native-compact' })
    expect(response.receipt.binding.owner.configurationHash).not.toBe(f.binding.owner.configurationHash)
    expect(f.reconcileCompaction).toHaveBeenCalledWith(f.session, dispatched, expect.any(AbortSignal))
    expect(f.recover.mock.calls[0]?.[0].compactions[0]?.state.status).toBe('completed')
    expect(f.close).toHaveBeenCalledOnce()
  } finally { await f.cleanup() }
})
