import assert from 'node:assert/strict'
import type pg from 'pg'
import { HarnessExecutionSchema, type HarnessExecution } from '@foreman-code/contracts'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import { ExclusiveGraphConnection, type GraphTransactionSql } from '../../src/modules/run-graph/connection.js'
import { graphSourceDigest } from '../../src/modules/run-graph/publication.js'
import { canonicalRepeatEffectReceipt } from '../../src/modules/run-graph/repeatPublication.js'
import type { RepeatCanonicalReceipt } from '../../src/modules/run-graph/repeatReceipts.js'
import { readAcceptedRepeatRunLocked } from '../../src/modules/runs/repeatStartRead.js'
import { readRepeatAcceptedResultLocked } from '../../src/modules/runs/repeatPostgres.js'
import { repeatTerminalResolution } from '../../src/modules/runs/repeatNode.js'
import { bindRepeatNodeInput, repeatDigest, repeatExecutionIdentity, repeatSlotId, type RepeatResolution } from '../../src/modules/runs/repeatResolution.js'
import { currentUnitSnapshot, currentUnitRunRow, currentUnitVersionRow, currentUnitConfigurationRows, type CurrentUnitSnapshot } from './currentUnitSnapshot.js'

/** Already-persisted ordinary V3 read data. Only SQL is scripted: immutable
 * readers, raw-result parser, input pins and canonical receipt checks are real.
 * This is not an admission writer, a native capture channel or a database test. */
