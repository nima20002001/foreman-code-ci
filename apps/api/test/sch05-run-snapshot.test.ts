import { describe, expect, it } from 'vitest'
import { AcceptedRepeatStartV1Schema } from '@foreman-code/contracts/wave25'
import { RunBoardSnapshotSchema } from '@foreman-code/contracts/run-snapshots'
import { projectRunBoardSnapshot } from '../src/modules/runs/boardSnapshotProjection.js'
import { admitRepeatRun } from '../src/modules/runs/repeatStartAdmission.js'
import { decodeRunHistoryCursor, encodeRunHistoryCursor } from '../src/modules/runs/historyCursor.js'
import { startFixture, startSqlFixture } from './eng04-start-fixtures.js'

function acceptedFixture() {
  const f = startFixture()
  return AcceptedRepeatStartV1Schema.parse({ run: f.run, snapshot: {
    request: f.request, authorizationPrincipalId: f.run.authorizationPrincipalId,
    executable: { version: f.version, configurations: f.configurations.map((row) => row.record) },
    workflow: { id: f.version.workflowId, workspaceId: f.version.workspaceId, revision: 7,
      currentVersionId: f.version.id, archived: false, definition: f.version.definition },
    workspace: { id: f.version.workspaceId, archived: false, location: f.location }, draft: null,
  } })
}

describe('SCH-05 admission Board projection', () => {
  it('captures names, Agent pins, explicit geometry and edges without mutable aliases or private fields', () => {
    const accepted = acceptedFixture(), definition = accepted.snapshot.workflow.definition
    const y = definition.nodes[1]!
    if (y.kind === 'job') throw new Error('Agent-only fixture unexpectedly contains a Job')
    y.name = 'Agent Y'; y.position = { x: -24.5, y: 812.25 }; y.width = 321; y.height = 178
    y.description = 'private description'; y.initialPrompt = 'private instructions'
    definition.edges[0]!.sourceHandle = null; definition.edges[0]!.targetHandle = 'left'
    const capture = projectRunBoardSnapshot(accepted)
    expect(RunBoardSnapshotSchema.parse(capture)).toEqual(capture)
    expect(capture.nodes[1]).toEqual({ id: y.id, name: 'Agent Y', agentId: y.agentId,
      agentConfigurationVersionId: accepted.run.agentConfigurationVersionIds[y.agentId],
      position: { x: -24.5, y: 812.25 }, size: { width: 321, height: 178 } })
    expect(capture.edges).toEqual(definition.edges)
    expect(JSON.stringify(capture)).not.toContain('private')
    const before = JSON.stringify(capture)
    y.name = 'Renamed'; y.position.x = 999; y.width = 900
    definition.nodes.splice(1, 1); definition.edges.length = 0
    expect(JSON.stringify(capture)).toBe(before)
  })

  it('materializes missing saved layout once and accepts a saved label as the name', () => {
    const accepted = acceptedFixture(), y = accepted.snapshot.workflow.definition.nodes[1]!
    delete y.name; y.label = 'Saved Y label'; delete y.position; delete y.width; delete y.height
    expect(projectRunBoardSnapshot(accepted).nodes[1]).toMatchObject({ name: 'Saved Y label',
      position: { x: 364, y: 120 }, size: { width: 208, height: 112 } })
  })

  it('captures newer saved presentation even without a new immutable version ID', () => {
    const accepted = acceptedFixture()
    const original = structuredClone(accepted.snapshot.executable.version.definition.nodes[0]!)
    const saved = accepted.snapshot.workflow.definition.nodes[0]!
    saved.name = 'New saved name'; saved.position = { x: 991, y: -17 }; saved.width = 450
    const capture = projectRunBoardSnapshot(accepted)
    expect(accepted.snapshot.executable.version.definition.nodes[0]).toEqual(original)
    expect(capture.nodes[0]).toMatchObject({ name: 'New saved name', position: { x: 991, y: -17 }, size: { width: 450 } })
    expect(capture.workflowVersionId).toBe(accepted.snapshot.executable.version.id)
  })

  it('rejects a wrong saved version or configuration pin instead of consulting current Agents', () => {
    const accepted = acceptedFixture(); accepted.run.workflowVersionId = 'forged-version'
    expect(() => projectRunBoardSnapshot(accepted)).toThrow(/admitted workflow version/)
    const other = acceptedFixture(), node = other.snapshot.workflow.definition.nodes[0]!
    if (node.kind === 'job') throw new Error('Agent-only fixture unexpectedly contains a Job')
    other.run.agentConfigurationVersionIds[node.agentId] = 'forged-configuration'
    expect(() => projectRunBoardSnapshot(other)).toThrow(/configuration pin/)
  })
})

