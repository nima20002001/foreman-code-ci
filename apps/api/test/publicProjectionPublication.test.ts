import assert from 'node:assert/strict'
import { describe, it, vi } from 'vitest'
import { readPublicProjectionLocked } from '../src/modules/run-graph/compactSnapshot.js'
import { readRepeatGraphCurrent } from '../src/modules/run-graph/repeatReader.js'
import { ProjectionDatabase, projectionScope } from './eng04-projection-fixture.js'

describe('publication projection reader', () => {
  it('reads an admitted ordinary workflow without inventing native work', async () => {
    const db = new ProjectionDatabase()
    await db.initialize()

    const snapshot = await readRepeatGraphCurrent(db.pool(), {
      protocolVersion: 1,
      scope: projectionScope,
    }, async () => undefined)

    assert.equal(snapshot.asOfSequence, '1')
    assert.equal(snapshot.state.nodes.length, 1)
    const node = snapshot.state.nodes[0]!
    const workflowNodeId = db.fixture.version.definition.nodes[0]!.id
    assert.deepEqual(node.state, { workflowNodeId, lifecycle: 'not_activated' })
    assert.deepEqual(node.activity, { workflowNodeId, status: 'unknown' })
    assert.deepEqual(snapshot.state.executions, [])
    assert.deepEqual(snapshot.state.interactions, [])
    assert.deepEqual(snapshot.state.reviews, [])
    assert.deepEqual(snapshot.state.occurrences, [])
    assert.equal(db.state.head, 1)
  })

  it('uses the supplied reader on the same transaction for opening, capture and commit recheck', async () => {
    const reader = vi.fn(readPublicProjectionLocked)
    const db = new ProjectionDatabase(reader)
    await db.initialize()
    reader.mockClear()

    await db.changeRun({ cleanupPending: true })

    assert.equal(reader.mock.calls.length, 3)
    const sql = reader.mock.calls[0]![0]
    for (const [transaction, scope] of reader.mock.calls) {
      assert.equal(transaction, sql)
      assert.deepEqual(scope, projectionScope)
    }
    assert.equal(db.state.head, 2)
    assert.equal(db.state.cleanupPending, true)
    assert.equal(db.state.projection?.record.run.cleanupPending, true)
  })

  it.each([1, 2, 3])('rolls back when projection read %i fails', async (failureAt) => {
    let reads = 0
    let rejectReads = false
    const failure = new Error('projection read failed')
    const reader = vi.fn(async (...args: Parameters<typeof readPublicProjectionLocked>) => {
      reads++
      if (rejectReads && reads === failureAt) throw failure
      return readPublicProjectionLocked(...args)
    })
    const db = new ProjectionDatabase(reader)
    await db.initialize()
    const before = structuredClone(db.state)
    reads = 0
    rejectReads = true

    await assert.rejects(db.changeRun({ cleanupPending: true }), failure)

    assert.equal(reads, failureAt)
    assert.deepEqual(db.state, before)
  })
})
