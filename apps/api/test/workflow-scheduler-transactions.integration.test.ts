import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { AcceptedWorkflowRunV3Schema, type RunStartV3Input } from '@foreman-code/contracts/wave25'
import { RunBoardSnapshotSchema } from '@foreman-code/contracts/run-snapshots'
import { PostgresCommandCoordinator, commandInputHash } from '../src/modules/commands/postgres.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { repeatStartPublication } from '../src/modules/run-graph/repeatStartPublication.js'
import { assertRepeatCanonicalReceiptLocked } from '../src/modules/run-graph/repeatReceipts.js'
import { admitRepeatRun, repeatStartReceipt } from '../src/modules/runs/repeatStartAdmission.js'
import type { ScheduledStart } from '../src/modules/schedules/postgresDispatcher.js'
import { WorkflowScheduleService } from '../src/modules/schedules/service.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import { sch11Minute, sch11Once } from './helpers/sch11ClockCases.js'
import { sch11Blocked, sch11DomainState, sch11Fixture, sch11Pool, type Sch11Database, type Sch11Fixture } from './helpers/sch11Fixture.js'
import { rejectableDeferred } from './helpers/deferred.js'

async function reached(signal: Promise<unknown>, work: Promise<unknown>) {
  await Promise.race([signal, work.then(() => { throw new Error('Dispatch completed before the expected test barrier') })])
}

