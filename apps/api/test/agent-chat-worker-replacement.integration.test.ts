import { expect, it } from 'vitest'
import { HostHarnessOverrideListSchema } from '@foreman-code/contracts/harness-registry'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { identityAlive } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { historicalChatPlacement } from './helpers/historicalChatPlacement.js'
import { workerSettingsChat } from './helpers/agentChatWorkerSettings.js'

it('starts a replacement Worker session with conversation history when the profile changes', async () => {
  await historicalChatPlacement(async fixture => {
    const chat = await workerSettingsChat(fixture)
    const session = chat.completed.conversation!.nativeSession
    const original = fixture.registry.snapshot().launches.find(launch => launch.owner === `conversation:${chat.id}`
      && launch.lifecycle === 'active' && launch.provider)!
    expect(original).toBeDefined()
    const saved = await chat.save({ model: 'other-model' }, { replaceProfile: true })
    const sent = await chat.send('Continue in the replacement profile.')
    expect(sent.state.conversation).toMatchObject({ id: chat.id,
      agentConfigurationVersionId: saved.result.value.agent.configurationVersionId })
    expect(sent.state.conversation!.nativeSession!.nativeSessionId).not.toBe(session!.nativeSessionId)
    expect(sent.state.messages.filter(message => message.role === 'user').map(message => message.content))
      .toEqual([chat.message.content, sent.message.content])
    expect(fixture.registry.closedRegistration(original.owner, original.launchId))
      .toMatchObject({ lifecycle: 'closed', closureEvidence: expect.any(String) })
    expect(identityAlive(original.provider!)).toBe(false)
    await fixture.restartMain({ mode: 'graceful' })
    const profile = saved.update.harnessProfileSelection
    await waitForRemoteReview(async () => HostHarnessOverrideListSchema.parse(await fixture.value('harness_instances_list', {
      hostRef: profile.target.hostRef, applicationInstallationId: profile.target.applicationInstallationId,
    })), value => value.overrides.some(item => item.instanceId === profile.instanceId
      && item.instanceRevision === profile.instanceRevision && item.qualification === 'qualified'),
    'replacement profile qualification after Main restart')
    const followUp = await chat.send('Continue after Main restarts.')
    expect(followUp.state.conversation!.nativeSession).toEqual(sent.state.conversation!.nativeSession)
    expect(await fixture.details(chat.started.run.id)).toEqual(chat.before)
  }, { includeNodeRuntimePayload: false, sourceAccessMode: 'exclusive-write' })
}, 240_000)
