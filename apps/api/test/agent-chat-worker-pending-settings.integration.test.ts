import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AgentChatControlsStateSchema } from '@foreman-code/contracts/agent-chat'
import { ManagedAgentDetailSchema } from '@foreman-code/contracts/management'
import { historicalChatPlacement } from './helpers/historicalChatPlacement.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { workerSettingsChat } from './helpers/agentChatWorkerSettings.js'

it('reads an idle chat after saving settings without querying its superseded profile', async () => {
  await historicalChatPlacement(async fixture => {
    const chat = await workerSettingsChat(fixture)
    const saved = await chat.save({ model: 'other-model' })
    const state = await chat.read()
    expect(state.conversation!.id).toBe(chat.id)
    expect(state.messages).toEqual(chat.completed.messages)
    expect(state.availability.canSend).toBe(true)
    const target = { workspaceId: chat.workspaceId, conversationId: chat.id }
    const controls = AgentChatControlsStateSchema.parse(await fixture.value('agent_chat_controls_get', target))
    expect(controls.configuration).toMatchObject({ versionId: saved.result.value.agent.configurationVersionId,
      harness: saved.update.configuration })
    const request = { kind: 'configuration', requestId: randomUUID(),
      expectedRevision: controls.configuration!.metadataRevision,
      expectedConfigurationVersionId: controls.configuration!.versionId,
      configuration: saved.update.configuration }
    const updated = AgentChatControlsStateSchema.parse(await fixture.value('agent_chat_controls_update', { ...target, request }))
    expect(updated.configuration!.harness).toEqual(saved.update.configuration)
    const reader = await fixture.access.issue({ name: 'Chat settings reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agents:read', 'agent_chat:read'], scope: {} }] })
    await expectMcpAccessDenied(fixture.call('agent_chat_controls_update', { ...target,
      request: { ...request, requestId: randomUUID(), expectedRevision: updated.configuration!.metadataRevision,
        expectedConfigurationVersionId: updated.configuration!.versionId } }, reader.token))
    await expectMcpAccessDenied(fixture.call('agent_update', { ...saved.update, commandId: randomUUID(),
      expectedRevision: saved.result.value.metadataRevision,
      expectedConfigurationVersionId: saved.result.value.agent.configurationVersionId,
      configuration: { ...saved.update.configuration, model: 'test-model' } }, reader.token))
    const readback = ManagedAgentDetailSchema.parse(await fixture.value('agent_get', {
      workspaceId: chat.workspaceId, agentId: chat.execution.agentId,
    }))
    expect(readback.agent.configurationVersionId).toBe(updated.configuration!.versionId)
    expect((await chat.send('Use the saved model.')).state.conversation!.id).toBe(chat.id)
  }, { includeNodeRuntimePayload: false, sourceAccessMode: 'exclusive-write' })
}, 240_000)
