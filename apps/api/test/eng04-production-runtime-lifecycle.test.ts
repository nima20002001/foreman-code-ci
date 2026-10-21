import { readPublicProjectionLocked } from '../src/modules/run-graph/compactSnapshot.js'
import type { PublicProjectionReader } from '../src/modules/run-graph/publicProjectionReader.js'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash } from 'node:crypto'
import { test, vi } from 'vitest'
import type pg from 'pg'
import { GraphRunStateSchema, type AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { beforeGraphCommit, ExclusiveGraphConnection, type GraphTransactionSql } from '../src/modules/run-graph/connection.js'
import type { RunOwnership } from '../src/modules/runs/ownership.js'
import type { RunStateUpdate } from '../src/modules/runs/port.js'
import { startFixture } from './eng04-start-fixtures.js'

// Real exclusive-connection/finalizer implementation; SQL, immutable readers and
// canonical producers below are EXPLICIT doubles. Real PG coverage is separate.
interface Database {
  run: AcceptedWorkflowRunV3; stopped: boolean; cleanup: boolean; head: number; published: string
  stopEffect?: { digest: string; entityId: string }
}
type EffectInput = import('../src/modules/run-graph/publication.js').GraphEffectChange
type EffectGuard = import('../src/modules/run-graph/publication.js').GraphEffectGuard
interface Fixture {
  db(): Database
  missingReceipt: boolean
  missingHead: boolean
  publications: number
}
const shared = vi.hoisted(() => ({ current: undefined as Fixture | undefined }))
const current = () => { assert.ok(shared.current); return shared.current }
function digest(value: unknown) {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
const stateDigest = (db: Database) => digest({ run: db.run, stopped: db.stopped })
function readback() {
  const db = current().db()
  return { run: structuredClone(db.run), stopped: db.stopped, replayed: db.published === stateDigest(db),
    evidence: { sourceKind: 'run' as const, sourceId: db.run.id, sourceRevision: String(db.head) },
    sourceDigest: stateDigest(db), semanticDigest: digest([db.run.executionState, db.run.outcome, db.stopped]) }
}
function stage(sql: GraphTransactionSql) {
  const fixture = current(), db = fixture.db(), source = readback()
  fixture.publications++
  // The actual production publisher finalizes BEFORE the receipt assertion.
  const receipt = { ...source, evidence: { ...source.evidence, sourceRevision: String(db.head + 1) } }
  beforeGraphCommit(sql, async () => {
    if (stateDigest(fixture.db()) !== source.sourceDigest) throw new Error('fixture-source-drift')
    fixture.db().head++; fixture.db().published = source.sourceDigest
  })
  return receipt
}
vi.mock('../src/modules/run-graph/publication.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/modules/run-graph/publication.js')>()
  const publications = new WeakMap<GraphTransactionSql, {
    sql: GraphTransactionSql; scope: EffectGuard['expected']['scope']
    effect(input: EffectInput, guard: EffectGuard, mutate: (sql: GraphTransactionSql) => Promise<void>): Promise<void>
    repeatStoppedRunReadback(): Promise<ReturnType<typeof stage>>
  }>()
  return {
    ...actual,
    graphSourceDigest: digest,
    currentRunGraphPublication: (sql: GraphTransactionSql, scope: unknown) => {
      const publication = publications.get(sql)
      assert.deepEqual(publication?.scope, scope)
      return publication
    },
    openRunGraphPublication: async (sql: GraphTransactionSql, scope: EffectGuard['expected']['scope'], reader: PublicProjectionReader, options?: unknown) => {
      assert.equal(reader, readPublicProjectionLocked)
      assert.equal(options, undefined, 'lifecycle must not initialize a missing head')
      if (current().missingHead) throw Object.assign(new Error('missing head'), { code: 'GRAPH_NOT_INITIALIZED' })
      const publication = { sql, scope,
        effect: async (input: EffectInput, guard: EffectGuard, mutate: (sql: GraphTransactionSql) => Promise<void>) => {
          // Explicit producer double: retain the current Stop effect's identity,
          // live authority read, transactional fence, and cleanup mutation.
          assert.deepEqual(input.effect.identity, { kind: 'run.stop', entityId: scope.runId })
          assert.equal(input.effect.digest, digest({ runId: scope.runId, stop: true }))
          assert.equal(input.sourceDigest, input.effect.digest)
          const actual = await guard.readCurrentLocked(sql, scope, input.effect.identity)
          assert.deepEqual(actual.scope, guard.expected.scope)
          assert.deepEqual(actual.effect, guard.expected.effect)
          assert.equal(actual.effectDigest, guard.expected.effectDigest)
          assert.equal(actual.ownerId, guard.expected.ownerId)
          assert.equal(actual.fence, guard.expected.fence)
          assert.equal(actual.connectionGeneration, guard.expected.connectionGeneration)
          assert.equal(actual.ownership, 'held'); assert.equal(actual.access, 'effect')
          assert.equal(actual.security, 'valid'); assert.equal(actual.effectClosed, false)
          assert.ok(input.facts.some((fact) => fact.type === 'run.state'
            && fact.state.stopRequested && fact.state.cleanupPending))
          assert.equal(current().db().stopEffect, undefined, 'a replay must not produce Stop again')
          await sql.query('update runs set stop_requested_at=coalesce(stop_requested_at,clock_timestamp()) where id=$1', [scope.runId])
          await mutate(sql)
          current().db().stopEffect = { digest: input.effect.digest, entityId: scope.runId }
        },
        repeatStoppedRunReadback: async () => {
          assert.equal(current().db().stopped, true); return stage(sql)
        },
      }
      publications.set(sql, publication)
      return publication
    },
    readRepeatRunSourceLocked: async () => readback(),
  }
})
vi.mock('../src/modules/run-graph/publicRunState.js', () => ({
  readPublicRunStateLocked: async () => {
    const db = current().db()
    return GraphRunStateSchema.parse({ executionState: db.run.executionState, outcome: db.run.outcome,
      stopRequested: db.stopped, cleanupPending: db.cleanup, pendingInteractionCount: 0, unsettledReviewCount: 0 })
  },
}))
vi.mock('../src/modules/run-graph/publicProjection.js', () => ({
  // These lifecycle fixtures are queued Runs with no admitted executions.
  publicRunClosedFacts: async () => [],
}))
vi.mock('../src/modules/runs/repeatStartRead.js', () => ({
  readAcceptedRepeatRunLocked: async () => {
    const db = current().db()
    return { run: structuredClone(db.run), version: startFixture().version, stopRequested: db.stopped, cleanupPending: db.cleanup }
  },
}))
vi.mock('../src/modules/run-graph/repeatReceipts.js', () => ({
  requireRepeatCanonicalReceiptBeforeCommit: (sql: GraphTransactionSql, receipt: {
    sourceDigest: string; effect: { kind: string; entityId: string; digest: string } | null
  }) => {
    beforeGraphCommit(sql, async () => {
      if (current().missingReceipt) throw new Error('fixture-missing-receipt')
      if (receipt.effect) {
        assert.equal(receipt.effect.kind, 'run.stop')
        assert.deepEqual(current().db().stopEffect, { digest: receipt.effect.digest, entityId: receipt.effect.entityId })
        assert.equal(receipt.sourceDigest, receipt.effect.digest)
      } else {
        const source = readback()
        if (!source.replayed || source.sourceDigest !== receipt.sourceDigest) throw new Error('fixture-missing-receipt')
      }
    })
  },
}))
vi.mock('../src/modules/run-graph/repeatPublication.js', () => ({
  publishRepeatRunStateLocked: async ({ sql }: { sql: GraphTransactionSql }) => {
    const receipt = stage(sql)
    beforeGraphCommit(sql, async () => {
      if (current().missingReceipt || current().db().published !== receipt.sourceDigest) throw new Error('fixture-missing-receipt')
    })
  },
}))

