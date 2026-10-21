import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { CodexAppServerSessionManager } from '../src/modules/harnesses/codexAppServer.js'
import { ActivityProductionReplay } from './helpers/activityProductionReplay.js'
import { input } from './fixtures/codex-test-helpers.js'

// Recorded protocol replay below the real adapter; no DB/provider qualification.
describe('Codex turn stream with a slow consumer', () => {
  it('delivers every frame in order when a chatty turn outpaces the consumer', async () => {
    const replay = new ActivityProductionReplay(), infrastructure = replay.infrastructure()
    if (infrastructure.mode !== 'replay') throw new Error('Expected explicit recorded replay.')
    const manager = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined, undefined, 'none', undefined, infrastructure.codex)
    try {
      const source = input('/recorded-workspace'); delete source.environment
      const session = await manager.createSession(source)
      const iterator = manager.startTurn(session, { prompt: 'Chatty turn', clientCorrelationId: 'chatty-A' })[Symbol.asyncIterator]()
      const first = await iterator.next()
      assert.equal(first.done, false)
      const start = replay.starts[0]!
      // Far more frames than the idle retention window arrive while the consumer is busy persisting.
      const deltas = 5_000
      for (let index = 0; index < deltas; index += 1) replay.append(session.nativeSessionId, start.nativeTurnId, `d${index};`)
      replay.complete(session.nativeSessionId, start.nativeTurnId, 'done')

      const sequences = [first.value!.sequence]
      const received: string[] = []
      for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
        sequences.push(next.value.sequence)
        const delta = next.value.payload.delta
        if (next.value.payload.nativeMethod === 'item/agentMessage/delta' && typeof delta === 'string') received.push(delta)
      }
      sequences.forEach((sequence, index) => assert.equal(sequence, sequences[0]! + index))
      assert.equal(received.length, deltas)
      assert.equal(received.join(''), Array.from({ length: deltas }, (_, index) => `d${index};`).join(''))
      assert.ok((await manager.history(session)).terminalResult)
    } finally { await manager.dispose() }
  })
})
