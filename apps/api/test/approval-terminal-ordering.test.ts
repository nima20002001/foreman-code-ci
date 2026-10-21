import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HarnessExecutionRequestSchema } from '@foreman-code/contracts'
import type { CanonicalRunGraphScope } from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import * as publication from '../src/modules/run-graph/publication.js'
import type { GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import { assertRepeatCanonicalReceiptLocked, type RepeatCanonicalReceipt } from '../src/modules/run-graph/repeatReceipts.js'
import { repeatExecutionDriver } from '../src/modules/runs/repeatRuntime.js'
import { currentApprovalSettlementUnit } from './helpers/currentApprovalSettlementUnit.js'
import { native2Fixture } from './eng04-native2-fixtures.js'

const { graphSourceDigest } = publication

// Only the read-only publication lookup is a port. It cannot return a successful
// proof by itself: every lookup executes the real canonical SQL receipt verifier.
// Original pending/continuation sources and the ACK descriptor are all checked
// by the actual nativeApprovalProof implementation, not mocked away.
// Install the lookup after the publication/proof-reader module cycle has
// evaluated, rather than importing the actual module inside a hoisted partial
// factory. This keeps every consumer on the same spied lookup.
beforeEach(() => {
  vi.spyOn(publication, 'currentRunGraphPublication').mockImplementation(((sql: GraphTransactionSql, scope: CanonicalRunGraphScope) => ({
    sql, scope,
    assertSourceEnlisted: (evidence: RepeatCanonicalReceipt['evidence'], sourceDigest: string, semanticDigest: string) =>
      assertRepeatCanonicalReceiptLocked(sql, { scope, evidence, sourceDigest, semanticDigest, effect: null }),
  })) as typeof publication.currentRunGraphPublication)
})
const connections: Array<{ close(): Promise<void> }> = []
function gateFixture() { const f = currentApprovalSettlementUnit(); connections.push(f.model.connection); return f }
afterEach(async () => { await Promise.all(connections.splice(0).map((connection) => connection.close())); vi.restoreAllMocks() })
const pending = () => new DomainError('APPROVAL_SETTLEMENT_PENDING', 'Exact settlement is pending.', 409)

describe('NIM-2644 current native terminal / approval settlement ordering', () => {
  it.each(['submitted', 'uncertain'] as const)('does not recover a terminal execution through %s delivery', async (deliveryState) => {
    const f = gateFixture(), native = native2Fixture()
    native.closed(); native.revoked()
    f.state.records = [{ ...f.interaction, status: 'delivery_pending', deliveryState, deliveredAt: undefined }]
    // Current terminal re-entry delegates to the exact SQL settlement gate. There
    // is no removed recoverTerminalInteraction escape hatch or new native turn.
    native.store.settleNativeExecution = async () => { await f.check() }
    const before = structuredClone(native.get())
    await expect(native.observe()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    expect(native.get()).toEqual(before)
    expect(native.calls.some((call) => /resolve|attachSession|createSession|startTurn|respond|terminal:/.test(call))).toBe(false)
  })
  it.each(['not_started', 'submitted', 'uncertain', 'failed'] as const)('rejects %s even with terminal-looking resume rows', async (deliveryState) => {
    const f = gateFixture()
    f.state.records = [{ ...f.interaction, status: deliveryState === 'not_started' ? 'decided' : deliveryState === 'failed' ? 'delivery_failed' : 'delivery_pending', deliveryState, deliveredAt: undefined }]
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
  })
  it.each(['pending', 'resuming', 'blocked', 'canceled'])('rejects delivered approval with %s outbox', async (state) => {
    const f = gateFixture(); f.state.resume.state = state
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
  })
  it('does not mistake a committed checkpoint for Worker acknowledgement', async () => {
    const f = gateFixture(); f.state.resume.approval_native_ack_id = null
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
  })
  it('does not accept an acknowledgement without the exact checkpoint receipt', async () => {
    const f = gateFixture(); f.state.receipt = undefined
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
  })
  it('rejects a contradictory receipt rather than rewriting it', async () => {
    const f = gateFixture(); f.state.receipt = graphSourceDigest({ otherDecision: true })
    const before = f.state.receipt
    // The original-source verifier now reads this receipt before the outer gate.
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    expect(f.state.receipt).toBe(before)
  })
  it('does not hide a canceled delivered obligation during normal completion', async () => {
    const f = gateFixture(); f.state.records = [{ ...f.interaction, status: 'canceled' }]
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
  })
  it('accepts exact settled replay without writing or dispatching anything', async () => {
    const f = gateFixture()
    const before = { ...f.model.state, receipts: structuredClone(f.model.state.receipts) }
    await expect(f.check()).resolves.toBeUndefined()
    await expect(f.check()).resolves.toBeUndefined()
    expect(publication.currentRunGraphPublication).toHaveBeenCalled()
    expect(f.model.state).toEqual(before)
  })
  it('checks every selected sibling rather than just the first receipt', async () => {
    const f = gateFixture()
    f.state.records.push({ ...f.interaction, id: 'unsettled-sibling', deliveryState: 'uncertain', status: 'delivery_pending', deliveredAt: undefined })
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    expect(f.state.records[1]).toMatchObject({ id: 'unsettled-sibling', deliveryState: 'uncertain' })
  })
  it('cannot accept a foreign graph thread', async () => {
    const f = gateFixture(); f.state.records = [{ ...f.interaction, graphThreadId: 'other-run' }]
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_IDENTITY_MISMATCH' })
  })
  it.each(['pending', 'continuation'] as const)('requires the immutable original %s source, not only ACK metadata', async (kind) => {
    const f = gateFixture()
    f.state.proofs.delete(kind === 'pending' ? 'unit-pending-source' : 'unit-continuation-source')
    await expect(f.check()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    expect(f.state.proofs.has(kind === 'pending' ? 'unit-pending-source' : 'unit-continuation-source')).toBe(false)
  })
})

function coordinatorFixture() {
  const f = native2Fixture(false)
  f.set({ ...f.get(), state: 'waiting' })
  f.installResident()
  f.internals.resolveManager = () => ({ manager: f.manager, processState: 'resident' })
  f.internals.prepareEnvironment = async () => undefined
  const update = vi.fn(async () => { throw pending() })
  f.runs.updateExecution = update
  const pause = vi.spyOn(f.budgets, 'beginWait')
  const request = HarnessExecutionRequestSchema.parse({ executionId: f.get().id, runId: f.run.id,
    workspaceId: f.run.workspaceId, workflowNodeId: f.get().workflowNodeId,
    workingDirectory: f.get().workingDirectory, runtimeDirectory: f.get().runtimeDirectory,
    configuration: f.configuration, input: f.get().input })
  const observe = () => f.coordinator.observeExact({ execution: f.get(), request, approval: f.run.approval,
    store: f.store, owner: f.owner as never, workflowId: f.run.workflowId, graphThreadId: f.run.id,
    signal: new AbortController().signal })
  return { ...f, observe, update, pause }
}
describe('NIM-2644 pending receipt is not native failure cleanup', () => {
  it('retains requester, budget wait and credential lifetime after terminal publication is refused', async () => {
    const f = coordinatorFixture()
    await expect(f.observe()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    expect(f.get().state).toBe('waiting'); expect(f.update).toHaveBeenCalledTimes(1)
    expect(f.pause).toHaveBeenCalledWith(f.get().id)
    expect(f.calls.some((call) => /close:|cancel|revoke|unqualified-finalize|budget:/.test(call))).toBe(false)
    expect(f.coordinator.residentRunIds()).toContain(f.run.id)
  })
  it('keeps a failed budget-pause write recoverable instead of canceling the approval', async () => {
    const f = coordinatorFixture(); f.pause.mockRejectedValueOnce(new Error('Synthetic budget persistence gap'))
    await expect(f.observe()).rejects.toMatchObject({ code: 'APPROVAL_SETTLEMENT_PENDING' })
    expect(f.get().state).toBe('waiting')
    expect(f.calls.some((call) => /close:|cancel|revoke|unqualified-finalize|budget:/.test(call))).toBe(false)
    expect(f.coordinator.residentRunIds()).toContain(f.run.id)
  })
  it.each([false, true])('current driver preserves receipt gap; explicit Stop=%s stays distinct', async (stop) => {
    const f = native2Fixture(false), controller = new AbortController(), before = structuredClone(f.get())
    const observeExact = vi.fn(async () => {
      if (stop) controller.abort(new DomainError('GRAPH_STOP_CONFLICT', 'Committed Stop fixture', 409))
      throw pending()
    })
    const driver = repeatExecutionDriver({ scope: f.fixture.scope, version: f.fixture.version, owner: f.owner,
      store: f.store, observeExact, abandonAttempt: async () => { throw new Error('Unexpected start failure') } })
    await expect(driver.observe(f.get(), controller.signal)).rejects.toMatchObject({ code: stop ? 'GRAPH_STOP_CONFLICT' : 'APPROVAL_SETTLEMENT_PENDING' })
    expect(observeExact).toHaveBeenCalledTimes(1)
    expect(f.get()).toEqual(before)
    expect(f.calls.some((call) => /terminal:|cancel|revoke|close:/.test(call))).toBe(false)
  })
})
