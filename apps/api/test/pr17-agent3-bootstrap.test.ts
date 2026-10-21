import { EventEmitter } from 'node:events'
import type { ServerResponse } from 'node:http'
import { describe, expect, it } from 'vitest'
import type { OperatorConversationState } from '@foreman-code/contracts'
import { operatorChatBootstrapFrame, OPERATOR_BOOTSTRAP_FRAME_BYTES } from '../src/modules/conversations/operatorChatBootstrap.js'
import { createSseWriter } from '../src/routes/sseWriter.js'

function state(): OperatorConversationState {
  return { conversation: { id: 'chat', agentId: 'operator', scope: 'application', status: 'open' },
    messages: [], activeRequestId: 'request', turnState: 'active', revision: 42 }
}
function connection() {
  const response = Object.assign(new EventEmitter(), { destroyed: false, writableEnded: false,
    write: (frame: string) => { frames.push(frame); return true } })
  const frames: string[] = []
  let stopped = false
  const writer = createSseWriter(response as unknown as ServerResponse, () => true, () => { stopped = true })
  return { writer, frames, stopped: () => stopped }
}
describe('F18 bounded bootstrap through the real SSE writer', () => {
  it('sends the complete recent snapshot with authoritative revision', () => {
    const c = connection(), snapshot = state()
    c.writer.write(operatorChatBootstrapFrame(snapshot))
    expect(c.stopped()).toBe(false)
    expect(c.frames[0]).toContain('event: snapshot')
    expect(c.frames[0]).toContain('"activeRequestId":"request"')
    expect(c.frames[0]).toContain('id: 42')
    c.writer.close()
  })
  it('can establish and reconnect even if a native result alone exceeds the old frame limit', () => {
    const snapshot = state()
    snapshot.lastResult = { outcome: 'succeeded', output: { text: 'x'.repeat(9 * 1024 * 1024) } }
    for (let reconnect = 0; reconnect < 2; reconnect++) {
      const c = connection(), frame = operatorChatBootstrapFrame(snapshot)
      c.writer.write(frame)
      expect(c.stopped()).toBe(false); expect(c.frames).toHaveLength(1)
      expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(OPERATOR_BOOTSTRAP_FRAME_BYTES)
      expect(frame).toContain('event: state')
      expect(frame).toContain('"revision":42')
      expect(frame).toContain('"activeRequestId":"request"')
      expect(frame).toContain('"snapshotRequired":true')
      c.writer.write(': heartbeat\n\n')
      expect(c.frames).toHaveLength(2)
      c.writer.close()
    }
  })
  it('does not misrepresent an oversized pending approval as absent', () => {
    const snapshot = state()
    snapshot.pendingInteraction = { session: { harness: 'codex', providerVersion: 'v', nativeSessionId: 'session' },
      turn: { nativeTurnId: 'turn', nativeRequestId: 'ask' }, nativeRequestType: 'approval',
      request: { detail: 'x'.repeat(9 * 1024 * 1024) }, responseOptions: [
        { optionId: 'approve', semantic: 'approve_once', label: 'Approve once', persistence: 'request',
          affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: false },
      ] }
    const frame = operatorChatBootstrapFrame(snapshot)
    expect(frame).toContain('"hasPendingInteraction":true')
    expect(frame).toContain('"snapshotRequired":true')
    expect(frame).not.toContain('event: snapshot')
    expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(OPERATOR_BOOTSTRAP_FRAME_BYTES)
  })
})
