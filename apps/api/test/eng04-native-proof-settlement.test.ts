import assert from 'node:assert/strict'
import { test, vi } from 'vitest'
import * as snapshots from '../src/modules/runs/repeatStartRead.js'
import * as executions from '../src/modules/runs/repeatExecutionRead.js'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { settleRepeatNativeExecutionLocked, settleRepeatNativeExecutionWithProofLocked } from '../src/modules/interactions/repeatNativeSettlement.js'

import { nativeProofModel as model } from './eng04-native-proof-model.js'

function noCommit(statements: string[]) {
  assert.ok(!statements.includes('commit'))
  assert.ok(statements.includes('rollback'))
  assert.ok(!statements.some((text) => /^insert\b/i.test(text)), 'settlement cannot mint a source or a receipt')
}

test('native proof model: exact durable close readback and replay finalize once without native/source writes', async () => {
  const f = model()
  try {
    const first = await f.settle(), replay = await f.settle()
    assert.deepEqual(first, replay)
    assert.equal(first[0]!.generation, '41')
    assert.deepEqual(first[0]!.session, f.session)
    assert.equal(f.state.finalizedWrites, 1)
    assert.equal(f.statements.filter((text) => text === 'commit').length, 2)
    assert.ok(!f.statements.some((text) => /^insert\b/i.test(text)))
  } finally { await f.connection.close() }
})

test('native proof model: absent SQL rows plus negative terminal do not prove no submission', async () => {
  const f = model()
  // Only accepted input readers are doubles; the entry reservation authority stays real.
  const snapshot = vi.spyOn(snapshots, 'readAcceptedRepeatRunLocked').mockResolvedValue({
    run: { workspaceId: 'workspace-proof-1', workflowId: 'workflow-proof-1', workflowVersionId: 'version-proof-1' },
  } as never)
  const execution = vi.spyOn(executions, 'readRepeatExecutionLocked').mockResolvedValue({
    ref: { nodeId: f.execution.workflowNodeId, occurrence: null }, inputDigest: `sha256:${'1'.repeat(64)}`,
  } as never)
  try {
    const negative = HarnessExecutionSchema.parse({ ...f.execution, nativeSessionId: undefined,
      workingDirectory: undefined, runtimeDirectory: undefined, startedAt: undefined,
      result: { outcome: 'canceled' } })
    f.state.execution = negative; f.state.hasSession = false; f.state.hasClosure = false; f.state.negativeCleanup = true
    await assert.rejects(f.settle(negative), { code: 'NATIVE_ENTRY_CONFLICT' })
    assert.equal(f.state.finalized, false)
    assert.ok(!f.statements.some((text) => text.includes('possible_submission')))
    noCommit(f.statements)
  } finally { snapshot.mockRestore(); execution.mockRestore(); await f.connection.close() }
})

for (const [label, alter, code] of [
  ['terminal enum without close', (f: ReturnType<typeof model>) => { f.state.hasClosure = false }, 'REPEAT_CLEANUP_PENDING'],
  ['old finalization without current close', (f: ReturnType<typeof model>) => { f.state.finalized = true; f.state.hasClosure = false }, 'REPEAT_CLEANUP_PENDING'],
  ['older unclosed generation', (f: ReturnType<typeof model>) => { f.state.closure.prior_unclosed = true }, 'REPEAT_CLEANUP_PENDING'],
  ['pending credential, budget or reviewer resource', (f: ReturnType<typeof model>) => { f.state.outstanding = true }, 'REPEAT_CLEANUP_PENDING'],
  ['physical node mismatch', (f: ReturnType<typeof model>) => { f.state.rowNodeId = 'other-node' }, 'REPEAT_CLEANUP_PENDING'],
  ['wrong pinned harness', (f: ReturnType<typeof model>) => { f.state.configHarness = 'claude' }, 'REPEAT_NATIVE_IDENTITY_CONFLICT'],
  ['unqualified configuration', (f: ReturnType<typeof model>) => { f.state.configPinned = false }, 'REPEAT_NATIVE_IDENTITY_CONFLICT'],
  ['different close session', (f: ReturnType<typeof model>) => { f.state.closure.closed_reference.nativeSessionId = 'other-session' }, 'NATIVE_WORKFLOW_CLOSURE_CONFLICT'],
  ['different expected provider version', (f: ReturnType<typeof model>) => { f.state.closure.expected_reference!.providerVersion = 'other-provider' }, 'NATIVE_WORKFLOW_CLOSURE_CONFLICT'],
  ['different closed execution attempt', (f: ReturnType<typeof model>) => { f.state.closure.execution_identity.attempt = 2 }, 'NATIVE_WORKFLOW_CLOSURE_CONFLICT'],
  ['changed original input', (f: ReturnType<typeof model>) => { f.state.execution.input = { original: 'different-input' } }, 'REPEAT_NATIVE_IDENTITY_CONFLICT'],
] as const) {
  test(`native proof model: rejects ${label}`, async () => {
    const f = model()
    try { alter(f); await assert.rejects(f.settle(), { code }); noCommit(f.statements) }
    finally { await f.connection.close() }
  })
}