async function fixture() {
  const run = startFixture().run
  let saved: Database = { run, stopped: false, cleanup: false, head: 1, published: '' }
  saved.published = stateDigest(saved)
  let transaction: Database | undefined, fence = 'owner-generation-1'
  const statements: string[] = [], releases: boolean[] = []
  const flags = { loseCommit: false, authorityCalls: 0, denyAt: 0, ownerLossAt: 0,
    mutateAt: 0, ownedChecks: 0 }
  const f: Fixture = { db: () => transaction ?? saved, missingReceipt: false, missingHead: false, publications: 0 }
  shared.current = f
  class Client extends EventEmitter {
    getTransactionStatus() { return transaction ? 'T' : 'I' }
    release(destroy = false) { releases.push(destroy) }
    async query(text: string, values: unknown[] = []) {
      const sql = text.replace(/\s+/g, ' ').trim(); statements.push(sql)
      const rows = (values: unknown[] = []) => ({ rows: structuredClone(values), rowCount: values.length })
      if (sql.startsWith('begin')) { assert.equal(transaction, undefined); transaction = structuredClone(saved); return rows() }
      if (sql === 'commit') {
        assert.ok(transaction); saved = transaction; transaction = undefined
        if (flags.loseCommit) throw new Error('fixture-lost-commit-reply')
        return rows()
      }
      if (sql === 'rollback') { transaction = undefined; return rows() }
      assert.ok(transaction, 'all lifecycle SQL must be in one transaction')
      if (sql === 'select record from runs where id=$1') return rows([{ record: transaction.run }])
      if (sql === 'select pg_backend_pid()::text as owner,txid_current()::text as fence,record from runs where id=$1') {
        assert.deepEqual(values, [run.id])
        return rows([{ owner: 'fixture-backend', fence: 'fixture-transaction', record: transaction.run }])
      }
      if (sql.startsWith('select principal_id from run_authority_principals') || sql.startsWith('select p.id from management_principals')) return rows([{}])
      if (sql.startsWith('update runs set execution_state')) { transaction.run = JSON.parse(String(values[2])); return rows([{}]) }
      if (sql.startsWith('update runs set stop_requested_at')) { transaction.stopped = true; return rows([{}]) }
      if (sql.startsWith('insert into run_cleanup_intents')) { transaction.cleanup = true; return rows([{}]) }
      if (sql.startsWith('insert into run_activity') && sql.includes("'run_stop_requested'")) return rows([{}])
      // Stop also fences hierarchy waits and workflow controls; this Run has none of them.
      if (/^update run_(hierarchy_direction_waits|hierarchy_groups|coordinator_consultations|coordinator_mailboxes) /.test(sql)
        || /^select .+ from run_(control_continuations|coordinator_mailboxes|coordinator_consultations|chat_commands) /.test(sql)) return rows()
      throw new Error(`Unimplemented fixture SQL: ${sql}`)
    }
  }
  const assertOwned = () => { flags.ownedChecks++ }
  const ownerClient = new Client(), connection = new ExclusiveGraphConnection(ownerClient as unknown as pg.ClientBase, assertOwned)
  const owner = { runId: run.id, assertOwned, oneShotConnection: () => connection,
    readOneShotFence: async () => { assertOwned(); return { owner: 'owner-test', fence } } } as unknown as RunOwnership
  const authorize = async () => {
    flags.authorityCalls++
    if (flags.authorityCalls === flags.denyAt) throw new Error('fixture-access-denied')
    if (flags.authorityCalls === flags.ownerLossAt) fence = 'owner-generation-2'
    if (flags.authorityCalls === flags.mutateAt) f.db().run.input = { illegallyChanged: true }
  }
  const pool = { connect: async () => new Client() } as unknown as pg.Pool
  const writers = await import('../src/modules/runs/repeatLifecycle.js')
  return { f, flags, saved: () => saved, statements, releases, owner, connection, authorize,
    locations: { revalidateRunAuthorization: authorize }, pool, ...writers }
}
const running: RunStateUpdate = { executionState: 'running', outcome: 'pending', startedAt: '2026-09-25T00:00:00.000Z' }

