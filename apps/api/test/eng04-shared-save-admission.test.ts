import { describe, expect, it } from 'vitest'
import type pg from 'pg'
import { WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
import { sharedFixture } from './eng04-shared-fixture.js'
import { assertMeaningfulSaveAdmitted, readAffectedGraphRuns } from '../src/modules/graph-drafts/saveAdmission.js'
import { currentSaveAdmissionFixture } from './helpers/currentSaveAdmission.js'
import { saveNativeProtocolFixture } from './helpers/eng07SaveNativeSettlement.testSupport.js'
import { recoveryIdentity } from './helpers/eng06Recovery.testSupport.js'

function fixture() {
  const t = sharedFixture()
  const record = WorkflowRunV3Schema.parse({ ...t.run, executionState: 'completed', outcome: 'succeeded',
    input: { note: 'PRIVATE_RUN_INPUT' }, result: { outcome: 'succeeded', output: { note: 'PRIVATE_RESULT_BODY' } }, finishedAt: t.f.createdAt })
  const row = { id: record.id, workspace_id: record.workspaceId, workflow_id: record.workflowId,
    workflow_version_id: record.workflowVersionId, record, terminal: true,
    cleanup: false, native: false, interactions: false, reviews: false,
    version_row: t.versionRow, configurations: t.configurations }
  const scope = { workspaceId: record.workspaceId, workflowId: record.workflowId, stagedAgentIds: ['agent-z', 'agent-a', 'agent-z'] }
  return { ...t, row, scope }
}
function sqlReturning(rows: unknown[]) {
  // The fixture Run has no executions, so the canonical native-settlement page is empty.
  const query = async (text: string) => text.startsWith('select e.id,e.run_id,')
    ? { rows: [], rowCount: 0 } : { rows: structuredClone(rows), rowCount: rows.length }
  return { client: { query } as unknown as pg.PoolClient }
}
describe('ENG04 shared meaningful-save admission (SQL-shaped unit tests, not PostgreSQL)', () => {
  it('admits an exact terminal v3 snapshot only when every SQL resource flag is settled', async () => {
    const t = fixture(), sql = sqlReturning([t.row])
    await expect(assertMeaningfulSaveAdmitted(sql.client, t.scope)).resolves.toBeUndefined()
    const plan = await readAffectedGraphRuns(sql.client, t.scope)
    expect(plan[0]!.pin.executionSemanticsVersion).toBe(3)
    expect(plan[0]!.settled).toBe(true)
    expect(JSON.stringify(plan)).not.toMatch(/PRIVATE|synthetic-principal|identityHash|latestDeliverable|prompt|resultData/)
  })
  it('rejects retired execution tags even when legacy settlement flags appear complete', async () => {
    const t = fixture()
    for (const semantics of [undefined, 1, 2]) {
      const { executionSemanticsVersion, ...legacy } = t.row.record
      void executionSemanticsVersion
      const record = semantics === undefined ? legacy : { ...legacy, executionSemanticsVersion: semantics }
      const sql = sqlReturning([{ ...t.row, record, version_row: null, configurations: null }])
      await expect(assertMeaningfulSaveAdmitted(sql.client, t.scope)).rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
    }
    await expect(assertMeaningfulSaveAdmitted(sqlReturning([]).client, t.scope)).resolves.toBeUndefined()
  })
  it.each(['cleanup', 'native', 'interactions', 'reviews'] as const)('blocks outstanding or missing %s evidence', async (flag) => {
    const t = fixture()
    for (const value of [true, null, undefined]) {
      await expect(assertMeaningfulSaveAdmitted(sqlReturning([{ ...t.row, [flag]: value }]).client, t.scope))
        .rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
    }
  })
  it('requires terminal Run shape and exact immutable version/configuration/location/approval pins', async () => {
    const t = fixture()
    for (const row of [
      { ...t.row, terminal: false }, { ...t.row, version_row: null }, { ...t.row, configurations: [] },
      { ...t.row, record: { ...t.row.record, finishedAt: undefined } },
      { ...t.row, record: { ...t.row.record, approval: undefined } },
      { ...t.row, record: { ...t.row.record, executionLocation: undefined } },
      { ...t.row, record: { ...t.row.record, authorizationPrincipalId: undefined } },
      { ...t.row, record: { ...t.row.record, agentConfigurationVersionIds: {} } },
      { ...t.row, version_row: { ...t.versionRow, workspace_id: 'other' } },
      { ...t.row, version_row: { ...t.versionRow, record: { ...t.version, contentHash: 'sha256:bad' } } },
      { ...t.row, configurations: t.configurations.map((record) => ({ ...record, agent_id: 'other' })) },
    ]) await expect(assertMeaningfulSaveAdmitted(sqlReturning([row]).client, t.scope))
      .rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
  })
  it.each([null, '3', 4, 99])('does not let version %s fall through as legacy', async (tag) => {
    const t = fixture()
    await expect(assertMeaningfulSaveAdmitted(sqlReturning([{ ...t.row, record: { ...t.row.record, executionSemanticsVersion: tag } }]).client, t.scope))
      .rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
  })
  it('keeps opaque rejection free of private Run/configuration/result detail', async () => {
    const t = fixture(), sql = sqlReturning([{ ...t.row, version_row: null }])
    let error: unknown
    try { await assertMeaningfulSaveAdmitted(sql.client, t.scope) } catch (caught) { error = caught }
    expect(error).toBeInstanceOf(Error)
    expect(String(error)).not.toMatch(/PRIVATE|synthetic-principal|cfg-|run-eng04|latestDeliverable/)
    await expect(readAffectedGraphRuns(sql.client, t.scope)).rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
  })
  it('admits an empty affected Run set and returns an empty edit plan', async () => {
    const t = fixture()
    const sql = sqlReturning([])
    await expect(assertMeaningfulSaveAdmitted(sql.client, t.scope)).resolves.toBeUndefined()
    expect(await readAffectedGraphRuns(sql.client, t.scope)).toEqual([])
  })

  it.each(['cleanup', 'native', 'interactions', 'reviews'] as const)(
    'keeps an outstanding %s obligation visible in the edit plan and blocks Save', async flag => {
      const t = fixture()
      const sql = sqlReturning([{ ...t.row, [flag]: true }])
      await expect(assertMeaningfulSaveAdmitted(sql.client, t.scope))
        .rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
      const pendingField = { cleanup: 'cleanupPending', native: 'nativePending',
        interactions: 'interactionPending', reviews: 'reviewPending' }[flag]
      expect(await readAffectedGraphRuns(sql.client, t.scope)).toEqual([
        expect.objectContaining({ settled: false, [pendingField]: true }),
      ])
    },
  )

  it.each(['missing', 'session', 'generation', 'parent', 'attempt'] as const)(
    'rejects %s native closure evidence despite settled resource flags', async fault => {
      const t = currentSaveAdmissionFixture('save-closure')
      const native = saveNativeProtocolFixture(fault === 'generation' ? 'recovered' : 'closed',
        { ...t.f, run: t.record })
      const query = async (text: string, values?: unknown[]) => {
        if (text.startsWith('select r.id from runs')) return { rows: [{ id: t.row.id }], rowCount: 1 }
        if (text.startsWith('select r.id,r.workspace_id')) {
          return { rows: [structuredClone(t.row)], rowCount: 1 }
        }
        return native.sql.query(text, values)
      }
      const client = { query } as unknown as pg.PoolClient
      const scope = { ...t.f.scope, stagedAgentIds: [] }
      try {
        await expect(assertMeaningfulSaveAdmitted(client, scope)).resolves.toBeUndefined()
        expect(await readAffectedGraphRuns(client, scope)).toEqual([
          expect.objectContaining({ settled: true, nativePending: false }),
        ])
        const lifetime = native.db.state.lifetime!
        switch (fault) {
          case 'missing':
            lifetime.closed = false
            break
          case 'session':
            lifetime.closed_reference = { ...native.db.state.session!, nativeSessionId: 'other-session' }
            break
          case 'generation':
            native.db.state.proof!.generation = '70'
            break
          case 'parent':
            lifetime.execution_identity = { ...recoveryIdentity(native.db.state.execution), runId: 'other-run' }
            break
          case 'attempt':
            lifetime.execution_identity = { ...recoveryIdentity(native.db.state.execution), attempt: 2 }
            break
        }
        await expect(assertMeaningfulSaveAdmitted(client, scope))
          .rejects.toMatchObject({ code: 'WORKFLOW_RUNS_UNSETTLED' })
        expect(await readAffectedGraphRuns(client, scope)).toEqual([
          expect.objectContaining({ settled: false, nativePending: true }),
        ])
      } finally {
        await native.close()
      }
    },
  )
})
