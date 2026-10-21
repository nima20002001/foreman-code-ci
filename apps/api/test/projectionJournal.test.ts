import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { RepeatGraphStateV3Schema, type RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { openRunGraphPublication, type RunGraphPublication } from '../src/modules/run-graph/publication.js'
import { requireRepeatCanonicalReceiptBeforeCommit } from '../src/modules/run-graph/repeatReceipts.js'
import { readRepeatGraphCurrent, readRepeatGraphPage } from '../src/modules/run-graph/repeatReader.js'
import { assertRepeatGraphCommittedState } from '../src/modules/run-graph/repeatProjectionProof.js'
import { ProjectionDatabase, projectionScope, projectionDigest, occurrenceFact, publicationInput } from './eng04-projection-fixture.js'

async function database() { const db = new ProjectionDatabase(); await db.initialize(); return db }
const domainSources = (db: ProjectionDatabase) => db.state.sources.filter((row) => row.source_kind === 'input_binding')

async function publish(db: ProjectionDatabase, count = 1) {
  const connection = db.connection()
  let publication!: RunGraphPublication<RepeatGraphScopeV3>
  try {
    await connection.transaction(async sql => {
      publication = await openRunGraphPublication(sql, projectionScope, db.readPublicProjection)
      for (let n = 0; n < count; n++) {
        const id = String(n), input = publicationInput(id)
        const result = await publication.repeatChange(input, db.owner,
          async transaction => { await transaction.query('update projection_test_domain set revision=revision+1') }, async () => [occurrenceFact(id)])
        requireRepeatCanonicalReceiptBeforeCommit(sql, { scope: projectionScope, evidence: input.evidence,
          sourceDigest: input.sourceDigest, semanticDigest: result.semanticDigest,
          effect: { kind: input.effect.identity.kind, entityId: input.effect.identity.entityId, digest: input.effect.digest } })
        assert.throws(() => publication.receipt)
      }
    })
    return publication.receipt
  } finally { await connection.close() }
}
const request = (afterSequence: string) => ({ protocolVersion: 1, scope: projectionScope, afterSequence })
const allowRead = async () => undefined // SQL-model authorization callback; NOT application authorization.

describe('Run graph journal', () => {
  it('publishes one head per transaction and rejects inconsistent receipts before commit', async () => {
    const db = await database(), receipt = await publish(db, 2)
    assert.equal(receipt.kind, 'events'); assert.equal(db.state.head, 2); assert.equal(db.state.domain, 2)
    assert.equal(domainSources(db).length, 2); assert.equal(db.state.sources.length, 6); assert.equal(db.state.effects.length, 2)
    const before = structuredClone(db.state)
    db.onInsertEffect = effect => { effect.effect_digest = `sha256:${'f'.repeat(64)}` }
    await assert.rejects(publish(db, 3), { code: 'REPEAT_PUBLICATION_RECEIPT_CONFLICT' })
    assert.deepEqual(db.state, before)
    assert.equal(db.transactions.at(-1)?.outcome, 'rolled-back')
  })
  it('duplicate source/effect skips mutation and consumes no cursor', async () => {
    const db = await database(); await publish(db)
    assert.equal((await publish(db)).kind, 'none'); assert.equal(db.state.domain, 1); assert.equal(db.state.head, 2)
  })
  it('reset-on-oversize retains permanent receipts and exact replay after retention', async () => {
    const db = await database(); assert.equal((await publish(db, 65)).kind, 'reset')
    assert.equal(db.state.batches.at(-1)!.payload, null); assert.equal(domainSources(db).length, 65); assert.equal(db.state.sources.length, 68); assert.equal(db.state.effects.length, 65)
    const barrier = await readRepeatGraphPage(db.pool(), request('1'), allowRead)
    assert.equal(barrier.kind, 'reset'); if (barrier.kind === 'reset') assert.equal(barrier.reason, 'atomic_change_too_large')
    db.state.floor = 2; db.state.batches = []
    assert.equal((await publish(db, 65)).kind, 'none'); assert.equal(db.state.head, 2); assert.equal(db.state.domain, 65)
    const expired = await readRepeatGraphPage(db.pool(), request('1'), allowRead)
    assert.equal(expired.kind, 'reset'); if (expired.kind === 'reset') assert.equal(expired.reason, 'history_expired')
  })
  it('a caught digest conflict still rolls the entire transaction back', async () => {
    const db = await database(); await publish(db); const before = structuredClone(db.state), c = db.connection()
    try { await assert.rejects(c.transaction(async sql => {
      const p = await openRunGraphPublication(sql, projectionScope, db.readPublicProjection)
      const wrong = { ...publicationInput('0'), sourceDigest: `sha256:${'b'.repeat(64)}` }
      await assert.rejects(p.repeatChange(wrong, db.owner, async () => undefined, async () => [occurrenceFact('0')]))
    })) } finally { await c.close() }
    assert.deepEqual(db.state, before)
  })
  it('Stop blocks a new effect before its mutation', async () => {
    const db = await database(); await db.changeRun({ stopped: true })
    await assert.rejects(publish(db), { code: 'GRAPH_STOP_CONFLICT' }); assert.equal(db.state.head, 2); assert.equal(db.state.domain, 0)
    assert.equal(db.transactions.at(-1)?.outcome, 'rolled-back')
  })
  it('owner fence loss after publication writes rolls domain/head/receipts back', async () => {
    const db = await database(); db.onInsertSource = () => { db.ownerFence = '101' }
    await assert.rejects(publish(db)); assert.equal(db.state.head, 1); assert.equal(db.state.domain, 0); assert.equal(domainSources(db).length, 0); assert.equal(db.state.sources.length, 3)
  })
  it('missing committed effect proof is not repaired by a duplicate', async () => {
    const db = await database(); await publish(db); db.state.effects = []
    await assert.rejects(publish(db)); assert.equal(db.state.head, 2); assert.equal(db.state.domain, 1)
  })
  it('an unknown COMMIT reply does not return a receipt or retry work', async () => {
    const db = await database(); db.unknownCommit = true
    await assert.rejects(publish(db), /COMMIT reply lost/)
    assert.equal(db.state.head, 2); assert.equal(db.state.domain, 1)
    assert.equal((await publish(db)).kind, 'none'); assert.equal(db.state.domain, 1)
  })
  it('returns ordered complete batches, and current-head empty catch-up', async () => {
    const db = await database(); await publish(db)
    const page = await readRepeatGraphPage(db.pool(), request('1'), allowRead)
    assert.equal(page.kind, 'page'); if (page.kind === 'page') {
      assert.equal(page.throughSequence, '2'); assert.equal(page.batches[0]!.events.length, 1); assert.equal(page.hasMore, false)
    }
    const empty = await readRepeatGraphPage(db.pool(), request('2'), allowRead)
    assert.equal(empty.kind, 'page'); if (empty.kind === 'page') assert.equal(empty.batches.length, 0)
  })
  it('a schema-valid retained payload with a changed fact fails its permanent semantic proof', async () => {
    const db = await database(); await publish(db)
    const row = db.state.batches.at(-1)!, body = JSON.parse(row.payload!)
    body.events[0].fact.occurrence.identity.occurrenceId = 'occ-x'
    row.payload = JSON.stringify(body); row.payload_bytes = Buffer.byteLength(row.payload!)
    const result = await readRepeatGraphPage(db.pool(), request('1'), allowRead)
    assert.equal(result.kind, 'reset'); if (result.kind === 'reset') assert.equal(result.reason, 'schema_changed')
  })
  it('a batch cannot reuse a source whose permanent first sequence does not match', async () => {
    const db = await database(); await publish(db)
    domainSources(db)[0]!.first_sequence = '3'
    const result = await readRepeatGraphPage(db.pool(), request('1'), allowRead)
    assert.equal(result.kind, 'reset')
  })
  it('a hole never produces a partial delta', async () => {
    const db = await database(); await publish(db); db.state.head = 3; db.state.batches = []
    const result = await readRepeatGraphPage(db.pool(), request('1'), allowRead)
    assert.equal(result.kind, 'reset'); if (result.kind === 'reset') assert.equal(result.reason, 'gap')
  })
  it('rejects wrong physical pins and unknown semantics before mutation', async () => {
    for (const change of [{ workflowVersionId: 'other' }, { workspaceId: 'other' }, { executionSemanticsVersion: 4 }]) {
      const db = await database(); Object.assign(db.scope, change)
      await assert.rejects(publish(db)); assert.equal(db.state.domain, 0)
    }
    const db = await database()
    await assert.rejects(readRepeatGraphPage(db.pool(), { ...request('1'), scope: { ...projectionScope, executionSemanticsVersion: 4 } }, allowRead))
  })
  it('snapshot recovery requires committed Run metadata, including after payload reset/retention', async () => {
    const db = new ProjectionDatabase(), c = db.connection()
    const state = RepeatGraphStateV3Schema.parse({ run: db.runState(), nodes: [], inputBindings: [], interactions: [], reviews: [],
      occurrences: [], executions: [], results: [], bindings: [], resolutions: [], decisions: [] })
    try {
      await assert.rejects(c.transaction(sql => assertRepeatGraphCommittedState(sql, projectionScope, '0', state), true))
      await db.initialize()
      const current = await readRepeatGraphCurrent(db.pool(), { protocolVersion: 1, scope: projectionScope }, allowRead)
      db.state.floor = 1; db.state.batches = []
      await c.transaction(sql => assertRepeatGraphCommittedState(sql, projectionScope, '1', current.state), true)
      await assert.rejects(c.transaction(sql => assertRepeatGraphCommittedState(sql, projectionScope, '1',
        { ...current.state, run: { ...current.state.run, stopRequested: true } }), true))
      assert.equal(db.state.head, 1)
    } finally { await c.close() }
  })
  it('late terminal evidence after Stop cannot be used to publish running work', async () => {
    const db = await database(); await db.changeRun({ stopped: true }); const c = db.connection()
    const execution = { identity: { workflowNodeId: 'outside', executionId: 'e', agentId: 'a', agentConfigurationVersionId: 'c', attempt: 1, occurrence: null },
      inputDigest: projectionDigest, previousExecutionId: null, state: 'completed' as const, resultOutcome: 'canceled' as const }
    try {
      await c.transaction(async sql => {
        const p = await openRunGraphPublication(sql, projectionScope, db.readPublicProjection)
        await p.repeatObservation({ evidence: { sourceKind: 'execution', sourceId: 'native-terminal', sourceRevision: '1' }, sourceDigest: projectionDigest },
          db.owner, async () => undefined, async () => [{ type: 'repeat.execution', execution }])
      })
      await assert.rejects(c.transaction(async sql => {
        const p = await openRunGraphPublication(sql, projectionScope, db.readPublicProjection)
        await p.repeatObservation({ evidence: { sourceKind: 'execution', sourceId: 'native-running', sourceRevision: '1' }, sourceDigest: projectionDigest },
          db.owner, async transaction => { await transaction.query('update projection_test_domain set revision=revision+1') },
          async () => [{ type: 'repeat.execution', execution: { ...execution, state: 'running', resultOutcome: null } }])
      }))
      assert.equal(db.state.head, 3); assert.equal(db.state.domain, 0)
    } finally { await c.close() }
  })
  it('read authorization failure does not read head or payload', async () => {
    const db = new ProjectionDatabase()
    await assert.rejects(readRepeatGraphPage(db.pool(), request('1'), async () => { throw new Error('denied') }))
    db.assertNoProtectedGraphReads()
  })
  it('metadata journal never receives the private source body', async () => {
    const db = await database(); await publish(db)
    const wire = db.state.batches.at(-1)!.payload!
    assert.ok(wire.includes(projectionDigest)); assert.ok(!/"(resultData|input_json|result_json|nativeSessionId|runtimeDirectory|prompt|credentials)"/.test(wire))
  })
  it('does not initialize a missing head or heal an unjournaled public cut on an empty page', async () => {
    const missing = await database(); missing.initialized = false
    const missingBefore = structuredClone(missing.state)
    await assert.rejects(readRepeatGraphPage(missing.pool(), request('1'), allowRead), { code: 'GRAPH_NOT_INITIALIZED' })
    assert.equal(missing.writes, 0)
    assert.equal(missing.initialized, false)
    assert.deepEqual(missing.state, missingBefore)
    const corrupt = await database(); corrupt.state.cleanupPending = true
    const corruptBefore = structuredClone(corrupt.state)
    await assert.rejects(readRepeatGraphPage(corrupt.pool(), request('1'), allowRead), { code: 'GRAPH_INVARIANT_VIOLATION' })
    assert.equal(corrupt.writes, 0)
    assert.deepEqual(corrupt.state, corruptBefore)
  })
  it('canonical admission keeps an ordinary V3 workflow free of manufactured repeat history', async () => {
    const db = await database()
    const current = await readRepeatGraphCurrent(db.pool(), { protocolVersion: 1, scope: projectionScope }, allowRead)
    assert.equal(db.fixture.version.definition.repeat, undefined)
    assert.deepEqual(current.state.occurrences, []); assert.deepEqual(current.state.decisions, [])
    assert.deepEqual(current.state.executions, []); assert.equal(current.state.nodes.length, 1)
    assert.equal(db.state.sources.length, 3, 'Run, public projection, and complete-batch envelope each retain their actual receipt')
    assert.equal(db.state.effects.length, 0)
  })
  it('returns the saved execution semantics through canonical readback', async () => {
    const db = await database()
    const current = await readRepeatGraphCurrent(db.pool(), { protocolVersion: 1, scope: projectionScope }, allowRead)
    assert.equal(current.scope.executionSemanticsVersion, 3)
  })
})
