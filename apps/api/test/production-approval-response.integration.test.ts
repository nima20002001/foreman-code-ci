import { afterEach, describe, expect, it } from 'vitest'
import { DurableInteractionSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { admittedRun, closeActivityReplay, setup } from './helpers/activityReplayFixture.js'
import { approvalResponse } from './helpers/approvalResponse.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { readUntil } from './helpers/observableCondition.js'

afterEach(closeActivityReplay)

describe('Production approval response composition', () => {
  it('delivers an authenticated MCP decision and resumes its persisted Run', async () => {
    const f = await setup({ approvalPolicy: 'on-request' })
    const started = await admittedRun(f, 'approval')
    const runId = started.run.id
    const pending = await readUntil(async () => {
      const rows = await f.db.pool.query('select record from durable_interactions where run_id=$1', [runId])
      return rows.rows.map(row => DurableInteractionSchema.parse(row.record))
    }, interactions => interactions.length === 1 && Boolean(interactions[0]?.graphInterruptId),
    { timeoutMs: 5000, description: 'persisted approval checkpoint' })
    const interaction = pending[0]!
    const input = approvalResponse(interaction)
    const reader = await f.access.issue({ name: 'Approval reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['interactions:read'], scope: {} }] })
    await expectMcpAccessDenied(f.call('interaction_respond', input, reader.token))
    expect(f.replay.responses).toEqual([])
    const read = await f.call('interaction_get', { interactionId: interaction.id })
    expect(read.isError, JSON.stringify(read)).not.toBe(true)
    const native = f.replay.starts.find(turn => turn.correlationId === `execution:${interaction.executionId}`)!
    const channel = f.replay.channels.get(native.sessionId)!
    const notify = channel.notify
    channel.notify = (method, payload) => {
      if (method !== 'serverRequest/resolved') {
        notify(method, payload)
        return
      }
      setImmediate(() => {
        notify(method, payload)
        f.replay.commandCompleted(native.sessionId, native.nativeTurnId)
        f.replay.complete(native.sessionId, native.nativeTurnId, 'Approved workflow finished')
      })
    }
    const answered = await f.call('interaction_respond', input)
    expect(answered.isError, JSON.stringify(answered)).not.toBe(true)
    expect(decodeMcpToolResult(answered), JSON.stringify(decodeMcpToolResult(answered))).toMatchObject({ interaction: {
      id: interaction.id, runId, deliveryState: 'delivered', status: 'delivered', selectedOptionId: input.optionId,
    } })
    const readback = await f.call('interaction_get', { interactionId: interaction.id })
    expect(decodeMcpToolResult(readback)).toMatchObject({ interaction: { id: interaction.id, deliveryState: 'delivered' } })
    const detail = await readUntil(async () => {
      const result = await f.http('GET', `/api/management/workspaces/${f.saved.scope.workspaceId}/runs/${runId}`)
      expect(result.statusCode, result.body).toBe(200)
      return SavedRunDetailsSchema.parse(result.json())
    }, result => result.run.executionState === 'completed', { timeoutMs: 5000, description: 'resumed workflow completion' })
    expect(detail.run.outcome).toBe('succeeded')
    expect(detail.executions).toMatchObject([{ id: interaction.executionId, state: 'completed', result: { outcome: 'succeeded' } }])
    const stored = (await f.db.pool.query('select record from durable_interactions where id=$1', [interaction.id])).rows[0]!.record
    expect(stored).toMatchObject({ deliveryState: 'delivered', selectedOptionId: input.optionId })
    expect(f.replay.starts).toHaveLength(1)
  }, 60_000)
})
