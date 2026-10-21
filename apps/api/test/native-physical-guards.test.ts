import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { didGraphTransactionCommit, ExclusiveGraphConnection, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { workflowNativeReservation, type NativeEntryRow } from '../src/modules/runs/workflowNativeEntry.js'
import * as snapshots from '../src/modules/runs/repeatStartRead.js'
import * as executions from '../src/modules/runs/repeatPostgres.js'
import { repeatDigest } from '../src/modules/runs/repeatResolution.js'
import type { AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { WorkflowNativeProofServices } from '../src/modules/runs/workflowNativeProof.js'
import type { StoredRepeatExecution } from '../src/modules/runs/repeatPostgres.js'
import type { WorkflowNativeCapture } from '../src/modules/interactions/workflowNativeCapture.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import { nativeProofModel } from './eng04-native-proof-model.js'

afterEach(() => vi.restoreAllMocks())

// Scripted guard records only: no claim of real SQL or native-process proof.
function fixture() {
  const { execution, session } = nativeProofModel()
  const owner = { runId: execution.runId, assertOwned() {},
    readOneShotFence: async () => ({ ownerId: 'original-owner', fence: '1' }) } as unknown as RunOwnership
  const scope = { workspaceId: 'workspace-proof-1', workflowId: 'workflow-proof-1', runId: execution.runId,
    workflowVersionId: 'version-proof-1', executionSemanticsVersion: 3 as const }
  const stored = { execution, ref: { nodeId: execution.workflowNodeId, occurrence: null },
    inputDigest: `sha256:${'1'.repeat(64)}` } as StoredRepeatExecution
  const capture = { execution, session, owner,
    source: { type: 'history', history: { correlationId: `execution:${execution.id}`,
      nativeTurnId: 'original-turn', events: [], pendingInteractions: [] } }, closureGeneration: '1',
    lane: { id: 'original-lane', token: 'original-token', connectionGeneration: 1, providerId: 'original-turn' },
    assertCurrent() {} } as unknown as WorkflowNativeCapture
  const run = { id: scope.runId, workspaceId: scope.workspaceId, workflowId: scope.workflowId,
    workflowVersionId: scope.workflowVersionId } as AcceptedWorkflowRunV3
  vi.spyOn(snapshots, 'readAcceptedRepeatRunLocked').mockResolvedValue({ run } as
    Awaited<ReturnType<typeof snapshots.readAcceptedRepeatRunLocked>>)
  vi.spyOn(executions, 'readRepeatExecutionLocked').mockResolvedValue(stored)
  const reservation = workflowNativeReservation(scope, stored.ref, execution, stored.inputDigest)
  const journal: NativeEntryRow = { phase: 'entered', reservation, reservation_digest: repeatDigest(reservation),
    transition: { phase: 'entered' } as NativeEntryRow['transition'],
    source_id: 'original-source', source_digest: `sha256:${'2'.repeat(64)}` }
  const lease = { lease_owner: 'original-owner', lease_ms: 30_000, expires_at: '2099-01-01T00:00:00.000Z' }
  const records = { entry: journal, entry_receipts: [{ workspace_id: scope.workspaceId,
    workflow_id: scope.workflowId, workflow_version_id: scope.workflowVersionId,
    execution_semantics_version: 3, protocol_version: 1, head_sequence: '2',
    source_digest: journal.source_digest!, source_semantic_digest: `sha256:${'3'.repeat(64)}`,
    source_sequence: '1', effect_digest: null, effect_semantic_digest: null, effect_sequence: null }],
    session: { reference: structuredClone(session) }, configuration: { harness: session.harness },
    closure: { generation: '1', expected_reference: structuredClone(session), closed: false },
    lane: { owner_agent_id: execution.agentId, harness: session.harness, native_session_id: session.nativeSessionId,
      generation: '1', token: 'original-token', correlation: `execution:${execution.id}`, provider_id: 'original-turn',
      held: true, ...lease } }
  const reads: unknown[][] = []
  const connection = new ExclusiveGraphConnection({ query: async (sql: string, values?: unknown[]) => {
    if (sql.startsWith('with current_entry')) { reads.push(values!); return { rows: [structuredClone(records)], rowCount: 1 } }
    if (sql.startsWith('update native_session_lanes')) {
      const matches = values?.[0] === capture.lane!.id && values[1] === records.lane.token
        && values[2] === records.lane.generation && values[4] === lease.lease_owner
        && values[5] === records.lane.owner_agent_id && values[6] === records.lane.harness
        && values[7] === records.lane.native_session_id && values[8] === lease.expires_at
      return { rows: matches ? [{ expires_at: lease.expires_at }] : [], rowCount: matches ? 1 : 0 }
    }
    if (sql.startsWith('begin') || ['commit', 'rollback'].includes(sql)) return { rows: [], rowCount: 0 }
    throw new Error(`Unexpected guard SQL: ${sql}`)
  } } as unknown as pg.ClientBase, () => owner.assertOwned())
  const additional = vi.fn(async () => undefined)
  const service = new WorkflowNativeProofServices({ read: () => capture }, additional)
  const check = (sql: GraphTransactionSql) => service.assertNativeBoundaryLocked(sql, run,
    execution, stored.ref, { kind: 'live', session, evidence: {} }, owner)
  return { records, connection, check, reads, additional }
}

for (const field of ['session', 'configuration', 'closure', 'generation', 'token', 'agent', 'turn', 'expiry'] as const) {
  it(`still rejects replaced physical ${field}`, async () => {
    const f = fixture()
    if (field === 'session') f.records.session.reference.nativeSessionId = 'different-session'
    if (field === 'configuration') f.records.configuration.harness = 'claude'
    if (field === 'closure') f.records.closure.closed = true
    if (field === 'generation') f.records.lane.generation = '2'
    if (field === 'token') f.records.lane.token = 'different-token'
    if (field === 'agent') f.records.lane.owner_agent_id = 'different-agent'
    if (field === 'turn') f.records.lane.provider_id = 'different-turn'
    if (field === 'expiry') f.records.lane.held = false
    await expect(f.connection.transaction(f.check)).rejects.toMatchObject({ code: expect.any(String) })
  })
}

it('reads every physical field afresh, including expiry and additional guards, at the next boundary', async () => {
  const f = fixture()
  await expect(f.connection.transaction(async (sql) => {
    await f.check(sql)
    f.records.lane.held = false
    await f.check(sql)
  })).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
  expect(f.reads).toHaveLength(2)
  expect(f.reads[0]).toEqual(f.reads[1])
  expect(f.additional).toHaveBeenCalledTimes(2)
})

it.each(['journal', 'receipt'] as const)('rejects changed entered %s before committing a boundary', async field => {
  const f = fixture()
  await expect(f.connection.transaction(async sql => {
    await f.check(sql)
    if (field === 'journal') f.records.entry.phase = 'prepared'
    else f.records.entry_receipts[0]!.source_digest = `sha256:${'4'.repeat(64)}`
  })).rejects.toMatchObject({ code: field === 'journal' ? 'NATIVE_ENTRY_CONFLICT' : 'REPEAT_PUBLICATION_RECEIPT_CONFLICT' })
})

it('rejects an expired lane at commit after the original boundary passed', async () => {
  const f = fixture()
  await expect(f.connection.transaction(async sql => {
    await f.check(sql)
    f.records.lane.held = false
  })).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
})

it('commits an unchanged native boundary with its publication lease held', async () => {
  const f = fixture()
  let transaction: GraphTransactionSql | undefined
  await f.connection.transaction(async sql => {
    transaction = sql
    await f.check(sql)
  })
  expect(didGraphTransactionCommit(transaction!)).toBe(true)
  expect(f.reads).toHaveLength(2)
  expect(f.additional).toHaveBeenCalledTimes(2)
})
