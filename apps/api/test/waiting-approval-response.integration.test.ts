import { expect, it, vi } from 'vitest'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import { respondWaitingApproval } from './helpers/respondWaitingApproval.js'

it.each(['http', 'mcp'] as const)('delivers a waiting approval through %s and resumes the requester', async transport => {
  const f = await currentOperatorIntegration({ interactions: true })
  try {
    await f.engine.start(f.f.run.id)
    const [pending] = (await f.pending()).filter(item => item.status === 'pending')
    if (!pending?.executionId) throw new Error('Expected a pending requester')
    const counts = { ...f.provider.counts }
    const reader = await f.access.issue({ name: 'Approval reader', audience: 'operator',
      grants: [{ actions: ['interactions:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const denied = await f.connect(reader.token)
    const { interactionId, optionId, expectedRevision } = approvalResponse(pending)
    expect((await denied.callTool({ name: 'interaction_respond',
      arguments: { interactionId, optionId, expectedRevision } })).isError)
      .toBe(true)
    expect(await f.repository.get(pending.id)).toMatchObject({ status: 'pending' })
    expect(f.provider.counts.responses).toBe(counts.responses)
    await respondWaitingApproval(f, pending, transport)
    await vi.waitFor(async () => {
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    }, { timeout: 10_000, interval: 10 })
    expect(await f.repository.get(pending.id)).toMatchObject({ deliveryState: 'delivered',
      nativeSessionId: pending.nativeSessionId, executionId: pending.executionId })
    expect(f.provider.counts.responses).toBe(counts.responses + 1)
  } finally { await f.close() }
}, 60_000)
