import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { AgentMutationResultSchema, ManagedAgentDetailSchema } from '@foreman-code/contracts/management'
import { HostHarnessOverrideListSchema, HostHarnessOverrideSaveResultSchema,
  HostHarnessInstanceCheckResultSchema } from '@foreman-code/contracts/harness-registry'
import type { HarnessConfiguration } from '@foreman-code/contracts'
import { historicalChatSource, forkHistoricalChat, waitForHistoricalChatTurn } from './historicalChatPlacement.js'
import type { remoteReviewProduction } from './remoteReviewProduction.js'

export async function workerSettingsChat(fixture: Awaited<ReturnType<typeof remoteReviewProduction>>) {
  const chat = await forkHistoricalChat(fixture, await historicalChatSource(fixture))
  let profile = fixture.profiles[0]!
  const save = async (changes: Partial<Pick<Extract<HarnessConfiguration, { harness: 'codex' }>, 'model' | 'reasoningEffort'>>,
    options: { replaceProfile?: boolean } = {}) => {
    const before = ManagedAgentDetailSchema.parse(await fixture.value('agent_get', {
      workspaceId: chat.workspaceId, agentId: chat.execution.agentId,
    }))
    const current = before.agent.harnessConfiguration
    if (!current || current.harness !== 'codex') throw new Error('The settings fixture requires a Codex Agent.')
    const configuration = { ...current, ...changes }
    const inventory = HostHarnessOverrideListSchema.parse(await fixture.value('harness_instances_list', {
      hostRef: profile.target.hostRef, applicationInstallationId: profile.target.applicationInstallationId,
    }))
    const latest = inventory.overrides.find(value => value.instanceId === profile.instanceId)!
    const saved = HostHarnessOverrideSaveResultSchema.parse(await fixture.value('harness_instance_save', {
      commandId: randomUUID(), instanceId: options.replaceProfile ? randomUUID() : profile.instanceId,
      expectedRevision: options.replaceProfile ? 0 : latest.revision,
      target: profile.target, presetId: profile.presetId, enabled: true, configuration,
    })).value
    const checked = HostHarnessInstanceCheckResultSchema.parse(await fixture.value('harness_instance_check', {
      commandId: randomUUID(), instanceId: saved.instanceId, expectedRevision: saved.revision, target: saved.target,
    }))
    expect(checked.proof.qualified).toBe(true)
    profile = checked.value
    const update = { workspaceId: chat.workspaceId, agentId: chat.execution.agentId, commandId: randomUUID(),
      expectedRevision: before.metadataRevision, expectedConfigurationVersionId: before.agent.configurationVersionId,
      configuration, harnessProfileSelection: {
        instanceId: profile.instanceId, instanceRevision: profile.instanceRevision, target: profile.target,
      } }
    const result = AgentMutationResultSchema.parse(await fixture.value('agent_update', update))
    return { result, update }
  }
  const send = async (content: string) => {
    const message = { requestId: randomUUID(), content, expectedConversationId: chat.id }
    await fixture.value('agent_chat_send', { workspaceId: chat.workspaceId, selection: chat.selection, message })
    return { message, state: await waitForHistoricalChatTurn(chat.read, message.requestId, 'updated Worker chat') }
  }
  return { ...chat, save, send }
}
