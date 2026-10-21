import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import type { StoredRepeatExecution } from './repeatPostgres.js'
import type { AcceptedRepeatRunSnapshot } from './repeatStartRead.js'
import { repeatDigest, repeatExecutionIdentity } from './repeatResolution.js'
import type { WorkflowNativeProofRecord } from './workflowNativeProof.js'
import { readWorkflowTerminalReceiptLocked } from './workflowTerminalReceipt.js'

const receipts = vi.hoisted(() => ({ assert: vi.fn(), retain: vi.fn() }))
vi.mock('../run-graph/repeatReceipts.js', () => ({ assertRepeatCanonicalReceiptLocked: receipts.assert,
  requireRepeatCanonicalReceiptBeforeCommit: receipts.retain }))

function fixture() {
  // Original SQL source and receipt ports are unit doubles. They do not create
  // native qualification or physical closure; restart tests exercise the engine.
  const f = makeCurrentWorkflowFixture('terminal-receipt', 'single')
  const run = AcceptedWorkflowRunV3Schema.parse({ ...f.run, authorizationPrincipalId: 'unit-principal',
    executionLocation: { runnerId: 'unit-runner', rootPath: '/workspace', locationRevision: 1,
      identityHash: `sha256:${'0'.repeat(64)}` } })
  const node = f.version.definition.nodes[0]!
  const input = { executionSemanticsVersion: 3 as const, runInput: {}, occurrence: null, entry: null, predecessors: [] }
  const execution = HarnessExecutionSchema.parse({ id: 'execution', runId: f.run.id,
    workflowNodeId: node.id, agentId: node.agentId, agentConfigurationVersionId: f.version.agentConfigurationVersionIds[node.agentId],
    attempt: 1, input, state: 'completed', nativeSessionId: 'session', createdAt: f.createdAt, finishedAt: f.createdAt,
    result: { outcome: 'succeeded', output: { text: JSON.stringify({ routing: { kind: 'finish' },
      data: { latestDeliverable: {}, remainingFindings: [] } }) } } })
  const proof = { proofId: 'proof', scope: f.scope, ref: { nodeId: node.id, occurrence: null },
    execution: repeatExecutionIdentity(execution), session: { harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'session' },
    inputDigest: repeatDigest(input), commandId: 'execution:execution', observedAt: f.createdAt,
    ownerId: 'unit-owner', ownerFence: '1', lifetimeGeneration: 1, closureGeneration: '1',
    lane: { id: 'lane', token: 'token', connectionGeneration: 1, providerId: 'turn' },
    original: { type: 'history', history: { correlationId: 'execution:execution', nativeTurnId: 'turn',
      terminalTurn: { correlationId: 'execution:execution', providerId: 'turn', result: execution.result },
      pendingInteractions: [], events: [{ connectionId: 'connection', sequence: 1, type: 'turn.completed',
        occurredAt: f.createdAt, payload: { threadId: 'session', turnId: 'turn', status: 'completed' } }] } },
  } as WorkflowNativeProofRecord
  const row = { record: proof, source_digest: repeatDigest(proof, 4 * 1024 * 1024) }
  const state = { repairAttempt: 0, rows: [row] }
  const connection = new ExclusiveGraphConnection({ query: async (text: string) => ({
    rows: text.includes('from execution_work_result_repairs') ? [{ attempt: state.repairAttempt }] : state.rows,
    rowCount: state.rows.length,
  }) } as unknown as pg.ClientBase, () => {})
  const snapshot = { run, version: f.version, configurations: f.configurations,
    stopRequested: false, cleanupPending: false } satisfies AcceptedRepeatRunSnapshot
  const stored = { execution, ref: proof.ref, slotId: 'slot', input, inputDigest: proof.inputDigest, accepted: false } satisfies StoredRepeatExecution
  const read = () => connection.transaction((sql) => readWorkflowTerminalReceiptLocked(sql, snapshot, stored))
  return { proof, row, read, state }
}

describe('committed native terminal before business acceptance', () => {
  it.each([1, 2])('recovers the final receipt after %s corrections while retaining rejected native results', async count => {
    const f = fixture()
    const final = structuredClone(f.proof)
    if (final.original.type !== 'history' || f.proof.original.type !== 'history') throw new Error('Expected terminal history')
    const correlationId = `execution:execution:result-repair:${count}`
    const turnId = `corrective-${count}`
    final.proofId = 'corrected-proof'
    final.original.history.correlationId = correlationId
    final.original.history.nativeTurnId = turnId
    final.original.history.terminalTurn = { ...final.original.history.terminalTurn!, correlationId, providerId: turnId }
    final.original.history.events[0]!.payload = { threadId: 'session', turnId, clientCorrelationId: correlationId, status: 'completed' }
    final.lane!.providerId = turnId
    f.proof.original.history.terminalTurn!.result = { outcome: 'succeeded', output: { text: 'rejected original envelope' } }
    f.row.source_digest = repeatDigest(f.proof, 4 * 1024 * 1024)
    f.state.repairAttempt = count
    f.state.rows.push({ record: final, source_digest: repeatDigest(final, 4 * 1024 * 1024) })
    const original = structuredClone(f.row)
    expect(await f.read()).toEqual({ proof: final, sourceDigest: repeatDigest(final, 4 * 1024 * 1024) })
    expect(f.row).toEqual(original)
  })

  it('retains the original receipt on repeat reads before business acceptance', async () => {
    receipts.assert.mockReset()
    receipts.retain.mockReset()
    const f = fixture()
    expect(await f.read()).toEqual({ proof: f.proof, sourceDigest: f.row.source_digest })
    expect(await f.read()).toEqual({ proof: f.proof, sourceDigest: f.row.source_digest })
    expect(receipts.assert).toHaveBeenCalledTimes(2)
    expect(receipts.retain).toHaveBeenCalledTimes(2)
  })
  it.each(['version', 'input', 'frame', 'receipt'] as const)('rejects a changed %s rather than recreating native work', async (change) => {
    receipts.assert.mockReset()
    receipts.retain.mockReset()
    const f = fixture()
    if (change === 'version') f.proof.scope.workflowVersionId = 'another-version'
    if (change === 'input') f.proof.inputDigest = `sha256:${'0'.repeat(64)}`
    if (change === 'frame' && f.proof.original.type === 'history') f.proof.original.history.events = []
    if (change === 'receipt') receipts.assert.mockRejectedValueOnce(new Error('Canonical receipt missing'))
    else f.row.source_digest = repeatDigest(f.proof, 4 * 1024 * 1024)
    await expect(f.read()).rejects.toThrow()
  })
})
