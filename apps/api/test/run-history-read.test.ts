import { beforeEach, describe, expect, it, vi } from 'vitest'
import type pg from 'pg'
import { ManagementPrincipalSchema, type ManagementGrant } from '@foreman-code/contracts/management'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture, RepeatOccurrenceV1Schema, RUN_GRAPH_LIMITS, type RunWorktree } from '@foreman-code/contracts/wave25'
import { readCurrentRunDetails } from '../src/modules/runs/currentRead.js'
import { readAcceptedRepeatRunLocked, readRecordedRepeatRunSnapshot } from '../src/modules/runs/repeatStartRead.js'
import { readRepeatExecutionLocked, readRepeatExecutionsLocked } from '../src/modules/runs/repeatExecutionRead.js'
import { repeatDigest, repeatExecutionIdentity, repeatSlotId } from '../src/modules/runs/repeatResolution.js'
import { isGraphTransactionFinalizing } from '../src/modules/run-graph/connection.js'
import { RunnerAdmission } from '../src/modules/runs/runnerAdmission.js'
import { ExecutionLimiter } from '../src/modules/runs/limiter.js'
import { compactRunDetails } from '../src/mcp/operator/runSummary.js'

// The immutable publication readers are ports here; live grants, transaction
// ownership, bounded queries and public redaction run their real implementations.
vi.mock('../src/modules/runs/repeatStartRead.js', () => ({ readAcceptedRepeatRunLocked: vi.fn(), readRecordedRepeatRunSnapshot: vi.fn() }))
vi.mock('../src/modules/runs/repeatExecutionRead.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/runs/repeatExecutionRead.js')>()
  return { ...actual, readRepeatExecutionLocked: vi.fn(actual.readRepeatExecutionLocked),
    readRepeatExecutionsLocked: vi.fn(actual.readRepeatExecutionsLocked) }
})
beforeEach(() => vi.resetAllMocks())

