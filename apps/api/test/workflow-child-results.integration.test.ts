import { describe, expect, it } from 'vitest'
import { WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('hierarchy child feedback', () => {
  it('passes the full child deliverable and detailed findings to the parent continuation', async () => {
    const findings = ['The retry path loses the original owner after the browser preparation fails. '.repeat(8)]
    const deliverable = { files: ['src/worker.ts'], details: 'The tested implementation and its remaining defect.' }
    const continuations: ReturnType<typeof WorkActivationInputSchema.parse>[] = []
    const f = await checkpointRuntimeFixture(1, 1, { fixture: hierarchyRuntimeFixture(), approvalNodeIds: [], collaborationPorts: {},
      outputFor: (node, request) => {
        const input = WorkActivationInputSchema.parse(request.input)
        if (node === 'build' && input.work.kind === 'hierarchy_group') continuations.push(input)
        const result = coordinationOutput(node, request, node === 'master' ? { select: ['build'] } : {})
        return node === 'builder' ? { ...result, routing: { ...result.routing, outcome: 'needs_changes' },
          data: { latestDeliverable: deliverable, remainingFindings: findings }, summary: 'Review needs changes' } : result
      } })
    try {
      await f.engine.start(f.f.run.id)
      expect(continuations).toHaveLength(1)
      const input = continuations[0]!
      expect(input.work.kind).toBe('hierarchy_group')
      if (input.work.kind !== 'hierarchy_group') throw new Error('Expected child feedback')
      expect(input.work.returns).toHaveLength(1)
      expect(input.work.returns[0]).toMatchObject({ latestDeliverable: deliverable, remainingFindings: findings,
        outcome: 'needs_changes', remainingFindingsCount: 1 })
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ outcome: 'succeeded' })
    } finally { await f.close() }
  }, 60_000)
})