test('ENG04 lifecycle: queued -> running publishes under the original owner transaction; exact replay is read-only', async () => {
  const f = await fixture()
  try {
    await f.markRepeatRunRunning(f.owner, f.locations, running)
    assert.equal(f.saved().run.executionState, 'running'); assert.equal(f.saved().head, 2)
    assert.equal(f.flags.authorityCalls, 2); assert.equal(f.f.publications, 1)
    const writes = f.statements.filter((sql) => sql.startsWith('update ')).length
    await f.markRepeatRunRunning(f.owner, f.locations, running)
    assert.equal(f.saved().head, 2); assert.equal(f.f.publications, 1)
    assert.equal(f.statements.filter((sql) => sql.startsWith('update ')).length, writes)
    assert.equal(f.saved().cleanup, false)
  } finally { await f.connection.close() }
})

test('ENG04 lifecycle: missing canonical head or receipt rolls back state and never repairs admission', async () => {
  for (const key of ['missingHead', 'missingReceipt'] as const) {
    const f = await fixture(); f.f[key] = true
    try {
      await assert.rejects(f.markRepeatRunRunning(f.owner, f.locations, running))
      assert.equal(f.saved().run.executionState, 'queued'); assert.equal(f.saved().head, 1)
      assert.equal(f.statements.includes('commit'), false); assert.equal(f.statements.includes('rollback'), true)
    } finally { await f.connection.close() }
  }
})