function fixture(queued = false, size = 1, form: 'single' | 'repeat' = 'single') {
  const f = makeCurrentWorkflowFixture('history', form)
  const entry = { runInput: {}, external: [], carry: null }
  const occurrence = form === 'repeat' ? RepeatOccurrenceV1Schema.parse({ contractVersion: 1,
    identity: { scope: f.scope, blockId: 'repair', occurrenceId: 'history-occurrence', occurrenceIndex: 1 },
    input: { bindingId: 'history-entry', inputDigest: repeatDigest(entry), previous: null } }) : null
  const run = AcceptedWorkflowRunV3Schema.parse({ ...f.run, authorizationPrincipalId: 'private-authority',
    ...(queued ? { executionState: 'running', outcome: 'pending' } : {
      executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded', output: { text: 'saved-result' } },
      finishedAt: f.createdAt }), executionLocation: { runnerId: 'runner', rootPath: '/private/project', locationRevision: 1,
      identityHash: `sha256:${'1'.repeat(64)}` } })
  const { executionId, ...identity } = f.identities[0]!
  const execution = { ...identity, id: executionId, runId: run.id,
    input: form === 'repeat' ? { executionSemanticsVersion: 3, runInput: {}, occurrence, entry, predecessors: [] } : {},
    createdAt: f.createdAt,
    ...(queued ? { state: 'queued' as const } : { state: 'completed' as const, result: run.result, finishedAt: f.createdAt }),
    workingDirectory: '/private/project', runtimeDirectory: '/private/runtime' }
  const worktree: RunWorktree = { workingDirectory: '/private/worktree', branch: 'run-branch',
    baseCommit: 'a'.repeat(40), state: 'retained' }
  const principal = ManagementPrincipalSchema.parse({ id: 'history-reader', name: 'History reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
    grants: [{ actions: ['runs:read'], scope: { workspaceIds: [run.workspaceId], workflowIds: [run.workflowId], runIds: [run.id] } }] })
  let liveGrants: ManagementGrant[] = structuredClone(principal.grants)
  let revoked = false
  vi.mocked(readRecordedRepeatRunSnapshot).mockResolvedValue({ run, version: f.version,
    configurations: f.configurations, stopRequested: false, cleanupPending: false } as Awaited<ReturnType<typeof readAcceptedRepeatRunLocked>>)
  const executions = Array.from({ length: size }, (_, index) => index === 0 ? execution
    : { ...execution, id: `history-execution-${index}`, attempt: index + 1 })
  const storedRow = (item: typeof execution) => ({ record: item, accepted: true,
    execution_id: item.id, identity: occurrence ? { ...repeatExecutionIdentity(item), occurrence: occurrence.identity }
      : repeatExecutionIdentity(item),
    slot_id: repeatSlotId(run.id, { nodeId: item.workflowNodeId, occurrence: occurrence?.identity ?? null }),
    occurrence_id: occurrence?.identity.occurrenceId ?? null,
    occurrence_record: occurrence, occurrence_input: JSON.stringify(entry), occurrence_digest: repeatDigest(entry),
    work_activation_id: null, native_work_activation_id: null, attempt_work_activation_id: null,
    execution_run_id: run.id, execution_node_id: item.workflowNodeId, execution_agent_id: item.agentId,
    execution_attempt: item.attempt, execution_occurrence_id: occurrence?.identity.occurrenceId ?? null,
    identity_occurrence_id: occurrence?.identity.occurrenceId ?? null,
    technical_attempt: item.attempt, workflow_node_id: item.workflowNodeId,
    input_json: JSON.stringify(item.input), input_digest: repeatDigest(item.input),
    protocol_version: 1, payload_digest: repeatDigest(item.input) })
  const receipt = { workspace_id: run.workspaceId, workflow_id: run.workflowId, workflow_version_id: run.workflowVersionId,
    execution_semantics_version: 3, protocol_version: 1, head_sequence: '1', source_digest: repeatDigest(execution.input),
    source_semantic_digest: repeatDigest({ saved: true }), source_sequence: '1', effect_digest: repeatDigest(execution.input),
    effect_semantic_digest: repeatDigest({ saved: true }), effect_sequence: '1' }
  let transactionOutcome = 'open'
  const reply = (rows: unknown[], expectedValues?: unknown[]) => (values?: unknown[]) => {
    if (expectedValues) expect(values).toEqual(expectedValues)
    return { rows }
  }
  const activityFacts = () => [reply([{
    run: { revision: '1', stopped: false, outcome: run.outcome,
      started_at: null, execution_state: run.executionState },
    executions: [{ id: execution.id, attempt: 1, revision: '1', state: execution.state,
      outcome: 'result' in execution ? execution.result?.outcome : undefined,
      created_at: f.createdAt, started_at: null, native_session_id: null, harness: null, native_revision: '0' }],
    jobs: [], cis: [], interactions: [], bounds: { high_water: '0', retained_from: '0', observed: 0 },
  }], [run.id, run.workspaceId, run.workflowId, run.workflowVersionId])]
  const receiptRows = () => executions.length === 1 ? [receipt]
    : executions.map((_item, ordinal) => ({ ordinal, receipts: [receipt] }))
  const recordedBatches = () => {
    const batches = []
    for (let offset = 0; offset < executions.length; offset += 16) {
      const batch = executions.slice(offset, offset + 16)
      batches.push(reply(batch.map(record => ({ record })), [run.id, batch.map(item => item.id)]))
    }
    return batches
  }
  // Script persisted row sets, leaving SQL construction to the real readers.
  const readResponses = () => [
    reply([{ workspace_id: run.workspaceId, workflow_id: run.workflowId }], [run.id, run.workspaceId]),
    reply([{ id: principal.id, name: principal.name, audience: 'operator', grants: liveGrants,
      expires_at: new Date(principal.expiresAt), revoked_at: revoked ? new Date() : null, delegated_from: null }]),
    reply(executions.map(item => ({ id: item.id }))),
    ...recordedBatches(),
    reply(executions.map(storedRow).reverse()),
    reply(receiptRows()),
    reply([]),
    reply([{ pending: false }]),
    ...activityFacts(),
    reply([], [run.id, '0', '0', '0', 101]),
    reply([], [run.id]),
    ...activityFacts(),
    reply([{ record: worktree }]),
    reply([]),
    reply(receiptRows()),
  ]
  let responses: ReturnType<typeof readResponses> = []
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    // Transaction commands are the fake client's state changes, not business query matchers.
    if (sql.startsWith('begin ')) {
      transactionOutcome = 'open'
      responses = readResponses()
      return { rows: [] }
    }
    if (sql === 'commit' || sql === 'rollback') {
      transactionOutcome = sql === 'commit' ? 'committed' : 'rolled_back'
      return { rows: [] }
    }
    const respond = responses.shift()
    if (!respond) throw new Error('Unexpected read after the saved Run snapshot completed')
    return respond(values)
  })
  const release = vi.fn()
  const pool = { connect: async () => ({ query, release, on() {}, removeListener() {} }) } as unknown as pg.Pool
  return { ...f, run, execution, executions, worktree, principal, query, release,
    transactionOutcome: () => transactionOutcome,
    read: () => readCurrentRunDetails(pool, principal, run.workspaceId, run.id),
    grants: (value: ManagementGrant[]) => { liveGrants = value }, revoke: () => { revoked = true } }
}

