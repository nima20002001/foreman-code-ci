import { expect, it } from 'vitest'
import type { NativeSessionReference } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../src/modules/harnesses/port.js'
import { SingleWriterSessionManager } from '../src/modules/interactions/sessionWriter.js'
import { nativeLanes } from './helpers/nativeLanes.js'

it('persists the acknowledged native turn before a running result can be observed', async () => {
  const coordination = nativeLanes()
  const session: NativeSessionReference = {
    harness: 'codex', nativeSessionId: 'original-session', providerVersion: '0.154.0',
  }
  const manager = {
    harness: 'codex',
    createSession: async () => session,
    reconcile: async () => ({ events: [], pendingInteractions: [] }),
    async *startTurn(_session, input) {
      await input.onSubmitted?.('original-turn')
      const saved = await coordination.getLane('codex', session.nativeSessionId)
      expect(saved?.correlationId).toBe('execution:original')
      expect(saved?.currentTurnOrMessageId).toBe('original-turn')
      expect(saved?.leaseToken).toBeTruthy()
      yield { sequence: 0, type: 'turn.started', occurredAt: '2026-10-04T00:00:00.000Z',
        payload: { nativeTurnId: 'original-turn' } }
    },
  } satisfies Pick<NativeHarnessSessionManager, 'harness' | 'createSession' | 'reconcile' | 'startTurn'>
  const writer = new SingleWriterSessionManager(manager as unknown as NativeHarnessSessionManager, coordination, 'agent')
  await writer.createSession({} as Parameters<NativeHarnessSessionManager['createSession']>[0])
  const events = []
  for await (const event of writer.startTurn(session, {
    prompt: 'original prompt', clientCorrelationId: 'execution:original',
  })) {
    expect((await coordination.getLane('codex', session.nativeSessionId))?.currentTurnOrMessageId)
      .toBe('original-turn')
    events.push(event.type)
  }
  expect(events).toEqual(['turn.started'])
})