export function currentExecutionReadUnit(f: CurrentUnitSnapshot = currentUnitSnapshot('execution-read', 'single')) {
  f.version.contentHash = graphSourceDigest({ definition: f.version.definition,
    configurations: f.version.agentConfigurationVersionIds, entryNodeId: f.version.entryNodeId })
  f.run = { ...f.run, executionState: 'running', startedAt: f.createdAt }
  const node = f.version.definition.nodes[0]!
  assert(node.kind !== 'job', 'execution-read fixture requires an Agent node')
  const candidate = HarnessExecutionSchema.parse({ id: `${f.run.id}-execution`, runId: f.run.id, workflowNodeId: node.id,
    agentId: node.agentId, agentConfigurationVersionId: f.version.agentConfigurationVersionIds[node.agentId], attempt: 1,
    input: {}, state: 'queued', createdAt: f.createdAt })
  const ref = { nodeId: node.id, occurrence: null }
  const bound = bindRepeatNodeInput({ version: f.version, runInput: f.run.input, recipient: candidate,
    ref, occurrence: null, entry: null, predecessors: [] })
  const physical = { execution_run_id: candidate.runId, execution_node_id: candidate.workflowNodeId,
    execution_agent_id: candidate.agentId, execution_attempt: candidate.attempt, execution_occurrence_id: null,
    identity_occurrence_id: null, technical_attempt: candidate.attempt, workflow_node_id: candidate.workflowNodeId,
    slot_id: repeatSlotId(f.run.id, ref), occurrence_id: null, identity: repeatExecutionIdentity(candidate) }
  const state = {
    execution: HarnessExecutionSchema.parse({ ...candidate, input: bound.input }), accepted: false,
    result: undefined as undefined | { occurrence_id: null; result_json: string; result_digest: string },
    resolution: undefined as RepeatResolution | undefined,
    head: true, headSequence: '1', physical,
    receipts: [] as RepeatCanonicalReceipt[],
    effects: new Map<string, string>(),
    extra: undefined as undefined | ((q: string, values: unknown[]) => unknown[] | undefined),
  }
  const calls: Array<{ q: string; values: unknown[] }> = []
  function receipt(kind: 'input.bind' | 'terminal.accept') {
    const digest = graphSourceDigest({ kind, executionId: state.execution.id, inputDigest: bound.digest })
    const value = canonicalRepeatEffectReceipt(f.scope, { kind, entityId: state.execution.id, digest }, graphSourceDigest({ kind, metadata: true }))
    state.effects.set(kind, digest); state.receipts.push(value); return value
  }
  receipt('input.bind')
  function seedAccepted(execution: HarnessExecution,
    resolution = repeatTerminalResolution(f.version, f.scope, ref, execution)) {
    state.execution = HarnessExecutionSchema.parse(execution); state.accepted = true
    state.result = { occurrence_id: null, result_json: canonicalGraphJson(execution.result, 4 * 1024 * 1024),
      result_digest: repeatDigest(execution.result, 4 * 1024 * 1024) }
    state.resolution = structuredClone(resolution)
    state.receipts = state.receipts.filter((row) => row.evidence.sourceKind !== 'node_resolution')
    receipt('terminal.accept')
  }
  function receiptRows(values: unknown[]) {
    assert.equal(values[0], f.run.id)
    const saved = state.receipts.find((item) => item.evidence.sourceKind === values[1]
      && item.evidence.sourceId === values[2] && item.evidence.sourceRevision === values[3])
    if (!saved) return []
    const effect = state.receipts.find((item) => item.effect?.kind === values[4] && item.effect?.entityId === values[5])
    return [{ workspace_id: f.scope.workspaceId, workflow_id: f.scope.workflowId,
      workflow_version_id: f.scope.workflowVersionId, execution_semantics_version: 3, protocol_version: 1,
      head_sequence: state.headSequence, source_digest: saved.sourceDigest, source_semantic_digest: saved.semanticDigest,
      source_sequence: '1', effect_digest: effect?.effect?.digest ?? null,
      effect_semantic_digest: effect?.semanticDigest ?? null, effect_sequence: effect ? '1' : null }]
  }
  async function query(text: string, values: unknown[] = []) {
    const q = text.replace(/\s+/g, ' ').trim()
    calls.push({ q, values: structuredClone(values) })
    const result = (rows: unknown[] = []) => ({ rows: structuredClone(rows), rowCount: rows.length, command: '', oid: 0, fields: [] })
    if (q.startsWith('begin ') || q === 'commit' || q === 'rollback') return result()
    const extra = state.extra?.(q, values)
    if (extra !== undefined) return result(extra)
    if (q.startsWith('select r.id,r.workspace_id,r.workflow_id,r.workflow_version_id,r.execution_state,')) {
      assert.deepEqual(values, [f.run.id]); return result([currentUnitRunRow(f)])
    }
    if (q.startsWith('with pinned_version as materialized')) {
      assert.deepEqual(values, [f.version.id, f.run.workspaceId, f.run.workflowId, Object.values(f.run.agentConfigurationVersionIds)])
      return result([{ versions: [currentUnitVersionRow(f)], configurations: currentUnitConfigurationRows(f) }])
    }
    if (q.startsWith('select id,workspace_id,workflow_id,version,entry_node_id,execution_semantics_version,record from workflow_versions')) {
      assert.deepEqual(values, [f.version.id, f.run.workspaceId, f.run.workflowId]); return result([currentUnitVersionRow(f)])
    }
    if (q.startsWith('select id,workspace_id,agent_id,version,record from agent_configuration_versions')) {
      assert.deepEqual(values, [f.run.workspaceId, Object.values(f.run.agentConfigurationVersionIds)])
      return result(currentUnitConfigurationRows(f))
    }
    if (q.startsWith('with pinned_head as materialized')) {
      assert.deepEqual(values, [candidate.id, f.run.id])
      const heads = state.head ? [{ protocol_version: 1 }] : []
      const executions = heads.length ? [{ ...state.physical, record: state.execution, accepted: state.accepted,
        input_json: canonicalGraphJson(bound.input), input_digest: bound.digest }] : []
      const digest = state.effects.get('input.bind')
      return result([{ heads, executions, effects: executions.length && digest ? [{ payload_digest: digest }] : [] }])
    }
    if (q === 'select protocol_version from run_graph_heads where run_id=$1 for share') {
      assert.deepEqual(values, [f.run.id]); return result(state.head ? [{ protocol_version: 1 }] : [])
    }
    if (q.startsWith('select e.record,e.accepted,x.identity,s.slot_id,')) {
      assert.deepEqual(values, [candidate.id, f.run.id])
      return result([{ ...state.physical, record: state.execution, accepted: state.accepted,
        input_json: canonicalGraphJson(bound.input), input_digest: bound.digest }])
    }
    if (q === 'select payload_digest from run_repeat_effects where run_id=$1 and effect_kind=$2 and entity_id=$3') {
      assert.equal(values[0], f.run.id); assert.equal(values[2], candidate.id)
      const digest = state.effects.get(String(values[1])); return result(digest ? [{ payload_digest: digest }] : [])
    }
    if (q.startsWith('select p.ordinal,coalesce(json_agg(q)')) {
      const requested = JSON.parse(String(values[0])) as Array<{ ordinal: number; run_id: string;
        source_kind: string; source_id: string; source_revision: string; effect_kind: string | null; entity_id: string | null }>
      return result(requested.map(item => ({ ordinal: item.ordinal,
        receipts: receiptRows([item.run_id, item.source_kind, item.source_id,
          item.source_revision, item.effect_kind, item.entity_id]),
      })))
    }
    if (q.includes('join run_graph_sources s')) return result(receiptRows(values))
    if (q === 'select occurrence_id,result_json,result_digest from run_repeat_results where execution_id=$1 and run_id=$2') {
      assert.deepEqual(values, [candidate.id, f.run.id]); return result(state.result ? [state.result] : [])
    }
    if (q === 'select record from run_repeat_resolutions where run_id=$1 and occurrence_key=$2 and workflow_node_id=$3') {
      assert.deepEqual(values, [f.run.id, '', node.id]); return result(state.resolution ? [{ record: state.resolution }] : [])
    }
    // Main-local executions have no device dispatch intent or native placement.
    if (/from execution_dispatch_intents where execution_id=\$1/.test(q) || q.startsWith('select record from execution_native_placements where execution_id=$1')) return result([])
    throw new Error(`Unscripted current execution read SQL: ${q}`)
  }
  const connection = new ExclusiveGraphConnection({ query } as unknown as pg.ClientBase, () => undefined)
  const snapshot = () => ({ run: f.run, version: f.version, configurations: f.configurations, stopRequested: false, cleanupPending: false })
  const read = () => connection.transaction(async (sql) => {
    const current = await readAcceptedRepeatRunLocked(sql, f.run.id)
    return readRepeatAcceptedResultLocked(sql, current, candidate.id)
  }, true)
  const transaction = <T>(work: (sql: GraphTransactionSql) => Promise<T>) => connection.transaction(work, true)
  return { f, ref, bound, state, candidate, calls, connection, read, transaction, snapshot, seedAccepted }
}
