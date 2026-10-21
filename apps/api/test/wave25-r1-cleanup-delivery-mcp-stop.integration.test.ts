import { afterEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { RunRecordDetailSchema } from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'

const closes: Array<() => Promise<void>> = []
afterEach(async () => { while (closes.length) await closes.pop()!(); vi.restoreAllMocks() })

describe.skipIf(!postgresEnabled)('authenticated MCP Stop after approval delivery', () => {
  it('stops a delivered approval without native acknowledgement through authenticated MCP', async () => {
    const f = await currentOperatorIntegration()
    closes.push(f.close)
    await f.engine.start(f.f.run.id)
    const interaction = (await f.pending())[0]!
    const resume = vi.spyOn(f.engine, 'resumeInteraction').mockRejectedValueOnce(
      new DomainError('ENGINE_RESTART', 'The approval callback was interrupted.', 409))
    try {
      await f.service.respond({ kind: 'user', principal: f.principal }, approvalResponse(interaction))
    } finally {
      resume.mockRestore()
    }
    expect((await f.repository.get(interaction.id))?.deliveryState).toBe('delivered')
    expect(await f.receipts()).toEqual([])
    const reader = await f.access.issue({ name: 'Run reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['runs:read'], scope: { runIds: [f.f.run.id] } }] })
    const monitor = await f.connect(reader.token)
    const input = { workspaceId: f.f.scope.workspaceId, runId: f.f.run.id, commandId: randomUUID() }
    const denied = await monitor.callTool({ name: 'run_stop', arguments: input })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    expect(await f.runs.hasRequestedStop(input.runId)).toBe(false)
    const stopped = await f.client.callTool({ name: 'run_stop', arguments: input })
    expect(stopped.isError).not.toBe(true)
    expect(decodeMcpToolResult(stopped)).toMatchObject({ status: 'accepted', processStopped: false })
    await vi.waitFor(async () => {
      expect((await f.runs.get(input.runId))?.outcome).toBe('canceled')
      expect(await f.runs.hasPendingCleanup(input.runId)).toBe(false)
    }, { timeout: 60000, interval: 50 })
    const record = await monitor.callTool({ name: 'run_record_get', arguments: {
      workspaceId: input.workspaceId, runId: input.runId,
    } })
    expect(record.isError).not.toBe(true)
    expect(RunRecordDetailSchema.parse(decodeMcpToolResult(record))).toMatchObject({
      run: { executionState: 'completed', outcome: 'canceled' }, stopRequested: true, cleanupPending: false,
    })
    const replay = await f.client.callTool({ name: 'run_stop', arguments: input })
    expect(decodeMcpToolResult(replay)).toMatchObject({ replayed: true })
    expect(f.provider.counts.responses).toBe(1)
    expect(await f.receipts()).toEqual([])
  }, 90000)
})
