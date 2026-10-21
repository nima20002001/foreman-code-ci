import { expect } from 'vitest'
import type pg from 'pg'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { hasSaveNativeSettlement } from '../../src/modules/graph-drafts/saveNativeSettlement.js'
import type { GraphSqlClient } from '../../src/modules/run-graph/connection.js'
import { nativeEntrySourceId, workflowNativeReservation, type WorkflowNativeEntryRecord } from '../../src/modules/runs/workflowNativeEntry.js'
import { repeatDigest } from '../../src/modules/runs/repeatResolution.js'
import { recoveryDatabase, recoveryIdentity } from './eng06Recovery.testSupport.js'

export type SaveNativeProof = 'closed' | 'recovered' | 'unbound-disposal' | 'unbound-recovery' | 'not-submitted' | 'none'
/** Query-boundary rows only, not physical/native evidence. Every read invokes
 * the production canonical readers; unknown SQL fails instead of returning an
 * empty success. The caller may use its own exact immutable snapshot. */
export function saveNativeProtocolFixture(proof: SaveNativeProof,
  f = makeCurrentWorkflowFixture('save-native-proof', 'single')) {
  const unbound = ['unbound-disposal', 'unbound-recovery', 'not-submitted', 'none'].includes(proof)
  const db = recoveryDatabase({ bound: !unbound, closed: proof === 'closed' || proof === 'unbound-disposal',
    lifetime: proof !== 'not-submitted', detached: proof === 'recovered' })
  const identity = f.identities[0]!
  db.state.execution = HarnessExecutionSchema.parse({ ...db.state.execution, id: identity.executionId,
    runId: f.run.id, workflowNodeId: identity.workflowNodeId, agentId: identity.agentId,
    agentConfigurationVersionId: identity.agentConfigurationVersionId, state: 'completed',
    ...(f.run.executionLocation ? { workingDirectory: f.run.executionLocation.rootPath } : {}),
    result: unbound ? { outcome: 'canceled', output: null } : { outcome: 'succeeded', output: { original: true } },
    finishedAt: '2026-09-26T00:01:00.000Z' })
  if (db.state.session) db.state.session.harness = 'codex'
  if (db.state.lifetime) Object.assign(db.state.lifetime, { execution_identity: recoveryIdentity(db.state.execution),
    expected_reference: db.state.session, closed_reference: db.state.lifetime.closed ? db.state.session : null,
    detached_reference: db.state.lifetime.detached ? db.state.session : null })
  if (proof === 'recovered' || proof === 'unbound-recovery') db.state.proof = {
    generation: db.state.lifetime!.generation, execution_identity: recoveryIdentity(db.state.execution), reference: db.state.session,
  }
  const reservation = workflowNativeReservation(f.scope, { nodeId: identity.workflowNodeId, occurrence: null },
    db.state.execution, repeatDigest(db.state.execution.input, 4 * 1024 * 1024))
  const transition: WorkflowNativeEntryRecord = { reservation,
    phase: proof === 'not-submitted' ? 'not_submitted' : 'entered', ownerId: '123', ownerFence: '9001', launchDigest: null }
  const entry = { phase: transition.phase as string, reservation: structuredClone(reservation), reservation_digest: repeatDigest(reservation),
    transition, source_id: nativeEntrySourceId(transition), source_digest: repeatDigest(transition) }
  const receipt = { workspace_id: f.scope.workspaceId, workflow_id: f.scope.workflowId, workflow_version_id: f.version.id,
    execution_semantics_version: 3, protocol_version: 1, head_sequence: '3', source_digest: entry.source_digest,
    source_semantic_digest: repeatDigest([]), source_sequence: '2', effect_digest: null, effect_semantic_digest: null, effect_sequence: null }
  const state = { entry: true, receipt: true, occurrenceId: null as string | null }
  const statements: string[] = [], queryFailures: unknown[] = []
  const result = <R extends pg.QueryResultRow>(rows: unknown[]): pg.QueryResult<R> => ({
    rows: structuredClone(rows) as R[], rowCount: rows.length, command: 'SELECT', oid: 0, fields: [],
  })
  const sql: GraphSqlClient = { async query<R extends pg.QueryResultRow>(text: string, values: unknown[] = []) {
    statements.push(text)
    try {
      expect(text).toMatch(/^select\b/i)
      expect(text).not.toMatch(/\b(insert|update|delete|begin|commit|rollback)\b/i)
      if (text.includes('o.record as occurrence_record')) {
        expect(values[0]).toBe(f.scope.runId)
        const execution = db.state.execution
        return result<R>(values[1] ? [] : [{ id: execution.id, run_id: execution.runId, workflow_node_id: execution.workflowNodeId,
          agent_id: execution.agentId, attempt: execution.attempt, record: execution, repeat_occurrence_id: state.occurrenceId,
          occurrence_record: null, native_reference: db.state.session }])
      }
      if (text.includes('select phase,reservation,reservation_digest,transition,source_id,source_digest')) {
        expect(values).toEqual([db.state.execution.id, f.scope.runId])
        return result<R>(state.entry ? [entry] : [])
      }
      if (text.includes('join run_graph_sources s')) {
        expect(values).toEqual([f.scope.runId, 'execution', entry.source_id, '1', null, null])
        return result<R>(state.receipt ? [receipt] : [])
      }
      return await db.connection.query<R>(text, values)
    } catch (error) { queryFailures.push(error); throw error }
  } }
  return { f, db, sql, state, entry, receipt, statements,
    check: () => hasSaveNativeSettlement(sql, f.scope, f.version),
    async close() {
      // Receipt readers deliberately translate unknown failures into a denial.
      // A stale SQL script must still FAIL the test, not pass a negative case.
      try { expect(queryFailures).toEqual([]) } finally { await db.owner.release() }
    } }
}
