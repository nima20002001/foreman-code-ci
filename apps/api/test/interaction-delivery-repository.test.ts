import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import type { DurableInteraction } from '@foreman-code/contracts'
import type pg from 'pg'
import { it } from 'vitest'

import { DomainError } from '../src/modules/errors.js'
import type { InteractionDeliveryClaim } from '../src/modules/interactions/delivery.js'
import { PostgresInteractionDeliveryRepository } from '../src/modules/interactions/deliveryPostgres.js'

/** Scripted-client tests cover fencing/order/failure handling, not PostgreSQL isolation. */
function setup() {
  const interaction: DurableInteraction = {
    id: 'interaction-proof', revision: 2, workspaceId: 'workspace-fixture', workflowId: 'workflow-fixture',
    runId: 'run-fixture', executionId: 'execution-fixture', requestingAgentId: 'agent-coder', harness: 'codex',
    providerVersion: '0.154.0', nativeSessionId: 'native-session', nativeRequestId: 'native-request',
    nativeRequestType: 'item/commandExecution/requestApproval', graphThreadId: 'run-fixture', graphInterruptId: 'bound-interrupt',
    request: {}, approval: { handler: 'user' }, responseOptions: [{ optionId: 'opaque-option', semantic: 'approve_once',
      label: 'Approve once', persistence: 'request', affectsOtherPendingRequests: false,
      interruptsCurrentTurn: false, mutatesPersistentPolicy: false }],
    selectedOptionId: 'opaque-option', selectedSemantic: 'approve_once', nativeResponse: { optionId: 'opaque-option', semantic: 'approve_once' },
    status: 'delivery_pending', deliveryState: 'submitted',
    createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z', decidedAt: '2026-09-16T00:00:00.000Z',
  }
  const claim: InteractionDeliveryClaim = { interaction, attempt: 1, ownerToken: 'owner-one', correlationId: 'original-correlation', mode: 'submit' }
  const client = new EventEmitter()
  const calls: string[] = []
  const control = { stopped: false, exhausted: false, leased: true, owned: true, outboxFailure: false, destroyed: false }
  const pool = {
    connect: async () => Object.assign(client, {
      query: async (query: string) => {
        const sql = query.replace(/\s+/g, ' ').trim()
        calls.push(sql)
        if (sql.startsWith('select stopped_at')) return { rows: [{ stopped_at: control.stopped ? new Date() : null, exhausted: control.exhausted }] }
        if (sql.startsWith('select record from durable_interactions')) return { rows: [{ record: structuredClone(interaction) }] }
        if (sql.startsWith('select delivery_token')) return { rows: [{ delivery_token: control.owned ? claim.ownerToken : null }] }
        if (sql.startsWith('select attempt,state')) return { rows: control.owned ? [{ attempt: 1, state: 'submitted', correlation_id: 'original-correlation', lease_owner: 'owner-one', leased: control.leased }] : [] }
        if (sql.startsWith('insert into interaction_graph_resumes') && control.outboxFailure) throw new Error('outbox insert failed')
        return { rows: [], rowCount: 1 }
      },
      release: (destroy?: boolean) => { control.destroyed = destroy === true },
    }),
  } as unknown as pg.Pool
  return { repository: new PostgresInteractionDeliveryRepository(pool), claim, calls, control, client }
}

it('locks the Stop row before the interaction and native write, then commits attempt + interaction + intent (#7/#12)', async () => {
  const h = setup()
  const delivered = await h.repository.finish(h.claim, async () => {
    h.calls.push('NATIVE_WRITE')
    return { state: 'delivered' }
  })
  const index = (prefix: string) => h.calls.findIndex((call) => call.startsWith(prefix))
  assert.ok(index('select stopped_at') < index('select record from durable_interactions'))
  assert.ok(index('select attempt,state') < index('NATIVE_WRITE'))
  assert.ok(index('NATIVE_WRITE') < index('update interaction_delivery_attempts'))
  assert.ok(index('update interaction_delivery_attempts') < index('update durable_interactions'))
  assert.ok(index('update durable_interactions') < index('insert into interaction_graph_resumes'))
  assert.ok(index('insert into interaction_graph_resumes') < index('commit'))
  assert.equal(delivered.graphInterruptId, 'bound-interrupt')
  assert.equal(delivered.deliveryState, 'delivered')
})

it('does not call native code after Stop or active-time exhaustion (#12)', async () => {
  for (const reason of ['stopped', 'exhausted'] as const) {
    const h = setup()
    h.control[reason] = true
    let sends = 0
    await assert.rejects(h.repository.finish(h.claim, async () => { sends++; return { state: 'delivered' } }))
    assert.equal(sends, 0)
    assert.equal(h.calls.at(-1), 'rollback')
  }
})

it('does not let an expired/replaced owner make a native write (#11)', async () => {
  for (const reason of ['leased', 'owned'] as const) {
    const h = setup()
    h.control[reason] = false
    let sends = 0
    await assert.rejects(h.repository.finish(h.claim, async () => { sends++; return { state: 'delivered' } }),
      (error: unknown) => error instanceof DomainError && error.code === 'DELIVERY_OWNER_LOST')
    assert.equal(sends, 0)
  }
})

it('does not allow another claim while a durable delivery lease is live (#11)', async () => {
  const h = setup()
  assert.equal(await h.repository.claim(h.claim.interaction.id, 'other-owner'), undefined)
  assert.equal(h.calls.some((call) => call.startsWith('update ')), false)
})

it('requires evidence before reconciliation can write delivered state (#10)', async () => {
  const h = setup()
  await assert.rejects(h.repository.finish({ ...h.claim, mode: 'reconcile' }, { state: 'delivered' }),
    (error: unknown) => error instanceof DomainError && error.code === 'DELIVERY_EVIDENCE_REQUIRED')
  assert.equal(h.calls.some((call) => call.startsWith('update ')), false)
  assert.equal(h.calls.at(-1), 'rollback')
})

it('rolls back an outbox failure without reclassifying it as a failed native send (#7)', async () => {
  const h = setup()
  h.control.outboxFailure = true
  let sends = 0
  await assert.rejects(h.repository.finish(h.claim, async () => { sends++; return { state: 'delivered' } }), /outbox insert failed/)
  assert.equal(sends, 1)
  assert.equal(h.calls.includes('commit'), false)
  assert.equal(h.calls.at(-1), 'rollback')
})

it('aborts the provider callback when the database owner disconnects (#11/#12)', async () => {
  const h = setup()
  await assert.rejects(h.repository.finish(h.claim, async (_interaction, signal) => {
    assert.equal(signal.aborted, false)
    h.client.emit('error', new Error('connection lost'))
    assert.equal(signal.aborted, true)
    signal.throwIfAborted()
    return { state: 'delivered' }
  }), (error: unknown) => error instanceof DomainError && error.code === 'DELIVERY_OWNER_LOST')
  assert.equal(h.control.destroyed, true)
  assert.equal(h.calls.includes('commit'), false)
})


it('cannot classify an uncertain reconciliation as failed to authorize another send (#10/#11)', async () => {
  const h = setup()
  await assert.rejects(h.repository.finish({ ...h.claim, mode: 'reconcile' }, { state: 'failed' }),
    (error: unknown) => error instanceof DomainError && error.code === 'DELIVERY_OUTCOME_UNCERTAIN')
  assert.equal(h.calls.some((call) => call.startsWith('update ')), false)
})
