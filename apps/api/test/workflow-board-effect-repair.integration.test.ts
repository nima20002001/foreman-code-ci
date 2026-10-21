import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COORDINATION_RESULT_PROTOCOL, type BoardApplicationReceipt, type ExecutionResult,
  type NativeHarnessEvent } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { NativeHistory } from '../src/modules/harnesses/port.js'
import type { MemoryBoardPort } from '../src/modules/collaboration/ports.js'
import { DomainError } from '../src/modules/errors.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

afterEach(() => vi.restoreAllMocks())

function resultFor(expectedRevision: number): ExecutionResult {
  return { outcome: 'succeeded', output: { summary: 'Deliverable complete',
    board: { kind: 'changes', operations: [{ kind: 'note_create', boardId: 'board-one',
      commandId: 'the-same-note', expectedRevision, text: 'Completed task facts' }] },
    routing: { kind: 'finish' }, data: { latestDeliverable: 'Completed deliverable', remainingFindings: [] },
  } }
}

function applicationReceipt(sourceEventKey: string, replayed = false): BoardApplicationReceipt {
  return { sourceEventKey, applicationId: `application:${sourceEventKey}`, replayed,
    commandIds: [], changedCardIds: [], boardRevisions: [] }
}

/** The SQL engine, native proof channel, correction budget and coordinator are
 * real. A transactional F1 port and synthetic external-provider transport are
 * the only feature boundaries replaced here; Worker physical closure has its
 * own execution-host tests. No private coordinator methods are invoked. */