for (const semantics of ['1', '2', '99']) {
  test(`native proof model: v${semantics} cannot enter the v3 settlement arm`, async () => {
    const f = model()
    try { f.state.semantics = semantics; await assert.rejects(f.settle(), { code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' }); noCommit(f.statements) }
    finally { await f.connection.close() }
  })
}

test('native proof model: a new close generation after return fails G1 finalization, even if it is closed', async () => {
  const f = model()
  try {
    await assert.rejects(f.connection.transaction(async (sql) => {
      await settleRepeatNativeExecutionLocked(sql, f.execution.runId, f.execution)
      f.state.closure.generation = '42'
    }), { code: 'REPEAT_NATIVE_IDENTITY_CONFLICT' })
    assert.equal(f.state.finalized, false); noCommit(f.statements)
  } finally { await f.connection.close() }
})

test('native proof model: ownership lost after proof cannot commit its private finalization', async () => {
  const f = model()
  try {
    await assert.rejects(f.connection.transaction(async (sql) => {
      await settleRepeatNativeExecutionLocked(sql, f.execution.runId, f.execution)
      f.state.owned = false
    }), { code: 'RUN_OWNERSHIP_LOST' })
    assert.equal(f.state.finalized, false); noCommit(f.statements)
  } finally { await f.connection.close() }
})

test('native proof model: catching an assertion cannot clear poisoned G1', async () => {
  const f = model()
  try {
    f.state.hasClosure = false
    await assert.rejects(f.connection.transaction(async (sql) => {
      await assert.rejects(settleRepeatNativeExecutionLocked(sql, f.execution.runId, f.execution), { code: 'REPEAT_CLEANUP_PENDING' })
    }), { code: 'GRAPH_TRANSACTION_FAILED' })
    noCommit(f.statements)
  } finally { await f.connection.close() }
})

test('native proof model: caller mutation of returned evidence cannot change the retained checkpoint', async () => {
  const f = model()
  try {
    const incoming = structuredClone(f.execution)
    await f.connection.transaction(async (sql) => {
      const proof = await settleRepeatNativeExecutionWithProofLocked(sql, incoming.runId, incoming)
      incoming.input = { tampered: true }; proof[0]!.generation = '999'
      proof[0]!.session!.nativeSessionId = 'caller-forged-session'
    })
    assert.equal(f.state.finalizedWrites, 1)
    assert.deepEqual(f.state.execution.input, { original: 'input-1' })
  } finally { await f.connection.close() }
})

test('native proof model: nominal SQL objects and leaked transaction tokens cannot settle', async () => {
  const f = model()
  try {
    let queried = false
    const fake = { transaction: true, query: async () => { queried = true; throw new Error('unbranded query') } } as GraphTransactionSql
    await assert.rejects(settleRepeatNativeExecutionLocked(fake, f.execution.runId, f.execution), { code: 'GRAPH_TRANSACTION_CLOSED' })
    assert.equal(queried, false)
    let leaked!: GraphTransactionSql
    await f.connection.transaction(async (sql) => { leaked = sql })
    await assert.rejects(settleRepeatNativeExecutionLocked(leaked, f.execution.runId, f.execution), { code: 'GRAPH_TRANSACTION_CLOSED' })
  } finally { await f.connection.close() }
})
