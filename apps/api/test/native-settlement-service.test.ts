import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import type { StoredRepeatExecution } from '../src/modules/runs/repeatPostgres.js'
import type { AcceptedRepeatRunSnapshot } from '../src/modules/runs/repeatStartRead.js'
import * as executions from '../src/modules/runs/repeatExecutionRead.js'
import * as snapshots from '../src/modules/runs/repeatStartRead.js'
import { assertSettlementLocked } from '../src/modules/runs/repeatSettlementServices.js'
import { nativeProofModel } from './eng04-native-proof-model.js'

/** Owner and accepted-snapshot/occurrence readers are explicit MODEL doubles.
 * The service, G1, native settlement and durable closure reader execute. This
 * suite verifies checkpoint retention, not actual SQL receipt/owner provenance. */
function fixture() {
  const f = nativeProofModel(), base = makeCurrentWorkflowFixture('native-proof-service')
  const run = AcceptedWorkflowRunV3Schema.parse({ ...base.run, id: f.execution.runId,
    workspaceId: 'workspace-proof-1', workflowId: 'workflow-proof-1', executionSemanticsVersion: 3,
    executionState: 'running', authorizationPrincipalId: 'principal-proof-model',
    agentConfigurationVersionIds: { [f.execution.agentId]: f.execution.agentConfigurationVersionId },
    executionLocation: { runnerId: 'runner-proof-model', rootPath: '/synthetic/workspace',
      locationRevision: 1, identityHash: `sha256:${'1'.repeat(64)}` } })
  const scope = { runId: run.id, workspaceId: run.workspaceId, workflowId: run.workflowId,
    workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 as const }
  const stored = { execution: structuredClone(f.execution), accepted: false, slotId: 'slot-proof-1',
    ref: { nodeId: f.execution.workflowNodeId, occurrence: { scope, blockId: 'block-proof-1',
      occurrenceId: 'occurrence-proof-1', occurrenceIndex: 1 } },
    input: structuredClone(f.execution.input), inputDigest: `sha256:${'2'.repeat(64)}` } as unknown as StoredRepeatExecution
  const fence = { ownerId: 'owner-proof-model', fence: '1', connectionGeneration: '1' }
  const assertOwned = () => { if (!f.state.owned) throw Object.assign(new Error('model owner lost'), { code: 'RUN_OWNERSHIP_LOST' }) }
  const owner = { runId: run.id,
    assertOwned,
    async readOneShotFence() { assertOwned(); return structuredClone(fence) },
  } as unknown as RunOwnership
  const snapshot = vi.spyOn(snapshots, 'readAcceptedRepeatRunLocked').mockImplementation(async (_sql, id) => {
    assert.equal(id, run.id)
    return { run: structuredClone(run), configurations: [], version: { id: run.workflowVersionId },
      stopRequested: false, cleanupPending: false } as unknown as AcceptedRepeatRunSnapshot
  })
  const reader = vi.spyOn(executions, 'readRepeatExecutionsLocked').mockImplementation(async (_sql, _snapshot, ids) => {
    assert.deepEqual(ids, [f.execution.id])
    return [structuredClone(stored)]
  })
  const settle = () => f.connection.transaction((sql) => assertSettlementLocked(sql, run, [f.execution.id], owner))
  const close = async () => { snapshot.mockRestore(); reader.mockRestore(); await f.connection.close() }
  return { ...f, run, stored, fence, owner, snapshot, reader, settle, close }
}

test('native proof service model: exact slot, input, occurrence and owner are retained through commit', async () => {
  const f = fixture()
  try { await f.settle(); assert.equal(f.state.finalizedWrites, 1) }
  finally { await f.close() }
})

for (const [label, alter, code] of [
  ['owner fence', (f: ReturnType<typeof fixture>) => { f.fence.fence = '2' }, 'RUN_OWNERSHIP_LOST'],
  ['technical attempt', (f: ReturnType<typeof fixture>) => { f.stored.execution.attempt += 1 }, 'REPEAT_NATIVE_IDENTITY_CONFLICT'],
  ['business occurrence', (f: ReturnType<typeof fixture>) => { f.stored.ref.occurrence!.occurrenceId = 'other-occurrence' }, 'REPEAT_NATIVE_IDENTITY_CONFLICT'],
  ['input digest', (f: ReturnType<typeof fixture>) => { f.stored.inputDigest = `sha256:${'3'.repeat(64)}` }, 'REPEAT_NATIVE_IDENTITY_CONFLICT'],
  ['slot', (f: ReturnType<typeof fixture>) => { f.stored.slotId = 'other-slot' }, 'REPEAT_NATIVE_IDENTITY_CONFLICT'],
  ['accepted configuration', (f: ReturnType<typeof fixture>) => { f.run.agentConfigurationVersionIds[f.execution.agentId] = 'other-config' }, 'RUN_PIN_CONFLICT'],
] as const) {
  test(`native proof service model: ${label} replacement after proof rolls back`, async () => {
    const f = fixture()
    try {
      await assert.rejects(f.connection.transaction(async (sql) => {
        await assertSettlementLocked(sql, f.run, [f.execution.id], f.owner)
        alter(f)
      }), { code })
      assert.equal(f.state.finalized, false)
      assert.ok(!f.statements.includes('commit'))
    } finally { await f.close() }
  })
}

test('native proof service model: same-transaction acceptance and Run completion retain immutable proof', async () => {
  const f = fixture()
  try {
    await f.connection.transaction(async (sql) => {
      await assertSettlementLocked(sql, f.run, [f.execution.id], f.owner)
      f.stored.accepted = true
      Object.assign(f.run, { executionState: 'completed', outcome: 'succeeded',
        result: f.execution.result, finishedAt: f.execution.finishedAt })
    })
    assert.equal(f.state.finalizedWrites, 1)
  } finally { await f.close() }
})

test('native proof service model: a failed canonical input reader cannot become settlement authority', async () => {
  const f = fixture()
  try {
    f.reader.mockImplementation(async () => { throw Object.assign(new Error('model missing canonical input receipt'), { code: 'REPEAT_EFFECT_RECEIPT_MISSING' }) })
    await assert.rejects(f.settle(), { code: 'REPEAT_EFFECT_RECEIPT_MISSING' })
    assert.equal(f.state.finalizedWrites, 0)
    assert.ok(!f.statements.includes('commit'))
  } finally { await f.close() }
})

test('native proof service model: empty/duplicate IDs and a cross-Run owner are denied', async () => {
  const f = fixture()
  try {
    for (const ids of [[], [f.execution.id, f.execution.id]]) {
      await assert.rejects(f.connection.transaction((sql) => assertSettlementLocked(sql, f.run, ids, f.owner)),
        { code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    }
    const other = { ...f.owner, runId: 'other-run' } as RunOwnership
    await assert.rejects(f.connection.transaction((sql) => assertSettlementLocked(sql, f.run, [f.execution.id], other)),
      { code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    assert.equal(f.state.finalizedWrites, 0)
  } finally { await f.close() }
})
