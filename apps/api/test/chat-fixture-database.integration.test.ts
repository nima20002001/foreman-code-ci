import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { ReadSelectedRunChatResponseSchema } from '@foreman-code/contracts/selected-run-chat'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  closeActivityReplay, completedRun, eventually, setup,
} from './helpers/activityReplayFixture.js'
import {
  historicalFixture, openHistoricalApi, readSnapshot, runA, targetFor, type HistoricalApi,
} from './helpers/sch12HistoricalRuns.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

afterEach(async () => {
  try { await closeActivityReplay() } finally { vi.restoreAllMocks() }
})

describe.skipIf(!postgresEnabled)('chat fixture database connections', { timeout: 120_000 }, () => {
  it('reopened HTTP and MCP services read the seeded Run and retain scope denial', async () => {
    const fixture = await historicalFixture()
    let api: HistoricalApi | undefined
    try {
      await runA(fixture)
      api = await openHistoricalApi(fixture)
      const target = targetFor(fixture)
      const snapshot = await readSnapshot(api, target)
      expect(snapshot).toMatchObject({ kind: 'available', runId: target.runId })
      const denied = await api.access.issue({
        name: 'Reader outside the fixture workspace', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: ['runs:read'], scope: { workspaceIds: ['other-workspace'] } }],
      })
      const client = await api.connect(denied.token)
      const deniedRead = await client.callTool({ name: 'run_board_snapshot_get', arguments: { ...target } })
      expect(deniedRead.isError).toBe(true)
      expect(deniedRead.structuredContent).toBeUndefined()
      expect(await readSnapshot(api, target)).toEqual(snapshot)
    } finally {
      try { await api?.close() } finally { await fixture.close() }
    }
  })

  it('production Run cleanup releases its persisted source for selected chat through HTTP and MCP', async () => {
    const fixture = await setup()
    const details = await completedRun(fixture)
    const { workspaceId, workflowId, id: runId } = details.run
    await eventually(async () => {
      const response = await fixture.http('GET', `/api/management/workspaces/${workspaceId}/runs/${runId}`)
      expect(response.statusCode, response.body).toBe(200)
      return SavedRunDetailsSchema.parse(response.json())
    }, (record) => record.cleanupPending === false)
    const execution = details.executions[0]!
    const selection = { workflowId, runId, workflowNodeId: execution.workflowNodeId, executionId: execution.id }
    const path = `/api/workspaces/${workspaceId}/agent-chat/workflows/${workflowId}/runs/${runId}`
      + `/nodes/${execution.workflowNodeId}?executionId=${execution.id}`
    const response = await fixture.http('GET', path)
    expect(response.statusCode, response.body).toBe(200)
    const selected = ReadSelectedRunChatResponseSchema.parse(response.json())
    expect(selected).toMatchObject({ kind: 'selected', state: { availability: { canSend: true } } })
    const read = await fixture.call('agent_chat_read', { workspaceId, selection })
    expect(read.isError).not.toBe(true)
    expect(ReadSelectedRunChatResponseSchema.parse(decodeMcpToolResult(read))).toEqual(selected)
    const denied = await fixture.call('agent_chat_read', { workspaceId, selection }, fixture.denied.token)
    expect(denied.isError).toBe(true)
    await fixture.restart()
    const retained = await fixture.http('GET', path)
    expect(retained.statusCode, retained.body).toBe(200)
    expect(ReadSelectedRunChatResponseSchema.parse(retained.json())).toEqual(selected)
  })
})