async function boardRepairFixture(options: { alwaysConflict?: boolean; settlementReplyGap?: boolean;
  nativeResult?: ExecutionResult } = {}) {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  fixture.run.resultProtocol = COORDINATION_RESULT_PROTOCOL
  fixture.version.definition.handoffs = { contractVersion: 1 }
  fixture.version.definition.nodes[0]!.graphqlTools = { add: ['memory_board_get', 'memory_note_create'], remove: [] }
  const trace: string[] = []
  const attempts: number[] = []
  const memoryBoards: MemoryBoardPort = {
    readDigest: vi.fn(async () => {
      const text = 'board-one: revision 7; the note has not been applied.'
      return { text, byteLength: new TextEncoder().encode(text).byteLength, cardIds: [], omittedCount: 0 }
    }),
    async applyLifecycleLocked(_sql, fact) { return applicationReceipt(fact.sourceEventKey) },
    async applyResultLocked(sql, input) {
      if (input.result.kind !== 'changes') throw new Error('Expected the complete structured board batch')
      const revision = input.result.operations[0]!.expectedRevision!
      attempts.push(revision)
      trace.push(`board:${revision}`)
      // The deliberately partial write must disappear if this same transaction
      // rejects the supplied revision. This is the fake F1 store, not engine SQL.
      const inserted = await sql.query(`insert into result_effect_test_applications(source_key,revision)
        values($1,$2) on conflict(source_key) do nothing`, [input.sourceEventKey, revision])
      if (options.alwaysConflict || revision !== 7) throw new DomainError(
        'REVISION_CONFLICT', 'The board changed before its structured batch could commit.', 409)
      return applicationReceipt(input.sourceEventKey, inserted.rowCount === 0)
    },
  }
  const f = await checkpointRuntimeFixture(1, 1, { fixture, approvalNodeIds: [],
    outputFor: () => (options.nativeResult ?? resultFor(options.settlementReplyGap ? 7 : 6)).output,
    collaborationPorts: { memoryBoards } })
  await f.db.pool.query(`create table result_effect_test_applications(source_key text primary key,revision integer not null)`)
  const turns: { correlationId: string; sessionId: string; prompt: string }[] = []
  const histories = new Map<string, NativeHistory>()
  const currentHistories = new Map<string, NativeHistory>()
  const initialTurn = f.provider.startTurn.bind(f.provider)
  vi.spyOn(f.provider, 'startTurn').mockImplementation(async function* (session, input) {
    const correlationId = input.clientCorrelationId!
    if (!correlationId.includes(':result-repair:')) { yield* initialTurn(session, input); return }
    const attempt = turns.length + 1, providerId = `corrective-turn-${attempt}`
    turns.push({ correlationId, sessionId: session.nativeSessionId, prompt: input.prompt })
    trace.push(`repair:${attempt}`)
    expect(input.deferSettlement).toBe(true)
    await input.onSubmitted?.(providerId)
    const event = (sequence: number, type: 'turn.started' | 'turn.completed'): NativeHarnessEvent => ({
      sequence, type, occurredAt: new Date().toISOString(), payload: {
        threadId: session.nativeSessionId, turnId: providerId, clientCorrelationId: correlationId,
        turn: { id: providerId, status: type === 'turn.completed' ? 'completed' : 'inProgress' },
      },
    })
    const started = event(attempt * 2, 'turn.started'), terminal = event(attempt * 2 + 1, 'turn.completed')
    currentHistories.set(session.nativeSessionId, { correlationId, nativeTurnId: providerId,
      events: [started], pendingInteractions: [] })
    yield started
    const result = options.nativeResult ?? resultFor(7)
    const history: NativeHistory = { correlationId, nativeTurnId: providerId, events: [started, terminal],
      pendingInteractions: [], terminalResult: result, terminalTurn: { correlationId, providerId, result } }
    histories.set(correlationId, history)
    currentHistories.set(session.nativeSessionId, history)
    yield terminal
  })
  const initialReconcile = f.provider.reconcile.bind(f.provider), initialHistory = f.provider.history.bind(f.provider)
  vi.spyOn(f.provider, 'reconcile').mockImplementation(async (session, correlationId) =>
    histories.get(correlationId) ?? initialReconcile(session, correlationId))
  vi.spyOn(f.provider, 'history').mockImplementation(async session =>
    currentHistories.get(session.nativeSessionId) ?? initialHistory(session))
  const settled: { correlationId: string; result: ExecutionResult; committedApplications: number }[] = []
  const connection = f.provider.connection.bind(f.provider)
  vi.spyOn(f.provider, 'connection').mockImplementation(() => {
    const transport = connection()
    return { ...transport, async settleTurn(session, correlationId, signal) {
      const history = await transport.reconcile(session, correlationId, signal)
      const execution = (await f.runs.listRepeatExecutions(f.f.run.id))[0]!.execution
      // A correction must retain its original native turn until SQL accepts
      // either the actual success or the proof-qualified exhausted failure.
      expect(execution.state).toBe('completed')
      const applications = (await f.db.pool.query('select source_key from result_effect_test_applications')).rowCount!
      settled.push({ correlationId, result: structuredClone(history.terminalTurn!.result), committedApplications: applications })
      trace.push(`settle:${execution.result!.outcome}`)
      if (options.settlementReplyGap && settled.length === 1) throw new DomainError(
        'REPEAT_CLEANUP_PENDING', 'The original settlement reply was lost.', 409)
      return history
    } }
  })
  return { ...f, turns, trace, attempts, settled, memoryBoards }
}

