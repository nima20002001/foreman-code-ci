import { setImmediate } from 'node:timers/promises'
import type pg from 'pg'
import { expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { observationFixture } from '../ci-host/observationConcurrency.testSupport.js'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import { inactiveRepeatResolution } from './repeatNode.js'
import { RepeatRunRepository, type RepeatLockedHooks } from './repeatPostgres.js'
import { rejectableDeferred } from '../../../test/helpers/deferred.js'

it('allows a CI observation to persist while a Run mutation validates its unchanged parent identity', async () => {
  const fixture = makeCurrentWorkflowFixture('ci-concurrency', 'repeat')
  const entered = rejectableDeferred<void>()
  const finish = rejectableDeferred<void>()
  const committed = rejectableDeferred<void>()
  let excludesKeyShare = false
  const exit = fixture.version.definition.repeat!.blocks[0]!.exitNodeId
  // Model PostgreSQL row-lock compatibility at the database boundary. The Run
  // keeps its mutation lock until COMMIT; CI's activity trigger takes KEY SHARE.
  const raw = { query: async (text: string) => {
    if (text.includes('from runs r join workflow_versions')) {
      excludesKeyShare = /for update(?: of r)?\s*$/i.test(text)
      return { rows: [{ run: fixture.run, version: fixture.version, stopped: false,
        state: fixture.run.executionState, now: fixture.createdAt }] }
    }
    if (text.includes('from run_repeat_resolutions')) {
      return { rows: [{ record: inactiveRepeatResolution(fixture.version,
        { nodeId: exit, occurrence: null }, 'skipped', fixture.createdAt) }] }
    }
    if (text === 'commit' || text === 'rollback') committed.resolve()
    return { rows: [] }
  } } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(raw, () => {})
  const owner = { runId: fixture.run.id, assertOwned() {}, oneShotConnection: () => connection,
    readOneShotFence: async () => ({ ownerId: 'owner', fence: '1' }) }
  const repository = new RepeatRunRepository(owner, { openLocked: async () => {
    entered.resolve()
    await finish.promise
    return { run: fixture.run } as unknown as RepeatLockedHooks
  } }, fixture.version)
  const ci = observationFixture({ cloud: 1, local: 0, poolSize: 4, beforeWrite: async () => {
    if (excludesKeyShare) await committed.promise
  } })
  const mutation = repository.enterBlock('repair')
  try {
    await entered.promise
    await ci.service.dispatch()
    await setImmediate()
    expect((await ci.service.get(ci.caller, { ticketId: ci.records[0]!.id })).run.step).toBe('checking')
  } finally {
    finish.resolve()
    await expect(mutation).resolves.toEqual({ kind: 'inactive' })
    await ci.service.close()
  }
})
