import { expect, vi } from 'vitest'
import { readUntil } from './observableCondition.js'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'
import { expectMcpAccessDenied } from './deniedMcpTool.js'
import { approvalResponse } from './eng06ApprovalFaults.js'
import { respondWaitingApproval } from './respondWaitingApproval.js'
import { OperatorInteractionService } from '../../src/modules/interactions/operator.js'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../../src/modules/access/workerCredentials.js'

export async function assertWaitingApprovalCredentialLifetime(transport: 'http' | 'mcp'): Promise<void> {
  const f = await currentOperatorIntegration({ credentialTtlMs: 60_000, interactions: true })
  try {
    let runtime = { engine: f.engine, service: f.service }
    await runtime.engine.start(f.f.run.id)
    const [pending] = (await f.pending()).filter(item => item.status === 'pending')
    if (!pending?.executionId) throw new Error('Expected a pending requester')
    const execution = await f.runs.getExecution(pending.executionId)
    const counts = { ...f.provider.counts }
    const read = async () => (await f.db.pool.query<{ principal_id: string; token_hash: string; generation: string;
      expires_at: Date; live: boolean }>(`select b.principal_id,p.token_hash,
        b.approval_connection_generation::text as generation,p.expires_at,
        p.expires_at>clock_timestamp() and p.revoked_at is null and b.revoked_at is null as live
        from worker_credential_bindings b join management_principals p on p.id=b.principal_id
        where b.execution_id=$1`, [pending.executionId])).rows[0]!
    const original = await read()
    const variables = await f.provider.connection().originalEnvironment!({ harness: pending.harness,
      providerVersion: pending.providerVersion, nativeSessionId: pending.nativeSessionId })
    const token = variables?.[APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]
    if (!token) throw new Error('Expected the original process token')
    if (transport === 'mcp') {
      await runtime.engine.shutdown()
      runtime = f.compose()
      Object.assign(f.services, { interactions: new OperatorInteractionService(runtime.service) })
      await runtime.engine.prepareInteraction(pending)
    }
    await readUntil(read, lease => lease.expires_at.getTime() > original.expires_at.getTime() + 125_000,
      { timeoutMs: 140_000, description: 'two requester credential lifetimes' })
    expect(await read()).toMatchObject({ principal_id: original.principal_id, token_hash: original.token_hash,
      generation: original.generation, live: true })
    expect((await read()).expires_at.getTime()).toBeGreaterThan(original.expires_at.getTime())
    expect((await f.access.authenticate(token, 'worker')).id).toBe(original.principal_id)
    expect(await f.runs.getExecution(pending.executionId)).toEqual(execution)
    const reader = await f.access.issue({ name: 'Approval reader', audience: 'operator',
      grants: [{ actions: ['interactions:read'], scope: {} }], expiresAt: new Date(Date.now() + 600_000) })
    const denied = await f.connect(reader.token)
    const { interactionId, optionId, expectedRevision } = approvalResponse(pending)
    await expectMcpAccessDenied(denied.callTool({ name: 'interaction_respond',
      arguments: { interactionId, optionId, expectedRevision } }))
    await respondWaitingApproval(f, pending, transport)
    await vi.waitFor(async () => {
      expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    }, { timeout: 10_000, interval: 10 })
    expect(f.provider.counts).toEqual({ ...counts, responses: counts.responses + 1,
      attaches: counts.attaches + (transport === 'mcp' ? 1 : 0) })
    expect(await f.repository.get(pending.id)).toMatchObject({ deliveryState: 'delivered', nativeSessionId: pending.nativeSessionId })
  } finally { await f.close() }
}