describe.skipIf(!postgresEnabled)('atomic board result correction through the public engine', () => {
  it('fails an oversized envelope after two corrections while retaining its exact original native source', async () => {
    const nativeResult: ExecutionResult = { outcome: 'succeeded', output: { text: 'x'.repeat(64 * 1024 + 1) } }
    const f = await boardRepairFixture({ nativeResult })
    try {
      await expect(f.engine.start(f.f.run.id)).rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
      const executions = (await f.runs.listRepeatExecutions(f.f.run.id)).map(item => item.execution)
      expect(executions).toHaveLength(1)
      expect(executions[0]!.result).toMatchObject({ outcome: 'failed', error: { code: 'WORK_RESULT_INVALID', retryable: false } })
      expect(f.turns).toHaveLength(2)
      expect(f.attempts).toEqual([])
      expect(f.settled).toEqual([{ correlationId: f.turns[1]!.correlationId,
        result: nativeResult, committedApplications: 0 }])
      const proof = (await f.db.pool.query(`select p.record from workflow_coordination_terminals t
        join workflow_native_proofs p on p.proof_id=t.settled_native_proof_id where t.execution_id=$1`,
      [executions[0]!.id])).rows[0]!.record
      expect(proof.original.history.terminalTurn.result).toEqual(nativeResult)
      expect(f.provider.counts).toMatchObject({ sessions: 1, starts: 1, attaches: 0 })
    } finally { await f.close() }
  }, 120000)

  it('corrects one rejected revision in the original session before settling or accepting the result', async () => {
    const f = await boardRepairFixture()
    try {
      await f.engine.start(f.f.run.id)
      console.log('DIAG', JSON.stringify({ trace: f.trace, turns: f.turns.length, results: (await f.runs.listRepeatExecutions(f.f.run.id)).map(item => item.execution.result) }))
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      const executions = (await f.runs.listRepeatExecutions(f.f.run.id)).map(item => item.execution)
      expect(executions).toHaveLength(1)
      expect(executions[0]!.result).toEqual(resultFor(7))
      expect(f.provider.counts).toMatchObject({ sessions: 1, starts: 1, attaches: 0 })
      expect(f.turns).toHaveLength(1)
      expect(f.turns[0]!.sessionId).toBe(executions[0]!.nativeSessionId)
      expect(f.turns[0]!.prompt).toContain('board-one: revision 7')
      expect(f.trace).toEqual(['board:6', 'repair:1', 'board:7', 'settle:succeeded'])
      expect(f.settled).toEqual([{ correlationId: f.turns[0]!.correlationId,
        result: resultFor(7), committedApplications: 1 }])
      expect((await f.db.pool.query('select revision from result_effect_test_applications')).rows).toEqual([{ revision: 7 }])
    } finally { await f.close() }
  }, 120000)

  it('spends at most two corrective turns and retains original success evidence for an exhausted failed result', async () => {
    const f = await boardRepairFixture({ alwaysConflict: true })
    try {
      await expect(f.engine.start(f.f.run.id)).rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
      const executions = (await f.runs.listRepeatExecutions(f.f.run.id)).map(item => item.execution)
      expect(executions).toHaveLength(1)
      expect(executions[0]!.result).toMatchObject({ outcome: 'failed', error: {
        code: 'WORKFLOW_BOARD_EFFECT_CONFLICT', retryable: false,
      } })
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('failed')
      expect(f.turns).toHaveLength(2)
      expect(new Set(f.turns.map(turn => turn.sessionId))).toEqual(new Set([executions[0]!.nativeSessionId]))
      expect(f.attempts).toEqual([6, 7, 7])
      expect(f.settled).toEqual([{ correlationId: f.turns[1]!.correlationId,
        result: resultFor(7), committedApplications: 0 }])
      expect(f.provider.counts).toMatchObject({ sessions: 1, starts: 1, attaches: 0 })
      expect((await f.db.pool.query('select source_key from result_effect_test_applications')).rows).toEqual([])
    } finally { await f.close() }
  }, 120000)

  it('reconciles a committed terminal settlement reply gap without replaying F1 or starting new work', async () => {
    const f = await boardRepairFixture({ settlementReplyGap: true })
    try {
      await f.engine.start(f.f.run.id)
      expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
      expect(f.attempts).toEqual([7])
      expect(f.turns).toEqual([])
      expect(f.settled).toHaveLength(2)
      expect(f.settled[0]).toEqual(f.settled[1])
      expect(f.settled[0]).toMatchObject({ result: resultFor(7), committedApplications: 1 })
      expect(f.provider.counts).toMatchObject({ sessions: 1, starts: 1, attaches: 0 })
      expect(await f.runs.listRepeatExecutions(f.f.run.id)).toHaveLength(1)
      await f.engine.start(f.f.run.id)
      expect(f.attempts).toEqual([7])
      expect(f.settled).toHaveLength(2)
      expect(f.provider.counts.sessions).toBe(1)
    } finally { await f.close() }
  }, 120000)
})
