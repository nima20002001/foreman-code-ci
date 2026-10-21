import { expect, it } from 'vitest'
import { openRunGraphPublication, graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { readPublicProjectionLocked } from '../src/modules/run-graph/compactSnapshot.js'
import { readOperationalFailures } from '../src/modules/diagnostics/logger.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'

it.each([
  new TypeError('Publication projection failed'),
  Object.assign(new Error('Publication transaction deadlocked'), { code: '40P01' }),
])('preserves and logs an inner publication failure: %s', async failure => {
  const f = await checkpointRuntimeFixture(1, 1, { approvalNodeIds: [] })
  const owner = await f.runs.acquireOwnership(f.f.run.id, () => undefined)
  if (!owner) throw new Error('Expected fixture Run ownership')
  try {
    const before = await f.runs.getRepeatSnapshot(f.f.run.id, owner)
    await expect(owner.oneShotConnection().transaction(async sql => {
      const publication = await openRunGraphPublication(sql, f.f.scope, readPublicProjectionLocked)
      await publication.repeatChange({ evidence: { sourceKind: 'run', sourceId: 'failing-source', sourceRevision: '1' },
        sourceDigest: graphSourceDigest({ operation: 'failing-publication' }), effect: null }, owner,
      async () => { throw failure }, async () => [])
    })).rejects.toBe(failure)
    expect(await f.runs.getRepeatSnapshot(f.f.run.id, owner)).toEqual(before)
    expect(readOperationalFailures()).toContainEqual(expect.objectContaining({
      operation: 'publish run graph', lastError: failure instanceof TypeError ? 'TypeError' : 'OPERATION_FAILED',
    }))
  } finally {
    await owner.release()
    await f.close()
  }
}, 30_000)