describe('saved current Run read', () => {
  it('reports a live host-capacity wait and clears it when the execution is admitted', async () => {
    const f = fixture(true)
    const gate = new RunnerAdmission(1)
    let release!: () => void
    const held = gate.run('blocking-run', new AbortController().signal,
      () => new Promise<void>(resolve => { release = resolve }))
    const queued = gate.run(f.run.id, new AbortController().signal, async () => undefined,
      { execution: f.execution })
    try {
      expect((await f.read()).executions[0]).toMatchObject({ queueReason: {
        kind: 'host_capacity', hostKey: 'main', limit: 1, since: expect.any(String),
      } })
      expect(compactRunDetails(await f.read()).executions[0]).toMatchObject({ queueReason: {
        kind: 'host_capacity', hostKey: 'main', limit: 1,
      } })
      f.grants([])
      await expect(f.read()).rejects.toMatchObject({ code: 'ACCESS_DENIED' })
    } finally {
      release()
      await Promise.all([held, queued])
    }
    f.grants(f.principal.grants)
    expect((await f.read()).executions[0]).not.toHaveProperty('queueReason')
  })

  it('reports the saved workflow concurrency limit and clears a canceled wait', async () => {
    const f = fixture(true)
    const limiter = new ExecutionLimiter(1)
    let release!: () => void
    const held = limiter.run(new AbortController().signal,
      () => new Promise<void>(resolve => { release = resolve }))
    const stop = new AbortController()
    const queued = limiter.run(stop.signal, async () => undefined, f.execution)
    const canceled = expect(queued).rejects.toThrow('Stopped while queued')
    try {
      expect((await f.read()).executions[0]).toMatchObject({ queueReason: {
        kind: 'workflow_parallelism', limit: 1, since: expect.any(String),
      } })
      stop.abort(new Error('Stopped while queued'))
      await canceled
      expect((await f.read()).executions[0]).not.toHaveProperty('queueReason')
    } finally {
      if (!stop.signal.aborted) stop.abort(new Error('Stopped while queued'))
      release()
      await Promise.all([held, canceled])
    }
  })

  it('returns the exact V3 Run and accepted execution without exposing private location or authority', async () => {
    const f = fixture()
    const value = await f.read()
    expect(value.run).toMatchObject({ executionSemanticsVersion: 3, workflowVersionId: f.version.id,
      agentConfigurationVersionIds: f.version.agentConfigurationVersionIds, result: { output: { text: 'saved-result' } } })
    expect(value.executions[0]).toMatchObject({ id: f.execution.id, agentConfigurationVersionId: f.configurations[0]!.id })
    expect(value.activitySnapshot).toMatchObject({ scope: { runId: f.run.id, workflowVersionId: f.version.id }, active: [], queued: [] })
    expect(JSON.stringify(value)).not.toMatch(/private-authority|private\/project|private\/runtime|private\/worktree/)
    expect(value).not.toHaveProperty('worktrees')
    expect(f.transactionOutcome()).toBe('committed')
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('uses live location grants instead of the stale transport principal', async () => {
    const f = fixture()
    f.grants([...f.principal.grants, { actions: ['workspace_locations:read'], scope: { workspaceIds: [f.run.workspaceId] } }])
    const value = await f.read()
    expect(value.run.executionLocation).toEqual(f.run.executionLocation)
    expect(value.executions[0]?.workingDirectory).toBe('/private/project')
    expect(value.worktrees).toEqual([f.worktree])
    expect(value.run).not.toHaveProperty('authorizationPrincipalId')
  })

  it.each(['wrong-run', 'revoked'])('rejects %s authority before reading saved facts', async (kind) => {
    const f = fixture()
    if (kind === 'revoked') f.revoke()
    else f.grants([{ actions: ['runs:read'], scope: { runIds: ['foreign-run'] } }])
    await expect(f.read()).rejects.toMatchObject({ status: 403 })
    expect(readRecordedRepeatRunSnapshot).not.toHaveBeenCalled()
    expect(readRepeatExecutionLocked).not.toHaveBeenCalled()
    expect(readRepeatExecutionsLocked).not.toHaveBeenCalled()
    expect(f.transactionOutcome()).toBe('rolled_back')
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('rejects oversized saved execution history before validating execution pins', async () => {
    const f = fixture()
    f.execution.input = { ...f.execution.input, runInput: { payload: 'x'.repeat(RUN_GRAPH_LIMITS.snapshotBytes) } }
    vi.mocked(readRepeatExecutionLocked).mockRejectedValue(new Error('execution pin changed'))
    vi.mocked(readRepeatExecutionsLocked).mockRejectedValue(new Error('execution pin changed'))

    await expect(f.read()).rejects.toMatchObject({ code: 'RUN_DETAIL_TOO_LARGE', status: 409 })
    expect(readRepeatExecutionLocked).not.toHaveBeenCalled()
    expect(readRepeatExecutionsLocked).not.toHaveBeenCalled()
    expect(f.release).toHaveBeenCalledOnce()
  })

  it('propagates an immutable execution pin conflict without returning partial history', async () => {
    const f = fixture()
    vi.mocked(readRepeatExecutionLocked).mockRejectedValue(new Error('execution pin changed'))
    vi.mocked(readRepeatExecutionsLocked).mockRejectedValue(new Error('execution pin changed'))
    await expect(f.read()).rejects.toThrow('execution pin changed')
    expect(f.transactionOutcome()).toBe('rolled_back')
  })

  it.each([[1, 27], [16, 27], [128, 34]])('reads %i execution attempts within %i statements', async (size, ceiling) => {
    const f = fixture(false, size)
    const detail = await f.read()
    expect(detail.executions.map(item => item.id)).toEqual(f.executions.map(item => item.id))
    expect(f.query.mock.calls.length).toBeLessThanOrEqual(ceiling)
    expect(f.transactionOutcome()).toBe('committed')
  })

  it.each([[1, 27], [16, 27], [128, 34]])('reads %i repeated execution attempts within %i statements', async (size, ceiling) => {
    const f = fixture(false, size, 'repeat')
    const detail = await f.read()
    expect(detail.executions.map(item => item.id)).toEqual(f.executions.map(item => item.id))
    expect(f.query.mock.calls.length).toBeLessThanOrEqual(ceiling)
  })

  it('rejects a missing canonical receipt at the live commit check', async () => {
    const f = fixture(false, 16)
    const query = f.query.getMockImplementation()!
    f.query.mockImplementation(async (...args) => {
      const result = await query(...args)
      const sql = vi.mocked(readRepeatExecutionsLocked).mock.calls[0]?.[0]
        ?? vi.mocked(readRepeatExecutionLocked).mock.calls[0]?.[0]
      if (sql && isGraphTransactionFinalizing(sql)) return { rows: [] }
      return result
    })
    await expect(f.read()).rejects.toMatchObject({ code: 'REPEAT_PUBLICATION_RECEIPT_CONFLICT' })
    expect(f.transactionOutcome()).toBe('rolled_back')
  })
})
