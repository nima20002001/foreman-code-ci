import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { historicalChatPlacement, historicalChatSource, forkHistoricalChat,
  waitForHistoricalChatTurn } from './helpers/historicalChatPlacement.js'
import { measureIntegrationPhase } from './helpers/integrationPhase.js'

it('keeps historical Worker chat readable and refuses host switching when its profile is disabled', async () => {
  await historicalChatPlacement(async fixture => {
    const source = await historicalChatSource(fixture)
    const { workspaceId, selection, read, completed, id, before, started } = await forkHistoricalChat(fixture, source)
    const followUp = { requestId: randomUUID(), content: 'Continue after recovery.', expectedConversationId: id }
    await measureIntegrationPhase('historical chat continuation send',
      () => fixture.value('agent_chat_send', { workspaceId, selection, message: followUp }))
    const resumed = await measureIntegrationPhase('historical chat continuation completion',
      () => waitForHistoricalChatTurn(read, followUp.requestId, 'Worker chat continuation'))
    expect(resumed.conversation?.nativeSession).toEqual(completed.conversation?.nativeSession)
    const profile = fixture.profiles[0]!
    await fixture.value('harness_instance_save', { commandId: randomUUID(), instanceId: profile.instanceId,
      expectedRevision: profile.revision, target: profile.target, presetId: profile.presetId,
      enabled: false, configuration: profile.configuration })
    const unavailable = await read()
    expect(unavailable.availability.canSend).toBe(false)
    expect(unavailable.conversation?.nativeSession).toEqual(resumed.conversation?.nativeSession)
    expect(unavailable.messages.some(entry => entry.content === followUp.content)).toBe(true)
    const blocked = await fixture.call('agent_chat_send', { workspaceId, selection,
      message: { requestId: randomUUID(), content: 'Do not change hosts.', expectedConversationId: id } })
    expect(blocked.isError).toBe(true)
    expect((await fixture.provider.calls()).filter(call => call.forkedSession)).toHaveLength(1)
    expect(await fixture.details(started.run.id)).toEqual(before)
  })
}, 240_000)
