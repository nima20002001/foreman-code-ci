import assert from 'node:assert/strict'
import type pg from 'pg'
import { HarnessExecutionSchema, type HarnessExecution, type NativeSessionReference } from '@foreman-code/contracts'
import { DomainError } from '../../src/modules/errors.js'
import { ExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import type { RunOwnership } from '../../src/modules/runs/ownership.js'

export function recoveryExecution(state: HarnessExecution['state'] = 'running'): HarnessExecution {
  return HarnessExecutionSchema.parse({ id: 'execution-a', runId: 'run-a', workflowNodeId: 'node-a',
    agentId: 'agent-a', agentConfigurationVersionId: 'configuration-a', attempt: 1,
    workingDirectory: '/project', runtimeDirectory: '/runtime/execution-a', nativeSessionId: 'session-a',
    state, input: { prompt: 'original input' }, createdAt: '2026-09-26T00:00:00.000Z',
    ...(state === 'completed' ? { result: { outcome: 'succeeded', output: { value: 'durable result' } },
      finishedAt: '2026-09-26T00:01:00.000Z' } : {}) })
}
export function recoveryIdentity(execution: HarnessExecution) {
  const { id, runId, workflowNodeId, agentId, agentConfigurationVersionId, attempt, workingDirectory, runtimeDirectory } = execution
  return { id, runId, workflowNodeId, agentId, agentConfigurationVersionId, attempt,
    ...(workingDirectory ? { workingDirectory } : {}), ...(runtimeDirectory ? { runtimeDirectory } : {}) }
}

/** SQL protocol fake, not a PostgreSQL emulator. The REAL serialized connection
 * executes owner assertions, before-COMMIT finalizers and rollback. Integration
 * tests separately exercise the new migration and guards on PostgreSQL. */
export function recoveryDatabase(options: { bound?: boolean; detached?: boolean; closed?: boolean; lifetime?: boolean } = {}) {
  const state = {
    execution: recoveryExecution(),
    others: new Map<string, HarnessExecution>(),
    session: { harness: 'codex', providerVersion: '1.0.0', nativeSessionId: 'session-a' } as (NativeSessionReference & { harness: 'codex' }) | null,
    entryPhase: 'entered', finalized: false,
    semantics: '3', fenced: true, active: false, lost: false, fence: '9001',
    inserts: 0, commits: 0, rollbacks: 0,
    afterInsert: undefined as (() => void) | undefined,
    proof: undefined as { generation: string; execution_identity: unknown; reference: unknown | null } | undefined,
    lifetime: undefined as { generation: string; execution_identity: unknown; expected_reference: unknown | null;
      closed_reference: unknown | null; closed: boolean; detached: boolean; detached_reference: unknown | null;
      prior_unclosed: boolean; closed_without_session: boolean } | undefined,
  }
  if (options.bound === false) { delete state.execution.nativeSessionId; state.execution.state = 'starting'; state.session = null }
  if (options.lifetime !== false) state.lifetime = {
    generation: '71', execution_identity: recoveryIdentity(state.execution), expected_reference: state.session,
    closed_reference: options.closed ? state.session : null, closed: options.closed ?? false,
    detached: options.detached ?? false, detached_reference: options.detached ? state.session : null,
    prior_unclosed: false, closed_without_session: options.closed === true && !state.session,
  }
  let savedProof = state.proof
  const rows = (items: unknown[]) => ({ rows: structuredClone(items), rowCount: items.length })
  const raw = {
    async query(text: string, values: unknown[] = []) {
      if (text.startsWith('begin')) { assert.equal(state.active, false); state.active = true; savedProof = structuredClone(state.proof); return rows([]) }
      if (text === 'commit') { state.active = false; state.commits++; return rows([]) }
      if (text === 'rollback') { state.active = false; state.rollbacks++; state.proof = savedProof; return rows([]) }
      if (text.startsWith('select phase from workflow_native_entries')) return rows([{ phase: state.entryPhase }])
      // Main-local executions have no device dispatch intent or native placement.
      if (/from execution_dispatch_intents where execution_id=\$1/.test(text) || text.startsWith('select record from execution_native_placements where execution_id=$1')) return rows([])
      if (text.includes('as semantics') && text.includes('as fenced')) return rows([{ semantics: state.semantics, fenced: state.fenced }])
      if (text.startsWith('select record from harness_executions')) {
        const record = values[0] === state.execution.id ? state.execution : state.others.get(String(values[0]))
        return rows(record?.runId === values[1] ? [{ record }] : [])
      }
      if (text.includes('from execution_native_closures c where execution_id=')) return rows(values[0] === state.execution.id && state.lifetime ? [state.lifetime] : [])
      if (text.includes('from runs r join harness_executions e')) {
        return rows(!state.fenced && !state.finalized && state.lifetime && state.session
          ? [{ ...state.lifetime, record: state.execution, reference: state.session }] : [])
      }
      if (text.includes('from harness_executions e join execution_native_sessions')) return rows(state.lifetime && state.session
        ? [{ ...state.lifetime, record: state.execution, reference: state.session }] : [])
      if (text.includes('from execution_native_recoveries p')) return rows(state.proof && state.lifetime
        && state.proof.generation === state.lifetime.generation && !state.lifetime.prior_unclosed ? [state.proof] : [])
      if (text.startsWith('select e.record,s.reference')) return rows([{ record: state.execution, reference: state.session }])
      if (text.startsWith('select reference') && text.includes('from execution_native_sessions')) return rows(state.session ? [{ reference: state.session, finalized: state.finalized }] : [])
      if (text.startsWith('select e.record,') && text.includes(' as bound')) return rows([{ record: state.execution, bound: Boolean(state.session) }])
      if (text.startsWith('insert into execution_native_recoveries')) {
        assert.equal(state.active, true)
        assert.equal(state.proof, undefined, 'receipt insert must be idempotent, not overwritten')
        state.proof = { generation: String(values[0]), execution_identity: JSON.parse(String(values[2])) as unknown,
          reference: values[3] === null ? null : JSON.parse(String(values[3])) as unknown }
        state.inserts++; state.afterInsert?.(); return { rows: [], rowCount: 1 }
      }
      throw new Error(`Unexpected SQL in recovery protocol test: ${text}`)
    },
  }
  const assertOwned = () => { if (state.lost) throw new DomainError('RUN_OWNERSHIP_LOST', 'test owner lost', 409) }
  const connection = new ExclusiveGraphConnection(raw as unknown as pg.ClientBase, assertOwned)
  const owner = { runId: state.execution.runId, assertOwned, oneShotConnection: () => connection,
    readOneShotFence: async () => { assertOwned(); return { ownerId: '123', fence: state.fence } },
    release: async () => { await connection.close() },
  } as unknown as RunOwnership
  return { state, owner, connection }
}
