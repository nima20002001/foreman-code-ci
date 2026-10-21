import { expect, it } from 'vitest'
import { historicalChatPlacement } from './helpers/historicalChatPlacement.js'
import { workerSettingsChat } from './helpers/agentChatWorkerSettings.js'

it.each(['model', 'effort'] as const)('applies successive %s edits in the same Worker session', async setting => {
  await historicalChatPlacement(async fixture => {
    const chat = await workerSettingsChat(fixture)
    const session = chat.completed.conversation!.nativeSession
    const values = setting === 'model'
      ? [{ model: 'other-model' }, { model: 'test-model' }]
      : [{ reasoningEffort: 'medium' as const }, { reasoningEffort: 'low' as const }]
    for (const [index, changes] of values.entries()) {
      const saved = await chat.save(changes)
      const sent = await chat.send(`Continue after ${setting} edit ${index + 1}.`)
      expect(sent.state.conversation).toMatchObject({ id: chat.id,
        agentConfigurationVersionId: saved.result.value.agent.configurationVersionId, nativeSession: session })
      const calls = (await fixture.provider.calls()).filter(call => call.method === 'thread/resume'
        && call.threadId === session!.nativeSessionId)
      expect(calls.at(-1)).toMatchObject(changes)
      expect((await fixture.provider.calls()).filter(call => call.method === 'turn/start'
        && call.correlationId === `agent-chat:${chat.id}:${sent.message.requestId}`)).toHaveLength(1)
    }
    expect(await fixture.details(chat.started.run.id)).toEqual(chat.before)
  }, { includeNodeRuntimePayload: false, sourceAccessMode: 'exclusive-write' })
}, 240_000)
