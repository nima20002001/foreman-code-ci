import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalAtomicSetup, decision } from './helpers/approvalAtomic.js'

const setup = approvalAtomicSetup()

describe.skipIf(!postgresEnabled)('approval delivery', { timeout: 60000 }, () => {
  it('missing native receipt stays uncertain and retains the same reconciliation attempt', async () => {
    const f = await setup()
    await decision(f); await f.settle()
    const first = (await f.repository.delivery.claim(f.interaction.id, 'missing-receipt'))!
    const uncertain = await f.repository.delivery.finish(first, async () => ({ state: 'delivered' }))
    expect(uncertain.deliveryState).toBe('uncertain')
    const retry = (await f.repository.delivery.claim(f.interaction.id, 'reconcile-receipt'))!
    expect(retry).toMatchObject({ mode: 'reconcile', attempt: first.attempt, correlationId: first.correlationId })
    expect(f.counts().responses).toBe(0)
    expect(await f.receipts()).toHaveLength(0)
  })
})