describe.skipIf(!postgresEnabled)('SCH-11 PostgreSQL transaction ordering and common Start shape', () => {
  let database: Sch11Database
  let f: Sch11Fixture
  beforeAll(async () => { database = await agent3Database() }, 60_000)
  afterAll(async () => { await database?.close() })
  beforeEach(async () => { f = await sch11Fixture(database) }, 60_000)

  it('a peer session reads the schedule persisted in the fixture database', async () => {
    const saved = await f.save()
    const peer = sch11Pool(database)
    const peerService = new WorkflowScheduleService(peer.pool, new PostgresCommandCoordinator(peer.pool), f.clock)
    try {
      expect(await peerService.get(f.reader.principal, f.scope)).toEqual({ schedule: saved })
    } finally {
      await peer.pool.end()
    }
  })

  it('an edit winning after preparation fences the old revision and retains only the new cursor', async () => {
    const saved = await f.save(); f.time.now = saved.nextOccurrenceAt!
    const prepared = rejectableDeferred(), release = rejectableDeferred()
    const work = f.dispatcher(async (...args) => { prepared.resolve(); await release.promise; await f.startUsing()(...args) }).dispatch(saved)
    try {
      await reached(prepared.promise, work)
      const edited = await f.save({ ...sch11Once, time: '10:30' }, 1)
      release.resolve(); await work
      expect(await f.countRuns()).toBe(0); expect(await f.history()).toEqual([])
      expect(await f.current()).toEqual(edited)
      expect((await sch11DomainState(f)).snapshots).toEqual([])
      f.time.now = edited.nextOccurrenceAt!
      await f.dispatcher().dispatch(edited)
      expect(await f.history()).toEqual([expect.objectContaining({ status: 'accepted', scheduleRevision: 2,
        dueAt: '2030-01-07T10:30:00.000Z' })])
    } finally {
      release.resolve()
      await work.catch(() => {
        // ignore: cleanup joins the dispatcher without replacing an earlier test failure.
      })
    }
  }, 60_000)

  it.each(['disable', 'clear'] as const)('%s winning before claim leaves no speculative Start artifacts', async (operation) => {
    const saved = await f.save(); f.time.now = saved.nextOccurrenceAt!
    const prepared = rejectableDeferred(), release = rejectableDeferred()
    const work = f.dispatcher(async (...args) => { prepared.resolve(); await release.promise; await f.startUsing()(...args) }).dispatch(saved)
    try {
      await reached(prepared.promise, work)
      await f.service[operation](f.writer.principal, 'http', f.command())
      release.resolve(); await work
      const state = await sch11DomainState(f)
      for (const key of ['runs', 'snapshots', 'runAuthority', 'graphHeads'] as const) expect(state[key]).toEqual([])
      expect((await database.pool.query(`select 1 from management_command_receipts
        where operation='run.start' and result->>'workflowId'=$1`, [f.scope.workflowId])).rows).toEqual([])
      expect(await f.history()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'disabled', scheduleRevision: 1 })])
      expect((await f.current())?.enabled ?? false).toBe(false)
    } finally {
      release.resolve()
      await work.catch(() => {
        // ignore: cleanup joins the dispatcher without replacing an earlier test failure.
      })
    }
  }, 60_000)

  it.each(['disable', 'edit'] as const)('claim winning the row locks commits once; a blocked %s changes only future admissions', async (operation) => {
    const saved = await f.save(); f.time.now = saved.nextOccurrenceAt!
    const peer = sch11Pool(database), entered = rejectableDeferred<number>(), release = rejectableDeferred()
    const peerPid = (await peer.pool.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
    const peerService = new WorkflowScheduleService(peer.pool, new PostgresCommandCoordinator(peer.pool), f.clock)
    let mutation: ReturnType<WorkflowScheduleService['save']> | undefined
    const work = f.dispatcher(async (principal, input, guard) => {
      await f.startUsing()(principal, input, { ...guard, afterAcceptance: async (sql, run) => {
        await guard.afterAcceptance(sql, run)
        entered.resolve((await sql.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid)
        await release.promise
      } })
    }).dispatch(saved)
    try {
      await reached(entered.promise, work)
      mutation = operation === 'disable'
        ? peerService.disable(f.writer.principal, 'mcp', f.command())
        : peerService.save(f.writer.principal, 'mcp', { ...f.command(), schedule: { ...sch11Once, time: '10:30' } })
      void mutation.catch(() => {
        // ignore: attach while row locks are held; the original mutation is awaited below.
      })
      await sch11Blocked(database.pool, peerPid, await entered.promise)
      expect(await f.countRuns()).toBe(0)
      release.resolve(); await work
      const changed = (await mutation).value
      expect(changed).toMatchObject({ enabled: operation === 'edit', revision: 2,
        nextOccurrenceAt: operation === 'edit' ? '2030-01-07T10:30:00.000Z' : null })
      expect(await f.current()).toEqual(changed)
      const facts = await f.history()
      expect(facts).toHaveLength(1); expect(facts[0]?.status).toBe('accepted')
      expect((await database.pool.query('select execution_state from runs where workflow_id=$1', [f.scope.workflowId])).rows)
        .toEqual([{ execution_state: 'queued' }])
      const state = await sch11DomainState(f)
      await f.dispatcher().dispatch(saved)
      expect(await sch11DomainState(f)).toEqual(state)
    } finally {
      release.resolve()
      await work.catch(() => {
        // ignore: cleanup joins the dispatcher without replacing an earlier test failure.
      })
      await mutation?.catch(() => {
        // ignore: cleanup joins the peer operation whose outcome is checked in the test body.
      })
      await peer.pool.end()
    }
  }, 60_000)

  async function versionInput() {
    const row = (await database.pool.query<{ revision: string }>('select revision::text from workflows where id=$1', [f.scope.workflowId])).rows[0]!
    const policy = f.fixture.version.definition.executionPolicy
    if (!policy || typeof policy.maxNodeExecutions !== 'number') throw new Error('The sequential SCH-11 fixture must have an execution policy')
    return { ...f.scope, commandId: randomUUID(), executionSemanticsVersion: 3 as const,
      expectedRevision: Number(row.revision), expectedWorkflowVersionId: f.fixture.version.id,
      expectedAgentConfigurationVersionIds: f.fixture.version.agentConfigurationVersionIds,
      // An executable change, not a presentation-only rename/layout save.
      graph: { ...f.fixture.version.definition, executionPolicy: { ...policy, maxNodeExecutions: policy.maxNodeExecutions + 1 } } }
  }

  it('a workflow save winning after preparation pins the fresh head, capture and receipt atomically', async () => {
    const saved = await f.save(); f.time.now = saved.nextOccurrenceAt!
    const prepared = rejectableDeferred(), release = rejectableDeferred()
    let calls = 0
    const work = f.dispatcher(async (...args) => {
      calls++; if (calls === 1) { prepared.resolve(); await release.promise }
      await f.startUsing()(...args)
    }).dispatch(saved)
    try {
      await reached(prepared.promise, work)
      const newer = (await f.workflows.current.save(f.writer.principal, 'http', await versionInput())).value
      release.resolve(); await work
      expect(calls).toBe(2)
      expect(newer.version.id).not.toBe(f.fixture.version.id)
      expect(await f.history()).toEqual([expect.objectContaining({ status: 'accepted', workflowVersionId: newer.version.id })])
      const rows = await database.pool.query(`select r.workflow_version_id,s.workflow_version_id as snapshot_version,
        c.result->>'workflowVersionId' as receipt_version from runs r join run_board_snapshots s on s.run_id=r.id
        join management_command_receipts c on c.operation='run.start' and c.result->>'id'=r.id where r.workflow_id=$1`, [f.scope.workflowId])
      expect(rows.rows).toEqual([{ workflow_version_id: newer.version.id,
        snapshot_version: newer.version.id, receipt_version: newer.version.id }])
    } finally {
      release.resolve()
      await work.catch(() => {
        // ignore: cleanup joins the dispatcher without replacing an earlier test failure.
      })
    }
  }, 60_000)

  it('claim winning before a blocked meaningful save preserves its pin and rejects the now-unsettled edit', async () => {
    const saved = await f.save(); f.time.now = saved.nextOccurrenceAt!
    const input = await versionInput()
    const peer = sch11Pool(database), entered = rejectableDeferred<number>(), release = rejectableDeferred()
    const peerPid = (await peer.pool.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
    const peerWorkflows = new WorkflowManagementService(peer.pool, new PostgresCommandCoordinator(peer.pool))
    let saving: ReturnType<WorkflowManagementService['current']['save']> | undefined
    const work = f.dispatcher(async (principal, request, guard) => {
      await f.startUsing()(principal, request, { ...guard, afterAcceptance: async (sql, run) => {
        await guard.afterAcceptance(sql, run)
        entered.resolve((await sql.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid)
        await release.promise
      } })
    }).dispatch(saved)
    try {
      await reached(entered.promise, work)
      saving = peerWorkflows.current.save(f.writer.principal, 'mcp', input)
      void saving.catch(() => {
        // ignore: attach while row locks are held; the original save rejection is asserted below.
      })
      await sch11Blocked(database.pool, peerPid, await entered.promise)
      release.resolve(); await work
      await expect(saving).rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
      expect((await database.pool.query('select current_version_id from workflows where id=$1', [f.scope.workflowId])).rows)
        .toEqual([{ current_version_id: f.fixture.version.id }])
      expect(await f.history()).toEqual([expect.objectContaining({ status: 'accepted', workflowVersionId: f.fixture.version.id })])
      const snapshot = RunBoardSnapshotSchema.parse((await database.pool.query('select record from run_board_snapshots where workflow_id=$1', [f.scope.workflowId])).rows[0]!.record)
      expect(snapshot).toMatchObject({ kind: 'available', workflowVersionId: f.fixture.version.id })
      await f.dispatcher().dispatch(saved)
      expect((await database.pool.query('select record from run_board_snapshots where workflow_id=$1', [f.scope.workflowId])).rows[0]!.record).toEqual(snapshot)
    } finally {
      release.resolve()
      await work.catch(() => {
        // ignore: cleanup joins the dispatcher without replacing an earlier test failure.
      })
      await saving?.catch(() => {
        // ignore: cleanup joins the peer operation whose outcome is checked in the test body.
      })
      await peer.pool.end()
    }
  }, 60_000)

  it.each(['revoke', 'remove-start-grant'] as const)('rechecks %s between preparation and admission', async (change) => {
    const saved = await f.save(); f.time.now = saved.nextOccurrenceAt!
    const prepared = rejectableDeferred(), release = rejectableDeferred()
    const work = f.dispatcher(async (...args) => { prepared.resolve(); await release.promise; await f.startUsing()(...args) }).dispatch(saved)
    try {
      await reached(prepared.promise, work)
      if (change === 'revoke') await database.pool.query('update management_principals set revoked_at=now() where id=$1', [f.writer.principal.id])
      else await database.pool.query('update management_principals set grants=$2::jsonb where id=$1', [f.writer.principal.id,
        JSON.stringify(f.writer.principal.grants.map((grant) => ({ ...grant, actions: grant.actions.filter((action) => action !== 'runs:start') })))])
      release.resolve(); await work
      expect(await f.history()).toEqual([expect.objectContaining({ status: 'rejected', reason: 'schedule_authorization_denied' })])
      const state = await sch11DomainState(f)
      for (const key of ['runs', 'snapshots', 'runAuthority', 'graphHeads'] as const) expect(state[key]).toEqual([])
      expect((await f.current())?.nextOccurrenceAt).toBeNull()
      expect((await database.pool.query(`select 1 from management_command_receipts
        where operation='run.start' and result->>'workflowId'=$1`, [f.scope.workflowId])).rows).toEqual([])
    } finally {
      release.resolve()
      await work.catch(() => {
        // ignore: cleanup joins the dispatcher without replacing an earlier test failure.
      })
    }
  }, 60_000)

  it('skips queued scheduled overlap and does not cancel or rewrite its accepted artifacts on disable', async () => {
    const saved = await f.save(sch11Minute); f.time.now = saved.nextOccurrenceAt!
    await f.dispatcher().dispatch(saved)
    const before = await sch11DomainState(f)
    const next = (await f.current())!; f.time.now = next.nextOccurrenceAt!
    await f.dispatcher().dispatch(next)
    expect(await f.history()).toEqual([expect.objectContaining({ status: 'skipped', reason: 'overlap' }),
      expect.objectContaining({ status: 'accepted' })])
    await f.service.disable(f.writer.principal, 'http', f.command())
    const after = await sch11DomainState(f)
    for (const key of ['runs', 'snapshots', 'runAuthority', 'graphHeads'] as const) expect(after[key]).toEqual(before[key])
    expect(await f.countRuns()).toBe(1)
  }, 60_000)

  it('scheduled and manual Start share the exact accepted Run, board snapshot, canonical receipt and replay shapes', async () => {
    const saved = await f.save(); f.time.now = saved.nextOccurrenceAt!
    const captured: Array<Parameters<ScheduledStart>> = []
    const manualInputs: RunStartV3Input[] = []
    const outcomes: Array<Awaited<ReturnType<typeof admitRepeatRun>>> = []
    await f.dispatcher(async (principal, request, guard) => {
      captured.push([principal, request, guard])
      const manual = { ...request, commandId: randomUUID() }; manualInputs.push(manual)
      outcomes.push(await admitRepeatRun(database.pool, f.locations, principal, 'http', manual, repeatStartPublication))
      outcomes.push(await admitRepeatRun(database.pool, f.locations, principal, 'schedule', request, repeatStartPublication, { schedule: guard }))
    }).dispatch(saved)
    expect(captured).toHaveLength(1); expect(outcomes).toHaveLength(2)
    expect(outcomes.map((outcome) => outcome.replayed)).toEqual([false, false])
    const manual = AcceptedWorkflowRunV3Schema.parse(outcomes[0]!.value)
    const scheduled = AcceptedWorkflowRunV3Schema.parse(outcomes[1]!.value)
    expect(Object.keys(scheduled).sort()).toEqual(Object.keys(manual).sort())
    const normalizeRun = (value: typeof manual) => ({ ...value, id: '<run>', authorizationPrincipalId: '<authority>', createdAt: '<instant>' })
    expect(normalizeRun(scheduled)).toEqual(normalizeRun(manual))
    expect(scheduled.id).not.toBe(manual.id)
    expect(scheduled.authorizationPrincipalId).not.toBe(manual.authorizationPrincipalId)
    const read = async (id: string) => {
      const row = (await database.pool.query(`select s.record as snapshot,s.admission_trigger,
        c.result as receipt,c.command_id,c.input_hash,c.target_key from run_board_snapshots s
        join management_command_receipts c on c.operation='run.start' and c.result->>'id'=s.run_id where s.run_id=$1`, [id])).rows
      expect(row).toHaveLength(1)
      return { ...row[0]!, snapshot: RunBoardSnapshotSchema.parse(row[0]!.snapshot),
        receipt: AcceptedWorkflowRunV3Schema.parse(row[0]!.receipt) }
    }
    const manualRows = await read(manual.id), scheduledRows = await read(scheduled.id)
    expect(manualRows.receipt).toEqual(manual); expect(scheduledRows.receipt).toEqual(scheduled)
    expect(manualRows.admission_trigger).toBe('manual'); expect(scheduledRows.admission_trigger).toBe('schedule')
    expect(manualRows.snapshot).toMatchObject({ kind: 'available', ...f.scope, runId: manual.id,
      workflowVersionId: manual.workflowVersionId, capturedAt: manual.createdAt })
    expect(scheduledRows.snapshot).toMatchObject({ kind: 'available', ...f.scope, runId: scheduled.id,
      workflowVersionId: scheduled.workflowVersionId, capturedAt: scheduled.createdAt })
    expect({ ...scheduledRows.snapshot, runId: '<run>', capturedAt: '<instant>' })
      .toEqual({ ...manualRows.snapshot, runId: '<run>', capturedAt: '<instant>' })
    const [principal, request, guard] = captured[0]!
    expect(manualRows.input_hash).toBe(commandInputHash(manualInputs[0]!))
    expect(scheduledRows.input_hash).toBe(commandInputHash({ ...request, scheduleOccurrenceId: guard.occurrenceId }))
    expect(scheduledRows.target_key).toBe(manualRows.target_key)
    expect(scheduledRows.command_id).toBe(request.commandId)
    await withExclusiveGraphConnection(database.pool, (connection) => connection.transaction(async (sql) => {
      await assertRepeatCanonicalReceiptLocked(sql, repeatStartReceipt(manual))
      await assertRepeatCanonicalReceiptLocked(sql, repeatStartReceipt(scheduled))
    }))
    const state = await sch11DomainState(f)
    expect(await admitRepeatRun(database.pool, f.locations, principal, 'mcp', manualInputs[0]!, repeatStartPublication))
      .toEqual({ value: manual, replayed: true })
    expect(await admitRepeatRun(database.pool, f.locations, principal, 'schedule', request, repeatStartPublication, { schedule: guard }))
      .toEqual({ value: scheduled, replayed: true })
    expect(await sch11DomainState(f)).toEqual(state)
    // The manual Run is not classified as scheduled overlap.
    expect(await f.history()).toEqual([expect.objectContaining({ status: 'accepted', runId: scheduled.id })])
  }, 60_000)
})
