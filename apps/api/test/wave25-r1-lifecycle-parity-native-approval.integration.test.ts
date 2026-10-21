import { describe, expect, it } from 'vitest'
import { graphParity } from './helpers/wave25R1GraphParity.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { lifecycleParityFixture } from './helpers/lifecycleParityFixture.js'
import { checkpointRuntimeFixture } from './helpers/wave25Br1003Runtime.js'
import { approvalResponse } from './helpers/approvalResponse.js'

describe.skipIf(!postgresEnabled)('Native approval lifecycle and graph replay', () => {
  const fixtures = lifecycleParityFixture()

  it('replays actual native wait, delivery, original acknowledgement and accepted-result cuts completely', async () => {
    const f = await checkpointRuntimeFixture(1, 1, { database: fixtures.database() })
    fixtures.closeAfterEach(f.close)
    const { compare } = await graphParity(f.db.pool, f.f.scope)
    await compare()
    await f.engine.start(f.f.run.id)
    const [interaction] = await f.pending()
    if (!interaction) throw new Error('Expected a captured native approval request')
    const waiting = await compare()
    expect(waiting.state.interactions.some((item) => item.interactionId === interaction.id)).toBe(true)
    expect(waiting.state.run.pendingInteractionCount).toBe(1)
    const result = await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(interaction))
    expect(result.interaction.deliveryState).toBe('delivered')
    const completed = await compare()
    expect(completed.state.run.outcome).toBe('succeeded')
    expect(completed.state.run.pendingInteractionCount).toBe(0)
    expect(completed.state.interactions).toEqual([])
    expect(completed.state.results).toHaveLength(2)
    expect(completed.state.bindings).toHaveLength(1)
    const receipts = await f.receipts()
    await f.engine.resumeInteraction(result.interaction)
    // A terminal notification reruns cleanup and publishes its pending/finished
    // cuts, while accepted results and the original resume receipt stay fixed.
    expect((await compare()).state).toEqual(completed.state)
    expect(await f.receipts()).toEqual(receipts)
    expect(f.provider.counts).toMatchObject({ sessions: 2, starts: 2, responses: 1 })
  }, 60000)
})