describe('SCH-05 common Start capture (rollback-capable SQL double; not PostgreSQL)', () => {
  it('captures before publication and an exact command replay never captures again', async () => {
    const f = startSqlFixture()
    const first = await admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication)
    expect(first.replayed).toBe(false)
    expect(f.database().boardSnapshot).toMatchObject({ kind: 'available', runId: first.value.id,
      workflowVersionId: first.value.workflowVersionId, capturedAt: first.value.createdAt })
    expect(f.database().admissionTrigger).toBe('manual')
    const insert = f.calls.findIndex((call) => call.sql.startsWith('insert into run_board_snapshots'))
    const publish = f.calls.findIndex((call) => call.sql.startsWith('insert into run_graph_heads'))
    expect(insert).toBeGreaterThan(-1); expect(insert).toBeLessThan(publish)
    expect(f.calls[insert]!.transaction).toBe(true)
    const saved = structuredClone(f.database().boardSnapshot)
    const replay = await admitRepeatRun(f.pool, f.locations, f.principal, 'mcp', f.request, f.publication)
    expect(replay).toEqual({ value: first.value, replayed: true })
    expect(f.database().boardSnapshot).toEqual(saved)
    expect(f.calls.filter((call) => call.sql.startsWith('insert into run_board_snapshots'))).toHaveLength(1)
  })

  it('rolls back the Run, new authority and command when snapshot storage fails', async () => {
    const f = startSqlFixture(); f.state.failBoardSnapshot = true
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication))
      .rejects.toThrow(/snapshot storage failure/)
    expect(f.database().run).toBeUndefined(); expect(f.database().boardSnapshot).toBeUndefined()
    expect(f.database().receipt).toBeUndefined(); expect(f.database().bindings).toEqual([])
    expect(f.database().principals).toHaveLength(1); expect(f.state.publications).toBe(0)
    f.state.failBoardSnapshot = false
    expect((await admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication)).replayed).toBe(false)
  })

  it('rolls back a captured snapshot if canonical publication fails later', async () => {
    const f = startSqlFixture()
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, {
      initializeLocked: async () => { throw new Error('publication failed after capture') },
    })).rejects.toThrow(/publication failed/)
    expect(f.calls.some((call) => call.sql.startsWith('insert into run_board_snapshots'))).toBe(true)
    expect(f.database().run).toBeUndefined(); expect(f.database().boardSnapshot).toBeUndefined()
    expect(f.database().receipt).toBeUndefined()
  })

  it('does not backfill pre-migration receipts and keeps scheduled admission fenced at this base', async () => {
    const f = startSqlFixture()
    await admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication)
    const legacy = structuredClone(f.database()); delete legacy.boardSnapshot; delete legacy.admissionTrigger
    f.replaceDatabase(legacy)
    expect((await admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication)).replayed).toBe(true)
    expect(f.database().boardSnapshot).toBeUndefined()
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'mcp', f.request, f.publication,
      { triggerJobId: 'scheduled-job' })).rejects.toMatchObject({ code: 'REPEAT_TRIGGER_UNSUPPORTED' })
  })

  it('keeps one committed capture when a lost COMMIT reply is retried', async () => {
    const f = startSqlFixture(); f.state.loseCommit = true
    await expect(admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication)).rejects.toThrow()
    const saved = structuredClone(f.database().boardSnapshot)
    expect(saved).toMatchObject({ kind: 'available' })
    const replay = await admitRepeatRun(f.pool, f.locations, f.principal, 'http', f.request, f.publication)
    expect(replay.replayed).toBe(true); expect(f.database().boardSnapshot).toEqual(saved)
    expect(f.calls.filter((call) => call.sql.startsWith('insert into run_board_snapshots'))).toHaveLength(1)
  })
})

describe('SCH-05 opaque keyset cursor', () => {
  const scope = { workspaceId: 'workspace-1', workflowId: 'workflow-1' }
  it('preserves all PostgreSQL microseconds and the exact ID tie-break', () => {
    const boundary = { admittedAt: '2026-09-28T01:02:03.123456Z', runId: 'run-a_Z-09' }
    expect(decodeRunHistoryCursor(scope, encodeRunHistoryCursor(scope, boundary))).toEqual(boundary)
    expect(decodeRunHistoryCursor(scope)).toBeUndefined()
  })
  it('binds cursors to both workspace and workflow', () => {
    const value = encodeRunHistoryCursor(scope, { admittedAt: '2026-09-28T00:00:00.000001Z', runId: 'run-a' })
    expect(() => decodeRunHistoryCursor({ ...scope, workspaceId: 'other' }, value)).toThrow(/same workspace/)
    expect(() => decodeRunHistoryCursor({ ...scope, workflowId: 'other' }, value)).toThrow(/same workspace/)
  })
  it.each(['', '!', 'a'.repeat(17000), Buffer.from('{}').toString('base64url'), Buffer.from('[1]').toString('base64url')])(
    'rejects malformed or oversized cursor %#', (value) => {
      expect(() => decodeRunHistoryCursor(scope, value)).toThrow(/cursor/)
    })
  it('rejects invalid dates and noncanonical encodings', () => {
    expect(() => encodeRunHistoryCursor(scope, { admittedAt: '2026-02-30T00:00:00.000000Z', runId: 'run-a' })).toThrow()
    const value = encodeRunHistoryCursor(scope, { admittedAt: '2026-02-28T00:00:00.999999Z', runId: 'run-a' })
    expect(() => decodeRunHistoryCursor(scope, value + '=')).toThrow()
    expect(() => encodeRunHistoryCursor(scope, { admittedAt: '2026-02-28T00:00:00.000Z', runId: 'run-a' })).toThrow()
  })
})
