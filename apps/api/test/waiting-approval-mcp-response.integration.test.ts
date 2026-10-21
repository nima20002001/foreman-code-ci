import { randomUUID } from 'node:crypto'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { expect, it, vi } from 'vitest'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { approvalResponse } from './helpers/eng06ApprovalFaults.js'
import { respondWaitingApproval } from './helpers/respondWaitingApproval.js'

it('delivers once through a scoped MCP caller and reads back the response after retry', async () => {
  const f = await currentOperatorIntegration({ interactions: true })
  try {
    await f.engine.start(f.f.run.id)
    const [pending] = (await f.pending()).filter(item => item.status === 'pending')
    if (!pending?.executionId) throw new Error('Expected a pending requester')
    const counts = { ...f.provider.counts }
    const { interactionId, optionId, expectedRevision } = approvalResponse(pending)
    const input = { interactionId, optionId, expectedRevision }
    const scoped = await f.access.issue({
      name: 'Scoped approver', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { runIds: [f.f.run.id] } }],
    })
    const outside = await f.access.issue({
      name: 'Other Run approver', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: { runIds: [randomUUID()] } }],
    })
    const denied = await f.connect(outside.token)
    const rejected = await denied.callTool({ name: 'interaction_respond', arguments: input })
    expect(rejected.isError).toBe(true)
    expect(decodeMcpToolResult(rejected)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
    expect(await f.repository.get(pending.id)).toMatchObject({ status: 'pending' })
    expect(f.provider.counts.responses).toBe(counts.responses)

    const client = await f.connect(scoped.token)
    await respondWaitingApproval({ ...f, client }, pending, 'mcp')
    await vi.waitFor(async () => {
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    }, { timeout: 10_000, interval: 10 })
    const retry = await client.callTool({ name: 'interaction_respond', arguments: input })
    expect(retry.isError).not.toBe(true)
    expect(decodeMcpToolResult(retry)).toMatchObject({ replayed: true,
      interaction: { id: pending.id, deliveryState: 'delivered', selectedOptionId: optionId } })
    const readback = await client.callTool({ name: 'interaction_get', arguments: { interactionId } })
    expect(readback.isError).not.toBe(true)
    expect(decodeMcpToolResult(readback)).toMatchObject({ interaction: {
      id: pending.id, deliveryState: 'delivered', selectedOptionId: optionId,
      nativeSessionId: pending.nativeSessionId, executionId: pending.executionId,
    } })
    expect(f.provider.counts.responses).toBe(counts.responses + 1)
  } finally { await f.close() }
}, 60_000)
