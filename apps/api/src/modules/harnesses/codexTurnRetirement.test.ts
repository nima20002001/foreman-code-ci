import { expect, it } from 'vitest'
import { OperatorConfigurationVersionSchema } from '@foreman-code/contracts'
import { ActivityProductionReplay } from '../../../test/helpers/activityProductionReplay.js'
import { workerConversationFixture } from '../conversations/workerFixtures.test-support.js'
import { CodexAppServerSessionManager } from './codexAppServer.js'

it('retires completed resources while the reader drains terminal events and still rejects retirement of an active turn', async () => {
  const replay = new ActivityProductionReplay()
  const f = workerConversationFixture()
  const configuration = OperatorConfigurationVersionSchema.parse({ ...f.configuration,
    harness: { ...f.configuration.harness, model: 'test-model', reasoningEffort: 'low', sandbox: 'read-only' } })
  const manager = new CodexAppServerSessionManager('/recorded-no-native-codex', undefined, undefined, undefined,
    'none', undefined, replay.infrastructure().codex)
  const session = await manager.createSession({ kind: 'operator', configuration,
    workingDirectory: f.binding.workingDirectory, correlationId: 'creation' })
  const iterator = manager.startTurn(session, { prompt: 'Reply once', clientCorrelationId: 'first' })[Symbol.asyncIterator]()
  try {
    const first = await iterator.next()
    expect(first.done).toBe(false)
    await expect(manager.retireTurn(session, 'first')).rejects.toThrow('completed owned turn')
    const nativeTurnId = replay.starts[0]!.nativeTurnId
    replay.complete(session.nativeSessionId, nativeTurnId, 'Recorded reply')
    let event = first
    while (!event.done && event.value.type !== 'turn.completed') event = await iterator.next()
    expect(event.done).toBe(false)
    await expect(manager.retireTurn(session, 'first')).resolves.toBeUndefined()
    await iterator.return?.()
    replay.nextStart = 'complete'
    const following = []
    for await (const next of manager.startTurn(session, { prompt: 'Continue', clientCorrelationId: 'second' })) {
      following.push(next)
    }
    expect(following).toContainEqual(expect.objectContaining({ type: 'item.completed' }))
    expect(replay.calls.filter(call => call.method === 'thread/start')).toHaveLength(1)
    expect(replay.calls.filter(call => call.method === 'thread/resume')).toHaveLength(0)
    expect(replay.starts).toHaveLength(2)
  } finally { await iterator.return?.(); await manager.dispose() }
})
