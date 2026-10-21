import { beforeEach, describe, expect, it, vi } from 'vitest'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { startSqlFixture } from './eng04-start-fixtures.js'

// Native policy, recovery and trigger services are explicit seams in this SQL
// fixture. Their real platform/DB/provider qualification is NOT claimed here.
const hooks = vi.hoisted(() => ({ native: vi.fn(), recovery: vi.fn(), trigger: vi.fn() }))
vi.mock('../src/modules/harnesses/nativeWorkflowConfiguration.js', async (original) => ({
  ...await original<typeof import('../src/modules/harnesses/nativeWorkflowConfiguration.js')>(),
  assertNativeWorkflowConfiguration: hooks.native,
}))
vi.mock('../src/modules/runs/recoveryPolicy.js', () => ({ assertWorkflowRecovered: hooks.recovery }))
vi.mock('../src/modules/workflows/triggerAuthority.js', () => ({ assertTriggerDispatch: hooks.trigger }))
beforeEach(() => { vi.resetAllMocks() })

describe('ENG04 NATIVE-3 Start — real G1 with PostgreSQL-shaped rows, NOT a PostgreSQL pass', () => {
  it('rejects new Run publication during maintenance and preserves same-command retries and readback', async () => {
    const f = startSqlFixture()
    f.state.maintenanceActive = true
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'mcp', f.request, f.publication))
      .rejects.toMatchObject({ code: 'RUN_START_MAINTENANCE' })
    expect(f.database().run).toBeUndefined()
    expect(f.database().receipt).toBeUndefined()
    f.state.maintenanceActive = false
    const accepted = await admitRepeatRun(f.pool, f.locations, f.principal, 'mcp', f.request, f.publication)
    expect(accepted.replayed).toBe(false)
    expect(f.database().run).toEqual(accepted.value)
    f.state.maintenanceActive = true
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication))
      .resolves.toEqual({ ...accepted, replayed: true })
  })
  it.each(['http', 'mcp'] as const)('%s accepts new authority/pins/Run/source/receipt/audit in one known COMMIT', async (source) => {
    const f = startSqlFixture()
    const outcome = await admitRepeatRun(f.pool, f.locations, f.principal, source, f.request, f.publication)
    expect(outcome.replayed).toBe(false)
    expect(outcome.value.executionSemanticsVersion).toBe(3)
    expect(outcome.value.authorizationPrincipalId).not.toBe(f.principal.id)
    expect(f.database().bindings[0]).toMatchObject({ principal_id: outcome.value.authorizationPrincipalId,
      caller_principal_id: f.principal.id, run_id: outcome.value.id })
    expect(f.database().receipt?.result).toEqual(outcome.value)
    expect(f.database().source).toBeDefined()
    expect(f.database().succeededAudit).toBe(true)
    expect(f.database().run).toEqual(outcome.value)
    expect(f.state.filesystemCalls).toBe(1)
    expect(outcome.value).toMatchObject({ workflowVersionId: f.version.id,
      agentConfigurationVersionIds: f.version.agentConfigurationVersionIds, executionLocation: f.location })
    expect(f.database().boardSnapshot).toMatchObject({ runId: outcome.value.id, workflowVersionId: f.version.id })
    expect(hooks.recovery).toHaveBeenCalledTimes(1)
  })
  it('replays the initial command result after mutable-head changes and Stop, without location validation or publication', async () => {
    const f = startSqlFixture()
    const first = await admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication)
    f.workflow.revision = '99'; f.workflow.current_version_id = 'unrelated-new-head'
    f.state.filesystemError = true; f.state.stopped = true; f.state.cleanupPending = true
    const actual = f.database().run!
    f.database().run = { ...actual, executionState: 'completed', outcome: 'canceled',
      result: { outcome: 'canceled' }, finishedAt: '2026-09-25T01:00:00.000Z' }
    f.calls.length = 0
    const replay = await admitRepeatRun(f.pool, f.locations, f.principal, 'mcp', f.request, undefined)
    expect(replay).toEqual({ value: first.value, replayed: true })
    expect(f.state.filesystemCalls).toBe(1)
    expect(f.state.publications).toBe(1)
    expect(f.calls.some((call) => call.sql.includes('from workflows where') || call.sql.includes('from agents a'))).toBe(false)
    expect(f.calls.some((call) => call.sql.startsWith('insert into '))).toBe(false)
  })
  it('loses the COMMIT reply without granting a returned new Run; same-command retry only replays', async () => {
    const f = startSqlFixture(); f.state.loseCommit = true
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication)).rejects.toThrow('lost COMMIT reply')
    expect(f.database().run).toBeDefined()
    expect(f.releases).toContain(true)
    const failure = f.calls.find((call) => call.sql.includes("'failed'"))
    expect(JSON.parse(String(failure?.values[3]))).toMatchObject({ admissionOutcome: 'unconfirmed' })
    const replay = await admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, undefined)
    expect(replay.replayed).toBe(true)
    expect(f.state.publications).toBe(1)
    expect(f.calls.filter((call) => call.sql.startsWith('insert into runs('))).toHaveLength(1)
  })
  it('rechecks the same command after location preparation and does not INSERT when another caller already committed it', async () => {
    const f = startSqlFixture(), initial = structuredClone(f.database())
    const first = await admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication)
    const committed = structuredClone(f.database())
    f.replaceDatabase(initial); f.calls.length = 0
    f.state.onSnapshot = () => f.replaceDatabase(committed)
    const raced = await admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication)
    expect(raced).toEqual({ value: first.value, replayed: true })
    expect(f.calls.some((call) => call.sql.startsWith('insert into runs('))).toBe(false)
    expect(f.state.publications).toBe(1)
  })
  it('fails closed without a production publisher, before filesystem/Run/authority insertion', async () => {
    const f = startSqlFixture()
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, undefined))
      .rejects.toMatchObject({ code: 'REPEAT_START_RUNTIME_UNAVAILABLE' })
    expect(f.state.filesystemCalls).toBe(0)
    expect(f.database().run).toBeUndefined()
    expect(f.database().principals).toHaveLength(1)
  })
  it('a no-op publication callback cannot commit the Run, authority, receipt or audit', async () => {
    const f = startSqlFixture(); f.state.missingSource = true
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication))
      .rejects.toMatchObject({ code: 'REPEAT_PUBLICATION_RECEIPT_CONFLICT' })
    expect(f.database().run).toBeUndefined()
    expect(f.database().principals).toHaveLength(1)
    expect(f.database().receipt).toBeUndefined()
    expect(f.database().succeededAudit).toBe(false)
  })
  it.each(['source', 'binding', 'physical_scope', 'immutable_hash'] as const)('rejects damaged %s backing on replay without creating a replacement Run', async (kind) => {
    const f = startSqlFixture()
    await admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication)
    if (kind === 'source') f.database().source = undefined
    if (kind === 'binding') f.database().bindings = []
    if (kind === 'physical_scope') f.state.rows = (sql, _values, rows) => sql.startsWith('select r.id,')
      ? rows.map((row) => ({ ...row, workflow_id: 'crossed-workflow' })) : rows
    if (kind === 'immutable_hash') f.version.contentHash = `sha256:${'f'.repeat(64)}`
    f.calls.length = 0
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication)).rejects.toThrow()
    expect(f.calls.some((call) => call.sql.startsWith('insert into runs('))).toBe(false)
    expect(f.state.publications).toBe(1)
  })
  it('successful audit without command receipt is uncertainty, not negative-submission permission', async () => {
    const f = startSqlFixture(); f.database().succeededAudit = true
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication))
      .rejects.toMatchObject({ code: 'RUN_START_RECEIPT_MISSING' })
    expect(f.state.filesystemCalls).toBe(0)
    expect(f.database().run).toBeUndefined()
  })
  it('same command with changed full workflow revision is a conflict even when the version is unchanged', async () => {
    const f = startSqlFixture()
    await admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication)
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'http',
      { ...f.request, expectedWorkflowRevision: f.request.expectedWorkflowRevision + 1 }, f.publication))
      .rejects.toMatchObject({ code: 'COMMAND_ID_CONFLICT' })
    expect(f.state.publications).toBe(1)
  })
  it.each(['revoked', 'expired', 'grants'] as const)('rechecks %s caller authority even for receipt replay', async (kind) => {
    const f = startSqlFixture()
    await admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication)
    if (kind === 'revoked') f.database().principals[0]!.revoked_at = new Date()
    if (kind === 'expired') f.state.denyClock = true
    if (kind === 'grants') f.database().principals[0]!.grants = []
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, undefined)).rejects.toThrow()
    expect(f.state.filesystemCalls).toBe(1)
  })
  it.each(['capacity', 'unknown_capacity', 'workflow_revision', 'configuration', 'location', 'draft', 'native', 'recovery'] as const)('%s denial has no accepted Run/receipt/authority', async (kind) => {
    const f = startSqlFixture()
    if (kind === 'capacity') f.state.count = '32'
    if (kind === 'unknown_capacity') f.state.count = 'unknown'
    if (kind === 'workflow_revision') f.workflow.revision = '8'
    if (kind === 'configuration') f.configurations[0]!.current_configuration_version_id = 'changed'
    if (kind === 'location') f.state.onSnapshot = () => { f.locationRow.location_revision = '5' }
    if (kind === 'native') hooks.native.mockImplementation(() => { throw new Error('native policy denied') })
    if (kind === 'recovery') hooks.recovery.mockRejectedValue(new Error('recovery incomplete'))
    const request = kind === 'draft' ? { ...f.request, draftId: 'missing-draft', expectedDraftRevision: 1 } : f.request
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'http', request, f.publication)).rejects.toThrow()
    expect(f.database().run).toBeUndefined()
    expect(f.database().receipt).toBeUndefined()
    expect(f.database().principals).toHaveLength(1)
  })
  it('rejects trigger dispatch while the accepted trigger contract is v2-only', async () => {
    const f = startSqlFixture()
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication,
      { triggerJobId: 'trigger-job-test' })).rejects.toMatchObject({ code: 'REPEAT_TRIGGER_UNSUPPORTED' })
    expect(hooks.trigger).not.toHaveBeenCalled()
    expect(f.database().run).toBeUndefined()
    expect(f.database().receipt).toBeUndefined()
  })
})
