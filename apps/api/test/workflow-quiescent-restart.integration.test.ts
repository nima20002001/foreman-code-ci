import { expect, it } from 'vitest'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { settleWorkForRestart } from '../src/modules/runs/workflowLifecycle.js'

it('preserves an ordinary workflow before native admission and starts it once after restart', async () => {
  const f = await checkpointRuntimeFixture(1, 1, { approvalNodeIds: [] })
  const owner = await f.runs.acquireOwnership(f.f.run.id, () => undefined)
  if (!owner) throw new Error('Expected ownership of the idle fixture')
  try {
    const before = await f.runs.get(f.f.run.id)
    expect(f.f.version.definition.handoffs).toBeUndefined()
    expect(await settleWorkForRestart(owner)).toBe(true)
    expect(await f.runs.hasPendingCleanup(f.f.run.id)).toBe(false)
    expect(await f.runs.get(f.f.run.id)).toEqual(before)
    expect(f.provider.counts.starts).toBe(0)
    await owner.release()
    await f.engine.shutdown()
    const runtime = f.compose()
    await runtime.engine.start(f.f.run.id)
    expect(await runtime.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    expect(f.provider.counts.starts).toBe(f.f.version.definition.nodes.length)
    expect(new Set(f.provider.startedExecutions).size).toBe(f.provider.startedExecutions.length)
  } finally {
    await owner.release()
    await f.close()
  }
}, 60_000)
