import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { parkBeforeNativeEntry, assertSettled } from './helpers/eng07SaveAdmission.testSupport.js'
import { withCurrentRunRead } from '../src/modules/runs/currentRead.js'
import { hasWorkflowExecutionCapacityLocked } from '../src/modules/runs/workflowExecutionBudget.js'

describe.skipIf(!postgresEnabled)('workflow execution refunds', () => {
  it('refunds a committed attempt stopped before native launch and preserves its MCP history', async () => {
    const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'),
      approvalNodeIds: [] })
    const gate = parkBeforeNativeEntry(f)
    const capacity = () => withCurrentRunRead(f.db.pool, f.writer.principal,
      f.f.run.workspaceId, f.f.run.id, 'runs:read', (sql, snapshot) =>
        hasWorkflowExecutionCapacityLocked(sql, f.f.run.id, snapshot.version))
    try {
      const execution = await gate.parked
      expect(await capacity()).toBe(false)
      await f.stop()
      await f.engine.cancel(f.f.run.id)
      await gate.drive
      await assertSettled(f)
      expect(await capacity()).toBe(true)
      expect(f.provider.counts.starts).toBe(0)
      const input = { workspaceId: f.f.run.workspaceId, runId: f.f.run.id }
      const readback = await f.client.callTool({ name: 'run_get', arguments: { ...input, detail: 'full' } })
      expect(readback.isError).not.toBe(true)
      expect(decodeMcpToolResult(readback)).toMatchObject({ executions: [expect.objectContaining({
        id: execution.id, state: 'completed', result: { outcome: 'canceled' },
      })] })
      const denied = await f.access.issue({ name: 'Other workspace reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000),
        grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['other-workspace'] } }] })
      const client = await f.connect(denied.token)
      expect((await client.callTool({ name: 'run_get', arguments: { ...input, detail: 'full' } })).isError).toBe(true)
      expect(await capacity()).toBe(true)
    } finally {
      gate.release()
      await gate.drive
      gate.restore()
      await f.close()
    }
  }, 60000)

  it('continues charging launched attempts after completion', async () => {
    const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'),
      approvalNodeIds: [] })
    try {
      await f.engine.start(f.f.run.id)
      expect(f.provider.counts.starts).toBe(1)
      expect(await withCurrentRunRead(f.db.pool, f.writer.principal, f.f.run.workspaceId, f.f.run.id,
        'runs:read', (sql, snapshot) => hasWorkflowExecutionCapacityLocked(sql, f.f.run.id, snapshot.version)))
        .toBe(false)
    } finally { await f.close() }
  }, 60000)
})
