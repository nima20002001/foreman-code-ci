import { describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalAtomicSetup, decision } from './helpers/approvalAtomic.js'

const setup = approvalAtomicSetup()

describe.skipIf(!postgresEnabled)('approval delivery', { timeout: 60000 }, () => {
  it('a changed requester generation fences a delivery owner before native writes', async () => {
    const f = await setup()
    const snapshot = await f.runs.getRepeatSnapshot(f.run.id)
    expect(snapshot.configurations.find(configuration => configuration.agentId === f.reviewer.agentId))
      .toMatchObject({
        harness: { sandbox: 'read-only', advanced: { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' } },
      })
    expect(snapshot.configurations.find(configuration => configuration.agentId === f.requester.agentId))
      .toMatchObject({
        harness: { sandbox: 'read-only', advanced: { approvalPolicy: 'on-request', approvalsReviewer: 'user' } },
      })
    await decision(f); await f.settle()
    const claim = (await f.repository.delivery.claim(f.interaction.id, 'old-generation'))!
    await f.pool.query("update native_session_lanes set record=jsonb_set(record,'{connectionGeneration}',to_jsonb((record->>'connectionGeneration')::integer+1)) where owner_agent_id=$1", [f.requester.agentId])
    let writes = 0
    await expect(f.repository.delivery.finish(claim, async () => { writes++; return { state: 'delivered' } })).rejects.toBeDefined()
    expect(writes).toBe(0)
    expect(f.counts().responses).toBe(0)
  })
})
