import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AgentMutationResultSchema, ManagedAgentDetailSchema } from '@foreman-code/contracts/management'
import { HostHarnessOverrideSaveResultSchema, HostHarnessInstanceCheckResultSchema }
  from '@foreman-code/contracts/harness-registry'
import { WorkerConversationBindingSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { identityAlive } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { historicalChatPlacement, historicalChatSource, forkHistoricalChat,
  waitForHistoricalChatTurn } from './helpers/historicalChatPlacement.js'

it('changes the model on the same Worker chat session and closes the previous native process', async () => {
  await historicalChatPlacement(async fixture => {
    const chat = await forkHistoricalChat(fixture, await historicalChatSource(fixture))
    const { workspaceId, selection, read, completed, id } = chat
    const sessionId = completed.conversation!.nativeSession!.nativeSessionId
    const original = fixture.registry.snapshot().launches.filter(launch =>
      launch.owner === `conversation:${id}` && launch.lifecycle === 'active' && launch.provider)
    expect(original).toHaveLength(1)
    expect(identityAlive(original[0]!.provider!)).toBe(true)

    const before = ManagedAgentDetailSchema.parse(await fixture.value('agent_get', {
      workspaceId, agentId: chat.execution.agentId,
    }))
    const stored = (await fixture.db.pool.query<{ record: unknown }>(
      'select record from agent_configuration_versions where id=$1',
      [completed.conversation!.agentConfigurationVersionId])).rows[0]!
    const accepted = AgentConfigurationVersionSchema.parse(stored.record)
    const originalBinding = WorkerConversationBindingSchema.parse((await fixture.db.pool.query<{
      worker_conversation_binding: unknown
    }>('select worker_conversation_binding from operator_conversations where id=$1', [id])).rows[0]!.worker_conversation_binding)
    const configuration = { ...accepted.harness, model: 'other-model' }
    const profile = fixture.profiles[0]!
    const savedProfile = HostHarnessOverrideSaveResultSchema.parse(await fixture.value('harness_instance_save', {
      commandId: randomUUID(), instanceId: profile.instanceId, expectedRevision: profile.revision,
      target: profile.target, presetId: profile.presetId, enabled: true, configuration,
    })).value
    const checked = HostHarnessInstanceCheckResultSchema.parse(await fixture.value('harness_instance_check', {
      commandId: randomUUID(), instanceId: savedProfile.instanceId, expectedRevision: savedProfile.revision,
      target: savedProfile.target,
    }))
    expect(checked.proof.qualified).toBe(true)
    const saved = AgentMutationResultSchema.parse(await fixture.value('agent_update', {
      workspaceId, agentId: chat.execution.agentId, commandId: randomUUID(),
      expectedRevision: before.metadataRevision, expectedConfigurationVersionId: before.agent.configurationVersionId,
      configuration, harnessProfileSelection: {
        instanceId: checked.value.instanceId, instanceRevision: checked.value.instanceRevision,
        target: checked.value.target,
      },
    }))
    const followUp = { requestId: randomUUID(), content: 'Continue with the selected model.', expectedConversationId: id }
    await fixture.value('agent_chat_send', { workspaceId, selection, message: followUp })
    const continued = await waitForHistoricalChatTurn(read, followUp.requestId, 'changed-model Worker turn')
    expect(continued.conversation).toMatchObject({ id,
      agentConfigurationVersionId: saved.value.agent.configurationVersionId,
      nativeSession: { nativeSessionId: sessionId } })
    const row = (await fixture.db.pool.query<{ worker_conversation_binding: unknown }>(
      'select worker_conversation_binding from operator_conversations where id=$1', [id])).rows[0]!
    const binding = WorkerConversationBindingSchema.parse(row.worker_conversation_binding)
    expect(binding.profile.target.hostRef).toEqual(fixture.hostRef)
    expect(binding.owner.configurationVersionId).toBe(saved.value.agent.configurationVersionId)
    expect(binding.owner.configurationHash).not.toBe(originalBinding.owner.configurationHash)
    const pinned = AgentConfigurationVersionSchema.parse((await fixture.db.pool.query<{ record: unknown }>(
      'select record from agent_configuration_versions where id=$1',
      [binding.owner.configurationVersionId])).rows[0]!.record)
    expect(pinned.harness.model).toBe('other-model')
    expect(binding.owner.configurationHash).toBe(commandInputHash(pinned))
    const calls = await fixture.provider.calls()
    expect(calls.filter(call => call.method === 'turn/start'
      && call.correlationId === `agent-chat:${id}:${followUp.requestId}`)).toHaveLength(1)
    expect(calls).toContainEqual(expect.objectContaining({ method: 'thread/resume',
      threadId: sessionId, model: 'other-model' }))
    const launches = fixture.registry.snapshot().launches
    expect(fixture.registry.closedRegistration(original[0]!.owner, original[0]!.launchId))
      .toMatchObject({ lifecycle: 'closed', closureEvidence: expect.any(String) })
    expect(identityAlive(original[0]!.provider!)).toBe(false)
    expect(launches.filter(launch => launch.owner === `conversation:${id}` && launch.lifecycle === 'active'))
      .toHaveLength(1)
    expect(await fixture.details(chat.started.run.id)).toEqual(chat.before)
  }, { includeNodeRuntimePayload: false })
}, 240_000)
