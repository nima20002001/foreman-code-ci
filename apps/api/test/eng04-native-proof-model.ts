import assert from 'node:assert/strict'
import type pg from 'pg'
import { HarnessExecutionSchema, type HarnessExecution, type NativeSessionReference } from '@foreman-code/contracts'
import { ExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { settleRepeatNativeExecutionWithProofLocked } from '../src/modules/interactions/repeatNativeSettlement.js'

/** Scripted SQL model, NOT PostgreSQL or native verification. The production
 * G1 facade, closure reader and settlement implementation execute unchanged.
 * No closure-store record(), native manager, credential issuer or event writer
 * is called: positive rows below are explicitly synthetic model input. */
export function nativeProofModel() {
  const at = '2026-09-25T00:00:00.000Z'
  const execution = HarnessExecutionSchema.parse({ id: 'execution-proof-1', runId: 'run-proof-1',
    workflowNodeId: 'node-proof-1', agentId: 'agent-proof-1', agentConfigurationVersionId: 'config-proof-1',
    attempt: 1, input: { original: 'input-1' }, state: 'completed', createdAt: at, startedAt: at, finishedAt: at,
    workingDirectory: '/synthetic/workspace', runtimeDirectory: '/synthetic/runtime/execution-proof-1',
    nativeSessionId: 'session-proof-1', result: { outcome: 'succeeded', output: { done: true } } })
  const session: NativeSessionReference = { harness: 'codex', providerVersion: 'synthetic-model-only',
    nativeSessionId: execution.nativeSessionId! }
  const identity = { id: execution.id, runId: execution.runId, workflowNodeId: execution.workflowNodeId,
    agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId,
    attempt: execution.attempt, workingDirectory: execution.workingDirectory, runtimeDirectory: execution.runtimeDirectory }
  const state = {
    semantics: '3', owned: true, pins: true, outstanding: false, hasSession: true, hasClosure: true,
    finalized: false, finalizedWrites: 0, negativeCleanup: false,
    execution: structuredClone(execution), rowNodeId: execution.workflowNodeId,
    session: structuredClone(session), configHarness: 'codex', configPinned: true,
    closure: { generation: '41', closed: true, prior_unclosed: false,
      execution_identity: identity, expected_reference: structuredClone(session) as NativeSessionReference | null,
      closed_reference: structuredClone(session) },
  }
  const statements: string[] = []
  let saved: Pick<typeof state, 'finalized' | 'finalizedWrites'> | undefined
  const result = (rows: unknown[]) => ({ rows: structuredClone(rows), rowCount: rows.length, command: '', oid: 0, fields: [] })
  const raw = { query: async (text: string, values: unknown[] = []) => {
    statements.push(text)
    if (text.startsWith('begin')) { saved = { finalized: state.finalized, finalizedWrites: state.finalizedWrites }; return result([]) }
    if (text === 'commit') { saved = undefined; return result([]) }
    if (text === 'rollback') { if (saved) Object.assign(state, saved); saved = undefined; return result([]) }
    if (text.includes('with sessions as materialized')) {
      assert.deepEqual(values, [execution.runId, [execution.id]])
      return result([{ id: execution.id, record: state.execution, reference: state.hasSession ? state.session : null,
        finalized: state.finalized, complex: false, outstanding: state.outstanding,
        configuration: { harness: state.configHarness, agent_id: execution.agentId, pinned: state.configPinned },
        ...state.closure, closed: state.hasClosure && state.closure.closed,
        detached: false, closed_without_session: false }])
    }
    if (text.includes('update execution_native_sessions s')) {
      assert.deepEqual(JSON.parse(String(values[0])), [{ execution_id: execution.id, reference: state.session }])
      state.finalized = true
      state.finalizedWrites += 1
      return result([{ execution_id: execution.id }])
    }
    if (text.includes("record->>'executionSemanticsVersion' as semantics")) {
      assert.deepEqual(values, [execution.runId])
      return result([{ id: execution.runId, semantics: state.semantics, workspace_id: 'workspace-proof-1',
        workflow_id: 'workflow-proof-1', pins_match: state.pins, negative_cleanup: state.negativeCleanup }])
    }
    if (text.includes('select id,run_id,workflow_node_id,agent_id,attempt,record from harness_executions')) {
      assert.deepEqual(values, [execution.id, execution.runId])
      return result([{ id: execution.id, run_id: execution.runId, workflow_node_id: state.rowNodeId,
        agent_id: execution.agentId, attempt: execution.attempt, record: state.execution }])
    }
    if (text.includes('from workflow_native_entries where execution_id=$1 and run_id=$2')) return result([])
    if (text.includes('select j.id,j.execution_id,j.state,j.record')) return result([])
    if (text.includes('exists(select 1 from worker_credential_bindings')) return result([{ outstanding: state.outstanding }])
    if (text.includes('select reference,workflow_finalized_at is not null as finalized')) {
      assert.deepEqual(values, [execution.id])
      return result(state.hasSession ? [{ reference: state.session, finalized: state.finalized }] : [])
    }
    if (text.includes('from durable_interactions i where i.run_id=$1')) return result([])
    if (text.includes('from agent_configuration_versions c join runs r')) {
      assert.deepEqual(values, [execution.agentConfigurationVersionId, execution.runId])
      return result([{ pinned: state.configPinned, harness: state.configHarness, agent_id: execution.agentId,
        workspace_id: 'workspace-proof-1' }])
    }
    if (text.includes('join lateral (select * from execution_native_closures')) {
      assert.deepEqual(values, [execution.id, execution.runId])
      return result(state.hasClosure ? [{ ...state.closure, record: state.execution, reference: state.session }] : [])
    }
    if (text.includes('from execution_native_recoveries p join execution_native_closures c')) {
      assert.deepEqual(values, [execution.id])
      // No recovery receipt is seeded by this model. In particular, a missing
      // original close must still fail the real settlement gate.
      return result([])
    }
    if (text.startsWith('update execution_native_sessions')) {
      assert.deepEqual(values, [execution.id, JSON.stringify(state.session)])
      state.finalized = true; state.finalizedWrites += 1
      return result([{ execution_id: execution.id }])
    }
    // Main-local executions have no device dispatch intent or native placement.
    if (text.includes('from execution_dispatch_intents')
      || text.includes('from execution_native_placements where execution_id=')) return result([])
    throw new Error(`Unexpected model SQL: ${text}`)
  } }
  const connection = new ExclusiveGraphConnection(raw as unknown as pg.ClientBase, () => {
    if (!state.owned) throw Object.assign(new Error('Synthetic owner was lost'), { code: 'RUN_OWNERSHIP_LOST' })
  })
  const settle = (incoming: HarnessExecution = execution) => connection.transaction((sql) =>
    settleRepeatNativeExecutionWithProofLocked(sql, execution.runId, incoming))
  return { state, execution, session, statements, connection, settle }
}
