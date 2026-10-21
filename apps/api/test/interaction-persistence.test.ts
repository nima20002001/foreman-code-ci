import assert from 'node:assert/strict'

import { DurableInteractionSchema, type DurableInteraction, type HarnessNativeEvent } from '@foreman-code/contracts'
import type pg from 'pg'
import { it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import type { NativeDeliveryOutcome, NativeResponseDeliveryEvidence } from '../src/modules/interactions/delivery.js'
import { Wave25InteractionRepository } from '../src/modules/interactions/wave25/repository.js'
import { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { nativeLanes } from './helpers/nativeLanes.js'

import { PostgresInteractionRepository } from '../src/modules/interactions/postgres.js'
import { InteractionService } from '../src/modules/interactions/service.js'
import type { PostgresApprovalBudgetRepository } from '../src/modules/interactions/budget.js'
import type { InteractionNativeRuntime } from '../src/modules/interactions/runtimePorts.js'
import { assertDeliveryLease, type LockedInteraction } from '../src/modules/interactions/persistence.js'
import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'

function interaction(): DurableInteraction {
  return DurableInteractionSchema.parse({
    id: 'interaction-1', revision: 0, workspaceId: 'workspace-1', workflowId: 'workflow-1',
    runId: 'run-1', executionId: 'execution-1', requestingAgentId: 'agent-1',
    harness: 'codex', providerVersion: '0.154.0', nativeSessionId: 'native-session-1',
    nativeRequestId: 'native-request-1', nativeRequestType: 'approval', graphThreadId: 'run-1',
    graphInterruptId: 'interrupt-1', request: { command: ['echo', 'test'] }, approval: { handler: 'user' },
    responseOptions: [{ optionId: 'opaque-option-1', semantic: 'approve_once', label: 'Approve once',
      persistence: 'request', affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    status: 'pending', deliveryState: 'not_started', createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z',
  })
}

const response = { interactionId: 'interaction-1', optionId: 'opaque-option-1', expectedRevision: 0 }

/** Models transaction rollback, not PostgreSQL locking; concurrency is covered by the integration suite. */
class DecisionStore {
  record: DurableInteraction | undefined = interaction()
  receipts = new Map<string, { interaction_id: string; option_id: string }>()
  queries: string[] = []
  updates = 0
  released = 0
  failUpdate = false
  private snapshot: { record: DurableInteraction | undefined; receipts: Map<string, { interaction_id: string; option_id: string }> } | undefined

  readonly pool = {
    connect: async () => ({ query: this.query.bind(this), release: () => { this.released += 1 } }),
    query: this.query.bind(this),
  } as unknown as pg.Pool

  async query(sql: string, values: unknown[] = []) {
    this.queries.push(sql)
    const result = (rows: unknown[] = [], rowCount = rows.length) => ({ rows, rowCount })
    if (sql === 'begin') { this.snapshot = structuredClone({ record: this.record, receipts: this.receipts }); return result() }
    if (sql === 'rollback') {
      assert.ok(this.snapshot)
      this.record = this.snapshot.record; this.receipts = this.snapshot.receipts
      return result()
    }
    if (sql === 'commit') return result()
    if (sql.startsWith('select record')) return result(this.record ? [{ record: this.record, delivery_fence: '0', delivery_owner: null, delivery_token: null, lease_active: false }] : [])
    if (sql.startsWith('insert into interaction_command_receipts')) {
      const key = `${values[0]}:${values[1]}`
      if (this.receipts.has(key)) return result([], 0)
      this.receipts.set(key, { interaction_id: String(values[2]), option_id: String(values[3]) })
      return result([], 1)
    }
    if (sql.startsWith('select interaction_id,option_id')) {
      const receipt = this.receipts.get(`${values[0]}:${values[1]}`)
      return result(receipt ? [receipt] : [])
    }
    if (sql.startsWith('update interaction_command_receipts')) return result([], 1)
    if (sql.startsWith('update durable_interactions set status=')) {
      if (this.failUpdate) throw new Error('database write failed')
      this.record = JSON.parse(String(values[3])) as DurableInteraction
      this.updates += 1
      return result([], 1)
    }
    throw new Error(`Unexpected SQL: ${sql}`)
  }
}

function decide(store: DecisionStore, overrides: Partial<Parameters<PostgresInteractionRepository['decide']>[0]> = {}) {
  return new PostgresInteractionRepository(store.pool).decide({
    id: response.interactionId, optionId: response.optionId, expectedRevision: 0,
    nativeResponse: { optionId: response.optionId }, ...overrides,
  })
}

it('never allows an unfenced, expired, or superseded worker to write a claimed delivery', () => {
  const lease = { owner: 'worker-1', token: 'token-1', fence: 1, expiresAt: '2099-01-01T00:00:00.000Z' }
  const row: LockedInteraction = { interaction: interaction(), fence: 1, owner: lease.owner, token: lease.token, leaseActive: true }
  assertDeliveryLease(row, lease)
  assert.throws(() => assertDeliveryLease(row), { code: 'DELIVERY_LEASE_LOST' })
  assert.throws(() => assertDeliveryLease(row, { ...lease, fence: 0 }), { code: 'DELIVERY_LEASE_LOST' })
  assert.throws(() => assertDeliveryLease({ ...row, leaseActive: false }, lease), { code: 'DELIVERY_LEASE_LOST' })
  assert.throws(() => assertDeliveryLease({ ...row, owner: null, token: null, leaseActive: false }), { code: 'DELIVERY_LEASE_LOST' })
})

it('does not reopen a delivered, failed, or canceled native response', async () => {
  for (const state of ['delivered', 'failed', 'canceled'] as const) {
    const store = new DecisionStore()
    await decide(store)
    store.record = { ...store.record!, deliveryState: state === 'canceled' ? 'submitted' : state,
      status: state === 'failed' ? 'delivery_failed' : state }
    await assert.rejects(new PostgresInteractionRepository(store.pool).updateDelivery(store.record.id, store.record.revision, 'submitted'))
    assert.equal(store.updates, 1)
  }
})

it('stores native event envelopes and their activity references atomically, with exact replay only', async () => {
  const events = new Map<string, unknown>()
  let activityCount = 0
  const db = { query: async (sql: string, values: unknown[]) => {
    assert.match(sql, /append_harness_native_event\(\$1::jsonb\)/)
    assert.match(sql, /rejected_source/)
    const record = JSON.parse(String(values[0])) as HarnessNativeEvent
    const identity = `${record.executionId}:${record.connectionId ?? 'legacy'}:${record.sequence}`
    const existing = events.get(identity)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(record)) throw Object.assign(new Error('identity conflict'), { code: 'PNE01' })
      return { rows: [{ inserted: false, previously_rejected: false }], rowCount: 1 }
    }
    events.set(identity, record); activityCount += 1
    return { rows: [{ inserted: true, previously_rejected: false }], rowCount: 1 }
  } } as unknown as pg.ClientBase
  const event: HarnessNativeEvent = { executionId: 'execution-1', sequence: 7, type: 'native.approval', occurredAt: '2026-09-16T00:00:00.000Z', payload: { requestId: 'exact-native-request', nested: { value: true } } }
  await appendNativeEvent(db, event)
  await appendNativeEvent(db, event)
  assert.equal(activityCount, 1)
  assert.deepEqual(events.get('execution-1:legacy:7'), event)
  await assert.rejects(appendNativeEvent(db, { ...event, payload: { requestId: 'another-request' } }), { code: 'NATIVE_EVENT_IDENTITY_CONFLICT' })
  assert.deepEqual(events.get('execution-1:legacy:7'), event)
})

const principal: ManagementPrincipal = { id: 'unit-user', name: 'Unit User', audience: 'user',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['interactions:respond'], scope: { workspaceIds: ['workspace-1'] } }] }

