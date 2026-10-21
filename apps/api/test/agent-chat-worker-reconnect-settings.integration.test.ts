import { expect, it } from 'vitest'
import { HostHarnessOverrideListSchema } from '@foreman-code/contracts/harness-registry'
import { historicalChatPlacement } from './helpers/historicalChatPlacement.js'
import { workerSettingsChat } from './helpers/agentChatWorkerSettings.js'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'

it('releases the superseded runtime across a Worker reconnect without reopening its profile', async () => {
  await historicalChatPlacement(async fixture => {
    const chat = await workerSettingsChat(fixture)
    const session = chat.completed.conversation!.nativeSession
    const saved = await chat.save({ model: 'other-model' })
    await fixture.restartWorker()
    const profile = saved.update.harnessProfileSelection
    await waitForRemoteReview(async () => HostHarnessOverrideListSchema.parse(await fixture.value('harness_instances_list', {
      hostRef: profile.target.hostRef, applicationInstallationId: profile.target.applicationInstallationId,
    })), value => value.overrides.some(item => item.instanceId === profile.instanceId
      && item.qualification === 'qualified'), 'updated profile qualification after reconnect')
    const sent = await chat.send('Continue after reconnect with the new model.')
    expect(sent.state.conversation).toMatchObject({ id: chat.id, nativeSession: session,
      agentConfigurationVersionId: saved.result.value.agent.configurationVersionId })
    expect((await fixture.provider.calls()).filter(call => call.method === 'turn/start'
      && call.correlationId === `agent-chat:${chat.id}:${sent.message.requestId}`)).toHaveLength(1)
    expect(await fixture.details(chat.started.run.id)).toEqual(chat.before)
  }, { includeNodeRuntimePayload: false, sourceAccessMode: 'exclusive-write' })
}, 240_000)
