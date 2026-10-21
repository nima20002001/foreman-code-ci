import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, DurableInteractionSchema, NATIVE_INTERACTION_FIXTURES, OperatorConfigurationVersionSchema, type AgentHarness } from '@foreman-code/contracts'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'

import { inTransaction } from '../src/infrastructure/transaction.js'
// Native execution/configuration coverage lives in native-runtime-consolidation.test.ts.
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { ExecutableWorkflowV3Schema, SavedRunVersionSnapshotSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'

import { DeterministicNativeSessionManager } from '../src/testing/deterministicNativeSession.js'

const now = '2026-09-16T00:00:00.000Z'
describe('PR8 current executable approval acceptance', () => {
  it('pins explicit orchestrator authority in both the saved version and Run', () => {
    const fixture = makeCurrentWorkflowFixture('pr8-approval', 'approval')
    const accepted = SavedRunVersionSnapshotSchema.parse({ run: fixture.run, version: fixture.version })
    fixture.version.approval.handler = 'user'
    expect(accepted.run.approval.handler).toBe('orchestrator')
    expect(accepted.version.approval).toEqual(accepted.run.approval)
  })

  it.each(['missing designation', 'wrong workflow', 'wrong role', 'missing reviewer edge'])('rejects %s', (scenario) => {
    const { version, configurations } = makeCurrentWorkflowFixture('pr8-invalid', 'approval')
    if (scenario === 'missing designation') delete version.approval.designatedOrchestratorAgentId
    if (scenario === 'wrong workflow') version.approval.designatedOrchestratorAgentId = 'elsewhere'
    if (scenario === 'wrong role') configurations[0]!.productRole = 'coder'
    if (scenario === 'missing reviewer edge') version.definition.edges = version.definition.edges.filter((edge) => edge.kind !== 'approval')
    expect(ExecutableWorkflowV3Schema.safeParse({ version, configurations }).success).toBe(false)
  })

  it('allows a self-reviewed Codex Coder in an Orchestrator-routed workflow', () => {
    const fixture = makeCurrentWorkflowFixture('pr8-self-reviewed', 'approval')
    const selfReviewed = structuredClone(DEFAULT_HARNESS_DEFAULTS.codex)
    selfReviewed.advanced!.approvalsReviewer = 'auto_review'
    fixture.configurations[1]!.harness = selfReviewed
    expect(ExecutableWorkflowV3Schema.safeParse({ version: fixture.version, configurations: fixture.configurations }).success).toBe(true)
  })

  it('rejects absent and mismatched Run authority instead of inferring it from the workflow', () => {
    const fixture = makeCurrentWorkflowFixture('pr8-authority', 'approval')
    for (const approval of [undefined, { handler: 'user' }]) {
      expect(SavedRunVersionSnapshotSchema.safeParse({ version: fixture.version, run: { ...fixture.run, approval } }).success).toBe(false)
    }
  })

})

describe('PR8 durable schema and transaction boundaries', () => {
  it('rejects undecided deliveries, incomplete decisions and terminal-state contradictions', () => {
    const base = structuredClone(NATIVE_INTERACTION_FIXTURES.codex)
    expect(DurableInteractionSchema.safeParse({ ...base, status: 'delivered', deliveryState: 'delivered', deliveredAt: now }).success).toBe(false)
    expect(DurableInteractionSchema.safeParse({ ...base, status: 'delivery_pending', deliveryState: 'submitted' }).success).toBe(false)
    const decided = { ...base, status: 'delivery_pending', deliveryState: 'pending',
      selectedOptionId: base.responseOptions[0]!.optionId, selectedSemantic: base.responseOptions[0]!.semantic,
      nativeResponse: { decision: 'accept' }, decidedAt: now }
    expect(DurableInteractionSchema.safeParse(decided).success).toBe(true)
    expect(DurableInteractionSchema.safeParse({ ...decided, nativeResponse: undefined }).success).toBe(false)
    expect(DurableInteractionSchema.safeParse({ ...decided, deliveredAt: now }).success).toBe(false)
  })

  it('rejects undefined nativeResponse before acquiring a connection', async () => {
    const connect = vi.fn()
    const repository = new PostgresInteractionRepository({ connect } as unknown as pg.Pool)
    await expect(repository.decide({ id: 'interaction', optionId: 'option', expectedRevision: 0, nativeResponse: undefined })).rejects.toThrow()
    expect(connect).not.toHaveBeenCalled()
  })

  it.each([
    ['owner', '', '2099-01-01T00:00:00.000Z'],
    ['', 'token', '2099-01-01T00:00:00.000Z'],
    ['owner', 'token', 'not-a-time'],
    ['owner', 'token', '2000-01-01T00:00:00.000Z'],
  ])('validates both lease claims before writes (%s, %s, %s)', async (owner, token, expiry) => {
    const connect = vi.fn()
    const repository = new PostgresInteractionCoordinationRepository({ connect } as unknown as pg.Pool)
    await expect(repository.claimReviewJob('job', owner, token, expiry)).rejects.toThrow()
    await expect(repository.claimLane('lane', 0, owner, token, expiry, 'correlation')).rejects.toThrow()
    expect(connect).not.toHaveBeenCalled()
  })

  it('isolates missing-default results from the compiled defaults and later readers', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const repository = new PostgresFoundationSettingsRepository({ query } as unknown as pg.Pool)
    const first = await repository.getAgentDefaults()
    first.value.coder.harness.model = 'mutated'
    expect((await repository.getAgentDefaults()).value).toEqual(DEFAULT_AGENT_DEFAULTS)
    expect((await repository.getAgentDefaults()).revision).toBe(0)
  })

  it('never commits, rolls back or releases the caller transaction', async () => {
    const query = vi.fn(async () => ({ rows: [] }))
    const client = { query } as unknown as pg.ClientBase
    const connect = vi.fn()
    const pool = { connect } as unknown as pg.Pool
    await expect(inTransaction(pool, client, async () => 42)).resolves.toBe(42)
    await expect(inTransaction(pool, client, async () => { throw new Error('receipt failure') })).rejects.toThrow('receipt failure')
    expect(query).not.toHaveBeenCalled()
    expect(connect).not.toHaveBeenCalled()
  })
})

