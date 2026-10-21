import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { OperatorConversationStateSchema } from '@foreman-code/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { closeActivityReplay, setup, eventually } from './helpers/activityReplayFixture.js'

afterEach(closeActivityReplay)

describe.skipIf(!postgresEnabled)('Production activity replay: operator-restart', { timeout: 120000 }, () => {
  it('Operator: current callback, empty history after restart, consumed answer and owned HTTP/MCP readback', async () => {
    const f = await setup()
    const created = await f.http('POST', '/api/operator/conversations', { title: 'Recorded Operator request' })
    expect(created.statusCode, created.body).toBe(201)
    const id = created.json().conversation.id
    const sent = await f.http('POST', `/api/operator/conversations/${id}/messages`, { requestId: 'operator-A', content: 'recorded active message' })
    expect(sent.statusCode, sent.body).toBe(202)
    const read = async () => OperatorConversationStateSchema.parse((await f.http('GET', `/api/operator/conversations/${id}`)).json())
    const active = await eventually(read, (state) => !!state.activitySnapshot?.active[0]?.native?.turnId)
    const native = active.activitySnapshot!.active[0]!.native!
    await f.replay.ask(native.sessionId, native.turnId!)
    const waiting = await eventually(read, (state) => state.pendingInteraction !== undefined)
    expect(waiting.responseAvailability?.available).toBe(true)
    expect(waiting.activitySnapshot!.pendingInteractions[0]!.providerAcknowledged).toBe(false)
    const readback = await f.call('operator_chat_get', { conversationId: id })
    expect(readback.isError).not.toBe(true)
    expect(OperatorConversationStateSchema.parse(decodeMcpToolResult(readback)).activitySnapshot).toEqual(waiting.activitySnapshot)
    f.replay.disconnect(native.sessionId)
    const lost = await eventually(read, (state) => state.responseAvailability?.available === false)
    expect(lost.pendingInteraction).toEqual(waiting.pendingInteraction)
    expect(lost.responseAvailability?.message).toMatch(/unavailable|reconcile|cannot inspect/i)
    const effects = f.replay.responses.length
    await f.restart()
    const restarted = await read()
    expect(restarted.pendingInteraction?.turn.nativeRequestId).toBe(waiting.pendingInteraction!.turn.nativeRequestId)
    expect(restarted.responseAvailability?.available).toBe(false)
    expect(f.replay.responses.length).toBe(effects)
  })
})