/** Current service + actual native control queue, with explicit repository and
 * provider-history ports. This is not a database or a real native receipt test. */
function deliveryService(attachError?: Error, graphError?: Error) {
  let current = interaction()
  const outcomes: NativeDeliveryOutcome[] = []
  const graphErrors: Array<string | undefined> = []
  const noSql = () => { throw new Error('Unscripted SQL in persistence service unit fixture') }
  const repository = new Wave25InteractionRepository({ query: noSql, connect: noSql } as unknown as pg.Pool)
  Object.assign(repository, {
    get: async () => structuredClone(current),
    decide: async (input: Parameters<Wave25InteractionRepository['decide']>[0]) => {
      assert.equal(input.principal, principal); assert.equal(input.id, current.id)
      assert.equal(input.expectedRevision, current.revision)
      assert.deepEqual(input.nativeResponse, { optionId: response.optionId, semantic: 'approve_once' })
      current = DurableInteractionSchema.parse({ ...current, revision: 1, status: 'delivery_pending',
        deliveryState: 'pending', selectedOptionId: response.optionId, selectedSemantic: 'approve_once',
        nativeResponse: input.nativeResponse, decidedAt: current.createdAt })
      return { interaction: structuredClone(current), replayed: false }
    },
  })
  Object.assign(repository.delivery, {
    claim: async () => ({ interaction: structuredClone(current), attempt: 1,
      ownerToken: 'owner', correlationId: 'delivery', mode: 'submit' as const }),
    finish: async (_claim: unknown, input: NativeDeliveryOutcome |
      ((item: DurableInteraction, signal: AbortSignal) => Promise<NativeDeliveryOutcome>)) => {
      const outcome = typeof input === 'function' ? await input(current, new AbortController().signal) : input
      outcomes.push(outcome)
      current = DurableInteractionSchema.parse({ ...current, deliveryState: outcome.state,
        status: outcome.state === 'delivered' ? 'delivered' : outcome.state === 'failed' ? 'delivery_failed' : 'delivery_pending',
        ...(outcome.state === 'delivered' ? { deliveredAt: current.createdAt } : {}) })
      return structuredClone(current)
    },
    assertNativeDispatch: async () => ({ interaction: structuredClone(current), expiresAt: new Date(Date.now() + 30_000) }),
    claimAtomicGraphResume: async () => ({ interaction: structuredClone(current), ownerToken: 'graph-owner' }),
    finishGraphResume: async (_claim: unknown, error?: string) => { graphErrors.push(error) },
  })
  const proof: NativeResponseDeliveryEvidence = { source: 'provider_history', harness: current.harness,
    providerVersion: current.providerVersion, nativeSessionId: current.nativeSessionId,
    nativeRequestId: current.nativeRequestId, nativeRequestType: current.nativeRequestType,
    optionId: response.optionId, semantic: 'approve_once' }
  // The receipt is independently supplied test data; a void send is not proof.
  const history = { events: [], pendingInteractions: [], responseDeliveries: [proof] }
  const manager = new SingleWriterSessionManager({ harness: current.harness,
    respond: async () => undefined, history: async () => history, reconcile: async () => history,
  } as unknown as NativeHarnessSessionManager, nativeLanes(), current.requestingAgentId)
  const budgets = { assertActive: async () => { throw new Error('Retired service budget path') },
    resume: async () => { throw new Error('Delivery is not checkpoint consumption') } } as unknown as PostgresApprovalBudgetRepository
  const runtime: InteractionNativeRuntime = {
    withInteractionOwner: (_interaction, signal, work) => work(signal),
    validateInteraction: async () => undefined,
    attachOwnedSession: async () => {
      throw new Error('Unexpected owned-session attach')
    },
    attachInteraction: async () => {
      if (attachError) throw attachError
      return { manager, session: { harness: current.harness, providerVersion: current.providerVersion,
        nativeSessionId: current.nativeSessionId } }
    },
  }
  const service = new InteractionService(repository, budgets, runtime, async () => {
    throw new Error('The retired graph callback must not be called')
  })
  service.useAtomicApprovalResume(async (claim) => {
    assert.equal(claim.ownerToken, 'graph-owner'); assert.equal(claim.interaction.graphThreadId, current.runId)
    throw graphError ?? new Error('No successful checkpoint implementation in this fixture')
  })
  return { service, outcomes, graphErrors, proof }
}

it('persists a safe attachment failure code rather than an unexplained flag or private native error', async () => {
  const { service, outcomes, graphErrors } = deliveryService(new Error('native session /private/runtime is unavailable'))
  await service.respond({ kind: 'user', principal }, response)
  assert.deepEqual(outcomes, [{ state: 'failed', error: 'APPROVAL_NATIVE_QUALIFICATION_FAILED' }])
  assert.ok(!JSON.stringify(outcomes).includes('/private/runtime'))
  assert.deepEqual(graphErrors, [])
})

it('does not relabel proven native delivery as failed when atomic checkpoint consumption throws', async () => {
  const { service, outcomes, graphErrors, proof } = deliveryService(undefined, new Error('checkpoint unavailable'))
  const result = await service.respond({ kind: 'user', principal }, response)
  assert.equal(result.interaction.deliveryState, 'delivered')
  assert.deepEqual(outcomes, [{ state: 'delivered', evidence: proof }])
  assert.deepEqual(graphErrors, ['GRAPH_RESUME_CHECKPOINT_UNCERTAIN'])
})