test('ENG04 lifecycle: live denial at entry/COMMIT and changed owner fence roll back', async () => {
  for (const flags of [{ denyAt: 1 }, { denyAt: 2 }, { ownerLossAt: 2 }]) {
    const f = await fixture(); Object.assign(f.flags, flags)
    try {
      await assert.rejects(f.markRepeatRunRunning(f.owner, f.locations, running))
      assert.equal(f.saved().run.executionState, 'queued'); assert.equal(f.saved().head, 1)
      assert.equal(f.statements.includes('commit'), false)
    } finally { await f.connection.close() }
  }
})

test('ENG04 lifecycle: Stop, cleanup, waiting, terminal and broader update attempts cannot start work', async () => {
  const cases: Array<(f: Awaited<ReturnType<typeof fixture>>) => void> = [
    (f) => { f.saved().stopped = true }, (f) => { f.saved().cleanup = true },
    (f) => { f.saved().run.executionState = 'waiting' }, (f) => { f.saved().run.executionState = 'completed' },
  ]
  for (const mutate of cases) {
    const f = await fixture(); mutate(f)
    try {
      await assert.rejects(f.markRepeatRunRunning(f.owner, f.locations, running))
      assert.equal(f.f.publications, 0); assert.equal(f.statements.some((sql) => sql.startsWith('update ')), false)
    } finally { await f.connection.close() }
  }
  const f = await fixture()
  try {
    await assert.rejects(f.markRepeatRunRunning(f.owner, f.locations, { executionState: 'waiting', outcome: 'pending' }), { code: 'REPEAT_LIFECYCLE_PUBLICATION_REQUIRED' })
    assert.equal(f.statements.length, 0)
  } finally { await f.connection.close() }
})

test('ENG04 lifecycle: Stop commits fence, cleanup intent and source in one transaction; replay does not rearm cleanup', async () => {
  const f = await fixture()
  try {
    await f.requestRepeatRunStop(f.pool, f.owner.runId, f.authorize)
    assert.equal(f.saved().stopped, true); assert.equal(f.saved().cleanup, true); assert.equal(f.saved().head, 2)
    assert.equal(f.saved().run.executionState, 'queued')
    // Entry, effect-authority capture, producer guard, and final live authorization.
    assert.equal(f.flags.authorityCalls, 4)
    assert.equal(f.saved().stopEffect?.entityId, f.owner.runId)
    const count = f.statements.filter((sql) => sql.startsWith('insert into run_cleanup_intents')).length
    const activityCount = f.statements.filter((sql) => sql.startsWith('insert into run_activity')).length
    assert.equal(activityCount, 1)
    // Synthetic independent cleanup completion; Stop replay cannot undo it.
    f.saved().cleanup = false
    await f.requestRepeatRunStop(f.pool, f.owner.runId, f.authorize)
    assert.equal(f.saved().cleanup, false); assert.equal(f.saved().head, 2)
    assert.equal(f.statements.filter((sql) => sql.startsWith('insert into run_cleanup_intents')).length, count)
    assert.equal(f.statements.filter((sql) => sql.startsWith('insert into run_activity')).length, activityCount)
  } finally { await f.connection.close() }
})