function operatorStart(harness: AgentHarness) {
  return {
    kind: 'operator' as const, correlationId: 'conversation', workingDirectory: '/tmp/operator',
    configuration: OperatorConfigurationVersionSchema.parse({
      id: 'operator-config', operatorId: 'operator', version: 1,
      harness: DEFAULT_HARNESS_DEFAULTS[harness], contentHash: 'sha256:fixture', createdAt: now,
    }),
  }
}
async function drain(source: AsyncIterable<unknown>) { for await (const event of source) void event }

describe.each(['codex'] as const)('PR8 %s native fixture isolation', (harness) => {
  it('keeps identities, pending work, responses, cancellation and history scoped', async () => {
    const manager = new DeterministicNativeSessionManager(harness)
    const a = await manager.createSession(operatorStart(harness))
    const b = await manager.createSession(operatorStart(harness))
    expect(a.nativeSessionId).not.toBe(b.nativeSessionId)
    await drain(manager.startTurn(a, { prompt: 'A', clientCorrelationId: 'turn-a' }))
    await drain(manager.startTurn(b, { prompt: 'B', clientCorrelationId: 'turn-b' }))
    const pendingA = (await manager.pending(a))!
    const pendingB = (await manager.pending(b))!
    expect(pendingA.turn.nativeRequestId).not.toBe(pendingB.turn.nativeRequestId)
    await expect(manager.respond(a, pendingB.turn.nativeRequestId!, pendingB.responseOptions[0]!)).rejects.toThrow()
    await manager.cancel(a)
    expect(await manager.pending(a)).toBeUndefined()
    expect(await manager.pending(b)).toEqual(pendingB)
    expect((await manager.reconcile(b, 'turn-a')).events).toEqual([])
    expect((await manager.history(b)).events).toHaveLength(1)
    await manager.respond(b, pendingB.turn.nativeRequestId!, pendingB.responseOptions[0]!)
    await drain(manager.startTurn(b, { prompt: 'Next', clientCorrelationId: 'turn-c' }))
    expect((await manager.pending(b))!.turn.nativeTurnId).not.toBe(pendingB.turn.nativeTurnId)
    expect((await manager.pending(b))!.turn.nativeRequestId).not.toBe(pendingB.turn.nativeRequestId)
    expect((await manager.reconcile(b, 'turn-b')).pendingInteractions).toEqual([])
    expect((await manager.reconcile(b, 'turn-c')).pendingInteractions).toHaveLength(1)
    const effects = manager.counters.sideEffects
    await drain(manager.startTurn(b, { prompt: 'Next', clientCorrelationId: 'turn-c' }))
    expect(manager.counters.sideEffects).toBe(effects)
    const copy = (await manager.pending(b))!
    copy.responseOptions.length = 0
    expect((await manager.pending(b))!.responseOptions.length).toBeGreaterThan(0)
    await manager.attachSession(b, operatorStart(harness))
    expect((await manager.history(b)).events).toHaveLength(3)
  })
})
