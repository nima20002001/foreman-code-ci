import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { RunOwnership } from '../src/modules/runs/ownership.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { agent3Database, postgresEnabled } from './helpers/wave25Agent3.js'
import type { DurableInteraction } from '@foreman-code/contracts'
import { rejectableDeferred } from './helpers/deferred.js'

const closes: Array<() => Promise<void>> = []
let database: Awaited<ReturnType<typeof agent3Database>>
afterEach(async () => {
  try { while (closes.length) await closes.pop()!() } finally { vi.restoreAllMocks() }
}, 60_000)
async function fixture() {
  const f = await checkpointRuntimeFixture(1, 1, { database })
  closes.push(f.close)
  await f.engine.start(f.f.run.id)
  const [interaction] = await f.pending()
  if (!interaction) throw new Error('Expected original native request and persisted checkpoint')
  const crash = vi.spyOn(f.engine, 'resumeInteraction').mockRejectedValue(new Error('crash-after-delivery'))
  let delivered: DurableInteraction
  try {
    delivered = (await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(interaction))).interaction
    expect(delivered.deliveryState).toBe('delivered')
  } finally { crash.mockRestore() }
  expect(await f.receipts()).toEqual([])
  return { ...f, delivered }
}
async function expireAbandonedClaims(f: Awaited<ReturnType<typeof fixture>>) {
  await f.db.pool.query(`update interaction_graph_resumes set lease_expires_at=clock_timestamp()-interval '1 microsecond'
    where run_id=$1 and state='resuming'`, [f.f.run.id])
}

describe.skipIf(!postgresEnabled)('BR1-003: actual current checkpoint and Run-owner receipt transaction', () => {
  beforeAll(async () => { database = await agent3Database() }, 60_000)
  afterAll(async () => { await database?.close() }, 60_000)

  it('rolls back task-local writes and graph.resume together before commit', async () => {
    const f = await fixture(), before = await f.writes()
    let wrote = false
    const consume = f.saver.consumeApprovalInterrupt.bind(f.saver)
    const failure = vi.spyOn(f.saver, 'consumeApprovalInterrupt').mockImplementation(async (sql, interaction) => {
      await consume(sql, interaction)
      wrote = true
      throw new Error('injected-before-checkpoint-receipt-commit')
    })
    await expect(f.engine.resume(f.f.run.id)).rejects.toBeDefined()
    expect(wrote).toBe(true)
    expect(await f.writes()).toEqual(before)
    expect(await f.receipts()).toEqual([])
    expect(f.provider.counts.responses).toBe(1)
    failure.mockRestore()
    await expireAbandonedClaims(f)
    await f.engine.resume(f.f.run.id)
    expect(await f.receipts()).toHaveLength(1)
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
  }, 60000)

  it('recovers commit-before-ack without repeating a native response or resume receipt', async () => {
    const f = await fixture()
    let crashed = false
    const getTuple = f.saver.getTuple.bind(f.saver)
    const failure = vi.spyOn(f.saver, 'getTuple').mockImplementation(async (config) => {
      if (!crashed && (await f.receipts()).length) {
        crashed = true; throw new Error('crash-after-commit-before-dispatch')
      }
      return getTuple(config)
    })
    await expect(f.engine.resume(f.f.run.id)).rejects.toBeDefined()
    expect(crashed).toBe(true)
    const receipts = await f.receipts()
    expect(receipts).toHaveLength(1)
    failure.mockRestore()
    await f.engine.resume(f.f.run.id)
    await f.engine.resumeInteraction(f.delivered)
    expect(await f.receipts()).toEqual(receipts)
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
    expect((await f.runs.get(f.f.run.id))?.outcome).toBe('succeeded')
  }, 60000)

  it('excludes a competing Run owner while the real checkpoint consumer is active', async () => {
    const f = await fixture(), entered = rejectableDeferred(), release = rejectableDeferred()
    const consume = f.saver.consumeApprovalInterrupt.bind(f.saver)
    vi.spyOn(f.saver, 'consumeApprovalInterrupt').mockImplementation(async (sql, interaction) => {
      entered.resolve(); await release.promise
      return consume(sql, interaction)
    })
    const operation = f.engine.resume(f.f.run.id)
    try {
      await Promise.race([entered.promise, operation.then(() => { throw new Error('Missing checkpoint cut') })])
      const competitor = await RunOwnership.acquire(f.db.pool, f.f.run.id, () => undefined)
      try { expect(competitor).toBeUndefined() } finally { await competitor?.release() }
      release.resolve(); await operation
      expect(await f.receipts()).toHaveLength(1)
      expect(f.provider.counts.responses).toBe(1)
    } finally { release.resolve(); await operation.catch(() => undefined) }
  }, 60000)

  it('rejects a stale interrupt without accepting a checkpoint receipt', async () => {
    const f = await fixture(), before = await f.writes()
    const owner = await RunOwnership.acquire(f.db.pool, f.f.run.id, () => undefined)
    if (!owner) throw new Error('Expected exact Run ownership')
    try {
      await expect(owner.oneShotConnection().transaction((sql) => f.saver.consumeApprovalInterrupt(sql,
        { ...f.delivered, graphInterruptId: 'unrelated-interrupt' }))).rejects.toMatchObject({ code: 'GRAPH_INTERRUPT_NOT_CURRENT' })
      expect(await f.writes()).toEqual(before)
      expect(await f.receipts()).toEqual([])
    } finally { await owner.release() }
  }, 60000)
})
