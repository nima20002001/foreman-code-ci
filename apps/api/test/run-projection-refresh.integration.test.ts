import { afterAll, beforeAll, expect, it } from 'vitest'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'
import { nativeStreamFixture } from './helpers/nativeStreamFixture.js'
import { openNativeBatch, closeNativeBatch } from '../src/modules/run-graph/nativeBatch.js'
import { flushNativeGraphRows } from '../src/modules/run-graph/nativeWriter.js'
import { openWorkflowLifecycleLocked } from '../src/modules/runs/repeatLifecycle.js'
import { latestWorkflowCorrelation } from '../src/modules/runs/workflowNativeCorrelation.js'
import { readCompactProjectionRows } from '../src/modules/run-graph/compactProjectionRows.js'
import { readPublicProjectionLocked, createCompactSnapshotAssembler } from '../src/modules/run-graph/compactSnapshot.js'
import { readCurrentGraphExchanges } from '../src/modules/interactions/wave25/currentExchanges.js'

let db: Awaited<ReturnType<typeof currentDatabase>>
const owners: Array<Awaited<ReturnType<typeof nativeStreamFixture>>['owner']> = []
beforeAll(async () => { db = await currentDatabase() }, 60_000)
afterAll(async () => {
  for (const owner of owners) await owner.release()
  await db?.close()
})

async function fixture() {
  const f = await nativeStreamFixture(db, 1, true)
  owners.push(f.owner)
  return f
}

it('refreshes persisted latest-turn candidates at each correlation flush', async () => {
  const f = await fixture()
  await f.owner.oneShotConnection().transaction(async sql => {
    await openWorkflowLifecycleLocked(sql, f.scope.runId)
    const batch = openNativeBatch(sql, f.scope.runId)
    const base = `execution:${f.execution.id}`
    try {
      expect(await latestWorkflowCorrelation(sql, f.scope.runId, f.execution.id, base)).toBe(base)
      for (const [index, turn] of ['turn', 'capacity-turn'].entries()) {
        const retry = `${base}:retry:${turn}`
        // Materialized retry rows must become visible when the batch flushes, even if its candidate list is warm.
        await sql.query(`insert into run_native_correlations(run_id,execution_id,workflow_node_id,attempt,
          work_kind,work_id,correlation_key,provider,native_session_id,connection_id,connection_generation,
          native_turn_id,first_native_sequence,last_native_sequence,metadata_revision)
          values($1,$2,$3,1,'workflow',$2,$4,'codex',$5,'connection',1,null,$6,$6,0)`,
        [f.scope.runId, f.execution.id, f.execution.workflowNodeId, retry, f.session.nativeSessionId, index + 1])
        await flushNativeGraphRows(batch, ['correlation'])
        expect(await latestWorkflowCorrelation(sql, f.scope.runId, f.execution.id, base)).toBe(retry)
      }
    } finally { closeNativeBatch(batch) }
  })
})

it('omits full pins when projection nodes are supplied and preserves assembled snapshot contents', async () => {
  const f = await fixture()
  await f.owner.oneShotConnection().transaction(async sql => {
    const { pins, ...withoutPins } = await readCompactProjectionRows(sql, f.scope)
    expect(pins).toHaveLength(1)
    const supplied = await readCompactProjectionRows(sql, f.scope, f.f.version.definition.nodes.map(node => node.id))
    expect(supplied).not.toHaveProperty('pins')
    expect(supplied).toEqual(withoutPins)
    const projection = await readPublicProjectionLocked(sql, f.scope)
    expect(await readPublicProjectionLocked(sql, f.scope, f.f.version)).toEqual(projection)
    const snapshot = await createCompactSnapshotAssembler(readCurrentGraphExchanges)(sql, f.scope)
    expect(snapshot.state).toEqual(projection)
  }, true)
})