test('ENG04 lifecycle: denied Stop or missing canonical receipt leaves neither fence nor intent', async () => {
  for (const deniedAt of [1, 2, 3, 4, 0]) {
    const f = await fixture(); f.flags.denyAt = deniedAt; f.f.missingReceipt = deniedAt === 0
    try {
      await assert.rejects(f.requestRepeatRunStop(f.pool, f.owner.runId, f.authorize))
      assert.equal(f.saved().stopped, false); assert.equal(f.saved().cleanup, false); assert.equal(f.saved().head, 1)
      assert.equal(f.saved().stopEffect, undefined)
      assert.equal(f.statements.includes('commit'), false)
    } finally { await f.connection.close() }
  }
})

test('ENG04 lifecycle: completed Stop replay validates its source without requesting cleanup or another Stop', async () => {
  const f = await fixture()
  f.saved().run.executionState = 'completed'; f.saved().run.outcome = 'succeeded'
  f.saved().run.result = { outcome: 'succeeded', output: {} }
  f.saved().run.finishedAt = '2026-09-25T01:00:00.000Z'
  f.saved().published = stateDigest(f.saved())
  try {
    await f.requestRepeatRunStop(f.pool, f.owner.runId, f.authorize)
    assert.equal(f.saved().stopped, false); assert.equal(f.saved().cleanup, false)
    assert.equal(f.f.publications, 0)
    f.saved().published = 'missing'
    await assert.rejects(f.requestRepeatRunStop(f.pool, f.owner.runId, f.authorize), { code: 'GRAPH_SOURCE_CONFLICT' })
  } finally { await f.connection.close() }
})

test('ENG04 lifecycle: replay detects source drift after the final live authorization callback', async () => {
  const f = await fixture()
  try {
    await f.markRepeatRunRunning(f.owner, f.locations, running)
    const original = structuredClone(f.saved()), before = f.flags.authorityCalls
    f.flags.mutateAt = before + 2
    await assert.rejects(f.markRepeatRunRunning(f.owner, f.locations, running))
    assert.deepEqual(f.saved(), original)
  } finally { await f.connection.close() }
})

test('ENG04 lifecycle: lost COMMIT reply never retries mutation and poisons the owner connection', async () => {
  const f = await fixture(); f.flags.loseCommit = true
  try {
    await assert.rejects(f.markRepeatRunRunning(f.owner, f.locations, running), /lost-commit/)
    assert.equal(f.saved().run.executionState, 'running'); assert.equal(f.saved().head, 2)
    await assert.rejects(f.markRepeatRunRunning(f.owner, f.locations, running), { code: 'GRAPH_TRANSACTION_FAILED' })
    assert.equal(f.f.publications, 1)
  } finally { await f.connection.close() }
})

test('ENG04 lifecycle: replay cannot replace the original startedAt pin', async () => {
  const f = await fixture()
  try {
    await f.markRepeatRunRunning(f.owner, f.locations, running)
    const original = structuredClone(f.saved())
    await assert.rejects(f.markRepeatRunRunning(f.owner, f.locations, { ...running, startedAt: '2026-09-26T00:00:00.000Z' }), { code: 'RUN_PIN_CONFLICT' })
    assert.deepEqual(f.saved(), original); assert.equal(f.f.publications, 1)
  } finally { await f.connection.close() }
})
