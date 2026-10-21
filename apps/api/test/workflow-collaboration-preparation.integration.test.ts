import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { COORDINATION_RESULT_PROTOCOL, type AgentSubject, type BoardApplicationReceipt,
  type BrowserPrepareResult, type BoardResult } from '@foreman-code/contracts'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { DomainError } from '../src/modules/errors.js'
import { requestRepeatRunStop } from '../src/modules/runs/repeatLifecycle.js'
import { recordWorkflowExecutionFailure } from '../src/modules/runs/workflowLifecycle.js'
import { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import { createWorkflowNativeCaptureChannel } from '../src/modules/interactions/workflowNativeCapture.js'
import { createWorkflowRepositoryServices } from '../src/modules/runs/workflowRepositoryServices.js'
import { RepeatRepositoryFactory } from '../src/modules/runs/repeatRepositoryHost.js'
import { WorkspaceLocationService } from '../src/modules/workspaces/location.js'
import { createWorkflowCollaborationHooks } from '../src/modules/collaboration/workflowHooks.js'
import { requireAuthorization } from '../src/modules/access/policy.js'
import { isWorkflowResultEffectFailure } from '../src/modules/runs/workflowResultEffectFailure.js'
import { WorkflowCollaborationIntegration } from '../src/modules/collaboration/workflowIntegration.js'
import type { BrowserLifecyclePort, MemoryBoardPort } from '../src/modules/collaboration/ports.js'
import { currentDatabase, postgresEnabled } from './helpers/eng04CurrentDatabase.js'
import { workflowSettlementFixture } from './helpers/workflowSettlementFixture.js'

/** Real migrations/Run owners/Save/admission and injected C0 A/B ports. The
 * existing settlement fixture supplies synthetic native terminals; these tests
 * do not claim to exercise provider transport or native proof qualification. */
describe.skipIf(!postgresEnabled)('workflow collaboration preparation and atomic callbacks', () => {
  let db: Awaited<ReturnType<typeof currentDatabase>>
  beforeAll(async () => {
    db = await currentDatabase()
    await db.pool.query(`create table collaboration_test_events(source_key text primary key,payload jsonb not null)`)
  }, 120000)
  afterAll(async () => { await db?.close() }, 120000)

  async function fixture(options: { memory?: boolean; browser?: boolean; maxExecutions?: number } = { memory: true, browser: true }) {
    const f = await workflowSettlementFixture(db, (graph, writer) => {
      // A synthetic marked immutable Run exercises future supplied-port
      // composition. Public Start continues to leave the result marker off.
      writer.f.run.resultProtocol = COORDINATION_RESULT_PROTOCOL
      return { ...graph, handoffs: { contractVersion: 1 },
        ...(options.maxExecutions ? { executionPolicy: { ...graph.executionPolicy,
          maxParallelism: graph.executionPolicy?.maxParallelism ?? 1, maxNodeExecutions: options.maxExecutions } } : {}),
        nodes: graph.nodes.map(node => ({ ...node,
        ...(options.memory ? { graphqlTools: { add: ['memory_board_get' as const], remove: [] } } : {}),
        ...(options.browser ? { browser: { enabled: true, profileId: 'profile-one' } } : {}),
      })) }
    }, 'single')
    const activation = await f.store.ensureWorkEntry()
    const admitted = await f.store.admitWorkActivation(activation, nodeId => f.candidate(nodeId))
    return Object.assign(f, { execution: admitted.execution })
  }

  function board() {
    let rejectRevision = false
    const readDigest = vi.fn<MemoryBoardPort['readDigest']>(async () => {
      const text = 'Card one · Doing · revision 7'
      return { text, byteLength: new TextEncoder().encode(text).byteLength, cardIds: ['card-one'], omittedCount: 3 }
    })
    async function persist(sql: GraphTransactionSql, sourceEventKey: string, payload: unknown): Promise<BoardApplicationReceipt> {
      const inserted = await sql.query(`insert into collaboration_test_events(source_key,payload) values($1,$2::jsonb)
        on conflict(source_key) do nothing`, [sourceEventKey, JSON.stringify(payload)])
      return { applicationId: `application:${sourceEventKey}`, sourceEventKey, commandIds: [],
        changedCardIds: [], boardRevisions: [], replayed: inserted.rowCount === 0 }
    }
    const memoryBoards: MemoryBoardPort = {
      readDigest,
      applyLifecycleLocked: (sql, fact) => persist(sql, fact.sourceEventKey, fact),
      async applyResultLocked(sql, input) {
        const receipt = await persist(sql, input.sourceEventKey, input)
        if (rejectRevision) throw new DomainError('REVISION_CONFLICT', 'The supplied board revision changed.', 409)
        return receipt
      },
    }
    return { memoryBoards, readDigest, rejectRevision() { rejectRevision = true } }
  }

  function browser() {
    let pending = true
    const prepare = vi.fn<BrowserLifecyclePort['prepare']>(async input => ({ kind: 'ready',
      session: { id: 'owned-browser', subject: input.subject, profileId: input.browser.profileId!,
        computerId: input.computerId, browserGeneration: 1, state: 'ready', selectedTabId: null },
      control: { sessionId: 'owned-browser', state: 'agent', epoch: 1, controllingViewerId: null, reason: null },
    }))
    const release = vi.fn<BrowserLifecyclePort['release']>(async input => ({
      sessionId: input.sessionId, state: pending ? 'pending' : 'closed', reason: pending ? 'Computer offline' : null,
    }))
    return { port: { prepare, release }, prepare, release, confirmClosure() { pending = false } }
  }

  it('retains one bounded digest and exact prepared browser across owner restart without changing task input', async () => {
    const f = await fixture(), a = board(), b = browser()
    const integration = new WorkflowCollaborationIntegration({ memoryBoards: a.memoryBoards, browser: b.port }, async () => 'accepted-computer')
    try {
      const originalInput = structuredClone(f.execution.input)
      await integration.prepare(f.owner, f.run, f.version, f.execution)
      await integration.prepare(f.owner, f.run, f.version, f.execution)
      expect(a.readDigest).toHaveBeenCalledTimes(1)
      expect(b.prepare).toHaveBeenCalledTimes(1)
      const subject = a.readDigest.mock.calls[0]![0].subject
      expect(subject.kind).toBe('execution')
      expect(b.prepare.mock.calls[0]![0].subject).toEqual(subject)
      expect(a.readDigest.mock.calls[0]![0].work).toEqual({ kind: 'activation', runId: f.run.id,
        workflowVersionId: f.version.id, activationId: subject.kind === 'execution' ? subject.execution.activationId : undefined })
      const prompt = await integration.readPrompt(f.owner, f.execution, f.version)
      expect(prompt).toContain('revision 7')
      expect(prompt).toContain('owned-browser')
      expect(prompt).toContain('browser_session_get')
      await f.restart()
      const recovered = (await f.store.readExecution(f.execution.id)).execution
      await integration.prepare(f.owner, f.run, f.version, recovered)
      expect(await integration.readPrompt(f.owner, recovered, f.version)).toBe(prompt)
      expect(recovered.input).toEqual(originalInput)
      expect(a.readDigest).toHaveBeenCalledTimes(1)
      expect(b.prepare).toHaveBeenCalledTimes(1)
    } finally { await f.close() }
  }, 120000)

  it('reuses the same logical-work digest for an admitted technical retry', async () => {
    const f = await fixture({ memory: true, maxExecutions: 2 }), a = board()
    const integration = new WorkflowCollaborationIntegration({ memoryBoards: a.memoryBoards }, async () => 'computer')
    try {
      await integration.prepare(f.owner, f.run, f.version, f.execution)
      const prompt = await integration.readPrompt(f.owner, f.execution, f.version)
      const budgets = new PostgresApprovalBudgetRepository(db.pool)
      await budgets.ensure(f.execution.id, f.run.id, 60_000)
      const services = createWorkflowRepositoryServices(createWorkflowNativeCaptureChannel().verify).services
      const store = new RepeatRepositoryFactory(new WorkspaceLocationService(db.pool, f.commands, db.directory, 'runner-local'),
        db.directory, { ...services, collaboration: createWorkflowCollaborationHooks() }).forOwner(f.owner, f.version)
      await recordWorkflowExecutionFailure(f.owner, f.execution.id, { outcome: 'failed', error: {
        code: 'NATIVE_TRANSPORT_UNAVAILABLE', message: 'A retryable native transport failure.', retryable: true,
      } })
      await budgets.stop(f.execution.id)
      await store.settleNegativeExecution(f.execution.id, false)
      const retried = await store.acceptWorkTerminal(f.execution.id,
        attempt => f.candidate(f.execution.workflowNodeId, attempt))
      expect(retried.kind).toBe('retry')
      if (retried.kind !== 'retry') throw new Error('Expected the admitted retry of the same work')
      await integration.prepare(f.owner, f.run, f.version, retried.execution)
      expect(await integration.readPrompt(f.owner, retried.execution, f.version)).toBe(prompt)
      expect(retried.execution.input).toEqual(f.execution.input)
      expect(a.readDigest).toHaveBeenCalledTimes(1)
    } finally { await f.close() }
  }, 120000)

  it('does not read F1 or allocate B for an Agent without either enabled feature', async () => {
    const f = await fixture({}), a = board(), b = browser()
    const integration = new WorkflowCollaborationIntegration({ memoryBoards: a.memoryBoards, browser: b.port }, async () => {
      throw new Error('A disabled browser must not discover a computer')
    })
    try {
      await integration.prepare(f.owner, f.run, f.version, f.execution)
      expect(a.readDigest).not.toHaveBeenCalled()
      expect(b.prepare).not.toHaveBeenCalled()
      expect(await integration.readPrompt(f.owner, f.execution, f.version)).toBeUndefined()
    } finally { await f.close() }
  }, 120000)

  it('retains pending cleanup until B confirms this exact session and never releases a sibling', async () => {
    const f = await fixture(), b = browser()
    const integration = new WorkflowCollaborationIntegration({ browser: b.port }, async () => 'accepted-computer')
    try {
      await integration.prepare(f.owner, f.run, f.version, f.execution)
      await expect(integration.release(f.owner, f.execution, 'stop', f.version)).rejects.toMatchObject({ code: 'BROWSER_RELEASE_NOT_ADMITTED' })
      await requestRepeatRunStop(db.pool, f.run.id, async () => {
        requireAuthorization(f.writer.principal, 'runs:stop', { workspaceId: f.run.workspaceId,
          workflowId: f.run.workflowId, runId: f.run.id })
      })
      await expect(integration.release(f.owner, f.execution, 'stop', f.version)).rejects.toMatchObject({ code: 'REPEAT_CLEANUP_PENDING' })
      const pending = (await db.pool.query('select browser_state,browser_session_id from workflow_collaboration_preparations where execution_id=$1',
        [f.execution.id])).rows[0]
      expect(pending).toEqual({ browser_state: 'releasing', browser_session_id: 'owned-browser' })
      b.confirmClosure()
      await integration.release(f.owner, f.execution, 'stop', f.version)
      await integration.release(f.owner, f.execution, 'stop', f.version)
      expect(b.release.mock.calls.map(([input]) => input.sessionId)).toEqual(['owned-browser', 'owned-browser'])
      expect(b.release.mock.calls[0]![0]).toEqual(b.release.mock.calls[1]![0])
    } finally { await f.close() }
  }, 120000)

  it('keeps a prepare/Stop race owned for cleanup and never admits its late ready result', async () => {
    const f = await fixture(), b = browser()
    let ready!: (value: BrowserPrepareResult) => void
    let dispatched!: () => void
    let subject!: AgentSubject
    const pending = new Promise<BrowserPrepareResult>(resolve => { ready = resolve })
    const offered = new Promise<void>(resolve => { dispatched = resolve })
    b.prepare.mockImplementation(async input => { subject = input.subject; dispatched(); return pending })
    const integration = new WorkflowCollaborationIntegration({ browser: b.port }, async () => 'accepted-computer')
    try {
      const preparation = integration.prepare(f.owner, f.run, f.version, f.execution)
      const rejected = expect(preparation).rejects.toMatchObject({ code: 'GRAPH_STOP_CONFLICT' })
      await offered
      await requestRepeatRunStop(db.pool, f.run.id, async () => {
        requireAuthorization(f.writer.principal, 'runs:stop', { workspaceId: f.run.workspaceId,
          workflowId: f.run.workflowId, runId: f.run.id })
      })
      ready({ kind: 'ready', session: { id: 'owned-browser', subject, profileId: 'profile-one', computerId: 'accepted-computer',
        browserGeneration: 1, state: 'ready', selectedTabId: null }, control: { sessionId: 'owned-browser', state: 'agent',
        epoch: 1, controllingViewerId: null, reason: null } })
      await rejected
      b.confirmClosure()
      await integration.release(f.owner, f.execution, 'stop', f.version)
      expect(b.release).toHaveBeenCalledOnce()
      expect((await f.store.readExecution(f.execution.id)).execution.state).toBe('queued')
    } finally { await f.close() }
  }, 120000)

  it('commits lifecycle effects and the source-keyed projection once, and rolls both back together', async () => {
    const f = await fixture({ memory: true }), a = board()
    const integration = new WorkflowCollaborationIntegration({ memoryBoards: a.memoryBoards }, async () => 'computer')
    try {
      const input = { run: await f.readRun(), version: f.version, execution: f.execution,
        sourceEventKey: `${f.execution.id}:admitted`, phase: 'admitted' as const }
      for (let attempt = 0; attempt < 2; attempt++) await f.owner.oneShotConnection().transaction(sql => integration.hooks.lifecycleLocked(sql, input))
      const rows = (await db.pool.query(`select payload from run_activity where run_id=$1
        and kind='collaboration_lifecycle' and payload->>'sourceEventKey'=$2`,
      [f.run.id, input.sourceEventKey])).rows
      expect(rows).toHaveLength(1)
      expect(rows[0]!.payload.fact.execution.executionId).toBe(f.execution.id)
      expect(rows[0]!.payload.fact.work.kind).toBe('activation')
      const refusedKey = `${f.execution.id}:uncommitted`
      await expect(f.owner.oneShotConnection().transaction(async sql => {
        await integration.hooks.lifecycleLocked(sql, { ...input, sourceEventKey: refusedKey })
        throw new Error('Caller mutation rejected before commit')
      })).rejects.toThrow('Caller mutation rejected')
      expect((await db.pool.query('select source_key from collaboration_test_events where source_key=$1', [refusedKey])).rows).toEqual([])
      expect((await db.pool.query('select payload from run_activity where run_id=$1 and payload->>\'sourceEventKey\'=$2',
        [f.run.id, refusedKey])).rows).toEqual([])
    } finally { await f.close() }
  }, 120000)

  it('rolls back all rejected revision effects and exposes only an exact bounded correction capability', async () => {
    const f = await fixture({ memory: true }), a = board()
    const integration = new WorkflowCollaborationIntegration({ memoryBoards: a.memoryBoards }, async () => 'computer')
    try {
      const result = { kind: 'changes', operations: [{ kind: 'note_create', boardId: 'board-one',
        text: 'A corrected note', expectedRevision: 6, commandId: 'note-command' }] } satisfies BoardResult
      const execution = await f.finish(f.execution.id, { outcome: 'succeeded', output: {
        summary: 'Complete', board: result, routing: { kind: 'finish' }, data: { latestDeliverable: 'Result', remainingFindings: [] },
      } })
      a.rejectRevision()
      const sourceEventKey = `${execution.id}:result`
      let conflict: unknown
      try {
        await f.owner.oneShotConnection().transaction(sql => integration.hooks.resultLocked(sql, {
          run: f.run, version: f.version, execution, sourceEventKey, result, summary: 'Complete',
        }))
      } catch (error) { conflict = error }
      expect(isWorkflowResultEffectFailure(conflict)).toBe(true)
      if (!isWorkflowResultEffectFailure(conflict)) throw new Error('Expected exact failed application evidence')
      expect((await db.pool.query('select source_key from collaboration_test_events where source_key=$1', [sourceEventKey])).rows).toEqual([])
      expect((await db.pool.query(`select payload from run_activity where run_id=$1
        and kind='collaboration_lifecycle' and payload->>'sourceEventKey'=$2`,
      [f.run.id, `${sourceEventKey}:awaiting-acceptance`])).rows).toEqual([])
      expect(await integration.effectRepairPrompt(f.owner, conflict)).toContain('revision 7')
      expect(a.readDigest.mock.calls[0]![0]).toEqual({ subject: conflict.subject, work: conflict.work })
    } finally { await f.close() }
  }, 120000)
})
