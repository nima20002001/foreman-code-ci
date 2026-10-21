import { describe, expect, it } from 'vitest'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { candidateFor, postgresEnabled } from './helpers/wave25Agent3.js'
import { lifecycleParityFixture } from './helpers/lifecycleParityFixture.js'
import { currentRepositoryFixture } from './helpers/wave25CurrentRepository.js'
import { repeatRuntimeDirectory } from '../src/modules/runs/repeatRepositoryHost.js'

describe.skipIf(!postgresEnabled)('Lifecycle cleanup and graph replay', () => {
  const fixtures = lifecycleParityFixture()

  it.each(['failed', 'canceled'] as const)('matches snapshots through admission, launch claim, %s and cleanup', async (outcome) => {
    const db = fixtures.database()
    const t = await currentRepositoryFixture(db), f = t.f
    const owner = await t.repository.acquireOwnership(f.run.id, () => undefined)
    if (!owner) throw new Error('Expected actual Run ownership')
    fixtures.closeAfterEach(() => owner.release())
    const store = await t.repository.repeat(owner), { compare } = await graphParity(db.pool, f.scope)
    await compare()
    await t.repository.updateState(f.run.id, { executionState: 'running', outcome: 'pending', startedAt: new Date().toISOString() }, owner)
    await compare()
    const admitted = await store.admit({ nodeId: f.version.entryNodeId, occurrence: null }, () => candidateFor(f))
    if (admitted.kind !== 'admitted') throw new Error('Expected exact queue admission')
    await compare()
    const claimed = await store.claimLaunch(admitted.execution.id, { workingDirectory: f.run.executionLocation!.rootPath,
      runtimeDirectory: repeatRuntimeDirectory(db.directory, f.scope, admitted.execution) })
    expect(claimed).toBeDefined()
    await compare()
    if (outcome === 'canceled') await t.stop()
    else await t.repository.requestCleanup(f.run.id, owner)
    const pending = await compare()
    expect(pending.state.run.cleanupPending).toBe(true)
    expect((await store.readExecution(admitted.execution.id)).execution.state).toBe('starting')
    await t.repository.settleOrphan(f.run.id, owner, outcome === 'canceled')
    const terminal = await compare()
    expect(terminal.state.run.outcome).toBe(outcome)
    expect((await store.readExecution(admitted.execution.id)).execution.result?.outcome).toBe(outcome)
    expect((await db.pool.query('select 1 from run_repeat_results where execution_id=$1', [admitted.execution.id])).rowCount).toBe(0)
    await t.repository.finishCleanup(f.run.id, false, owner)
    const settled = await compare()
    expect(settled.state.run.cleanupPending).toBe(false)
    await t.repository.finishCleanup(f.run.id, false, owner)
    expect((await compare()).asOfSequence).toBe(settled.asOfSequence)
  }, 60000)
})
