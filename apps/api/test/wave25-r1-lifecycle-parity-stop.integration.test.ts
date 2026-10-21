import { describe, expect, it } from 'vitest'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { candidateFor, postgresEnabled } from './helpers/wave25Agent3.js'
import { lifecycleParityFixture } from './helpers/lifecycleParityFixture.js'
import { currentRepositoryFixture } from './helpers/wave25CurrentRepository.js'
import { repeatRuntimeDirectory } from '../src/modules/runs/repeatRepositoryHost.js'

describe.skipIf(!postgresEnabled)('Stop before settlement and graph replay', () => {
  const fixtures = lifecycleParityFixture()

  it.each(['queued', 'starting'] as const)('Stop from %s does not manufacture native cancellation before settlement', async (initial) => {
    const db = fixtures.database()
    const t = await currentRepositoryFixture(db), f = t.f
    const owner = await t.repository.acquireOwnership(f.run.id, () => undefined)
    if (!owner) throw new Error('Expected actual Run ownership')
    fixtures.closeAfterEach(() => owner.release())
    const store = await t.repository.repeat(owner), { compare } = await graphParity(db.pool, f.scope)
    const admitted = await store.admit({ nodeId: f.version.entryNodeId, occurrence: null }, () => candidateFor(f))
    if (admitted.kind !== 'admitted') throw new Error('Expected current queue admission')
    if (initial === 'starting') await store.claimLaunch(admitted.execution.id, { workingDirectory: f.run.executionLocation!.rootPath,
      runtimeDirectory: repeatRuntimeDirectory(db.directory, f.scope, admitted.execution) })
    const before = (await store.readExecution(admitted.execution.id)).execution
    await compare(); await t.stop()
    const stopped = await compare()
    expect(stopped.state.run.stopRequested).toBe(true)
    expect((await store.readExecution(admitted.execution.id)).execution).toEqual(before)
    expect(stopped.state.nodes.every((node) => node.state.lifecycle !== 'canceled')).toBe(true)
    await t.stop()
    expect((await compare()).asOfSequence).toBe(stopped.asOfSequence)
    await t.repository.settleOrphan(f.run.id, owner, true)
    expect((await compare()).state.run.outcome).toBe('canceled')
    expect((await store.readExecution(admitted.execution.id)).execution.result?.outcome).toBe('canceled')
  }, 60000)
})
