import { afterAll, afterEach, beforeAll, expect, vi } from 'vitest'
import type { DurableInteraction } from '@foreman-code/contracts'
import { checkpointRuntimeFixture } from './wave25Br1003Runtime.js'
import { agent3Database } from './wave25Agent3.js'

type Fixture = Awaited<ReturnType<typeof checkpointRuntimeFixture>>

export function productionFixtures() {
  let database: Awaited<ReturnType<typeof agent3Database>> | undefined
  const fixtures: Fixture[] = []
  beforeAll(async () => {
    database = await agent3Database()
  }, 60000)
  afterEach(async () => {
    try {
      while (fixtures.length) await fixtures.pop()!.close()
    } finally {
      vi.restoreAllMocks()
    }
  })
  afterAll(async () => {
    await database?.close()
  }, 60000)

  return async function fixture(branches: 1 | 2 = 1, pendingPerExecution: 1 | 2 = 1) {
    if (!database) throw new Error('Expected the suite database to be initialized')
    const original = { closedSessions: new Set<string>() }
    const f = await checkpointRuntimeFixture(branches, pendingPerExecution, {
      database,
      // Cold recovery uses the original manager's physical closure record.
      recoverNativeProcesses: async (executionId, signal) => {
        signal.throwIfAborted()
        return original.closedSessions.has(`native-${executionId}`)
      },
    })
    original.closedSessions = f.provider.closedSessions
    fixtures.push(f)
    return f
  }
}

export function response(interaction: DurableInteraction) {
  const option = interaction.responseOptions.find((item) => item.semantic === 'approve_once')
  if (!option) throw new Error('Missing native approve-once option')
  return { interactionId: interaction.id, optionId: option.optionId, expectedRevision: interaction.revision }
}
export async function expireAbandonedClaims(f: Fixture) {
  // Test-only clock advancement after a crashed consumer; do not sleep through
  // the production TTL and do not change the token/fence/state being tested.
  await f.db.pool.query(`update interaction_graph_resumes set lease_expires_at=clock_timestamp()-interval '1 microsecond'
    where run_id=$1 and state='resuming'`, [f.f.run.id])
}
export async function restart(f: Fixture) {
  // Shutdown records the original manager's native closure before the new
  // composition acquires Run ownership.
  await f.engine.shutdown()
  return f.compose()
}
export async function recover(f: Fixture) {
  await f.engine.resume(f.f.run.id)
}

export async function stageDelivered(f: Fixture) {
  // Crash the registered callback, not the delivery/helper implementation.
  // Both native decisions are delivered via the real service/coordinator first.
  const crash = vi.spyOn(f.engine, 'resumeInteraction').mockRejectedValue(new Error('crash-after-delivery-before-consume'))
  try {
    for (const interaction of await f.pending()) {
      const result = await f.service.respond({ kind: 'user', principal: f.principal }, response(interaction))
      expect(result.interaction.deliveryState).toBe('delivered')
    }
  } finally { crash.mockRestore() }
  expect(await f.receipts()).toEqual([])
}
export async function checkpointCut(f: Fixture) {
  const tuple = await f.saver.getTuple(f.config)
  if (!tuple) throw new Error('Expected an actual persisted checkpoint')
  return { config: tuple.config, pendingWrites: tuple.pendingWrites }
}

export function crashAfterCommitSaver(f: Fixture) {
  const getTuple = f.saver.getTuple.bind(f.saver)
  let crashed = false
  const spy = vi.spyOn(f.saver, 'getTuple').mockImplementation(async (config) => {
    if (!crashed && (await f.receipts()).length) {
      crashed = true
      throw new Error('crash-after-commit-before-graph-dispatch')
    }
    return getTuple(config)
  })
  return { get crashed() { return crashed }, restore: () => spy.mockRestore() }
}

