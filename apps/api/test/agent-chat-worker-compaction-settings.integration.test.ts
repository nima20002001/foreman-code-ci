import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AgentChatControlsStateSchema } from '@foreman-code/contracts/agent-chat'
import { WorkerConversationBindingSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { HostHarnessOverrideListSchema } from '@foreman-code/contracts/harness-registry'
import { historicalChatPlacement } from './helpers/historicalChatPlacement.js'
import { workerSettingsChat } from './helpers/agentChatWorkerSettings.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'
import { identityAlive } from '../src/modules/harnesses/recovery/linuxIdentity.js'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { harnessConnectionGeneration } from '../src/modules/harnesses/hostConnectionGeneration.js'

it.each(['resident', 'unloaded', 'previous-boot-proof'] as const)(
  'recovers Worker compaction with %s recovery after its profile is superseded', async residency => {
    await historicalChatPlacement(async fixture => {
      const chat = await workerSettingsChat(fixture)
      const target = { workspaceId: chat.workspaceId, conversationId: chat.id }
      const session = chat.completed.conversation!.nativeSession!
      const controls = AgentChatControlsStateSchema.parse(await fixture.value('agent_chat_controls_get', target))
      expect(controls.capabilities.compact.supported).toBe(true)
      const original = fixture.registry.snapshot().launches.filter(launch =>
        launch.owner === `conversation:${chat.id}` && launch.lifecycle === 'active' && launch.provider)
      expect(original).toHaveLength(1)
      const connection = (await fixture.inventory()).hostMetadata!.connection!.binding
      fixture.loseNextCompactionResponse()
      const request = { kind: 'compact', requestId: randomUUID(), expectedRevision: controls.revision }
      const compacted = AgentChatControlsStateSchema.parse(await fixture.value('agent_chat_controls_update', {
        ...target, request,
      }))
      expect(compacted.compaction).toMatchObject({ requestId: request.requestId, status: 'uncertain',
        dispatchPhase: 'dispatched', nativeSessionId: session.nativeSessionId })
      expect(identityAlive(original[0]!.provider!)).toBe(true)
      await waitForRemoteReview(fixture.inventory, inventory => {
        const replacement = inventory.hostMetadata?.connection
        return replacement?.phase === 'ready' && replacement.binding.connectionEpoch !== connection.connectionEpoch
      }, 'Worker reconnect after compaction response loss', fixture.subscribeNativeChanges)
      const binding = WorkerConversationBindingSchema.parse((await fixture.db.pool.query<{
        worker_conversation_binding: unknown
      }>('select worker_conversation_binding from operator_conversations where id=$1', [chat.id]))
        .rows[0]!.worker_conversation_binding)
      const saved = await chat.save({ model: 'other-model', reasoningEffort: 'medium' })
      expect(saved.update.harnessProfileSelection.instanceId).toBe(binding.profile.instanceId)
      expect(saved.update.harnessProfileSelection.instanceRevision).not.toBe(binding.profile.instanceRevision)
      if (residency === 'previous-boot-proof') {
        const settings = new HarnessInstanceSettingsRepository(fixture.db.pool)
        const proofs = new HostHarnessProfileEvidenceRepository(fixture.db.pool)
        await settings.readAuthorized(async client => {
          const profile = await settings.savedRevision(client, binding.profile.instanceId,
            binding.profile.instanceRevision, { target: binding.profile.target })
          if (!profile) throw new Error('The original Worker profile is missing.')
          const proof = await proofs.latest(profile.instanceId, profile.revision, client)
          if (!proof) throw new Error('The original Worker qualification is missing.')
          expect(proof.connectionGeneration).toBe(harnessConnectionGeneration(connection))
          const previousBoot = { ...connection, bootId: randomUUID() }
          await proofs.append(client, randomUUID(), profile, { ...proof,
            connectionGeneration: harnessConnectionGeneration(previousBoot),
            ...(proof.completedNativeQualification ? { completedNativeQualification: {
              ...proof.completedNativeQualification, binding: previousBoot,
            } } : {}),
          })
        })
      }
      if (residency === 'unloaded') {
        await fixture.restartMain()
        const selected = saved.update.harnessProfileSelection
        await waitForRemoteReview(async () => HostHarnessOverrideListSchema.parse(
          await fixture.value('harness_instances_list', { hostRef: selected.target.hostRef,
            applicationInstallationId: selected.target.applicationInstallationId })),
        inventory => inventory.overrides.some(profile => profile.instanceId === selected.instanceId
          && profile.instanceRevision === selected.instanceRevision && profile.qualification === 'qualified'),
        'saved profile qualification after Main restart')
      }
      const blocked = await fixture.call('agent_chat_send', { workspaceId: chat.workspaceId,
        selection: chat.selection, message: { requestId: randomUUID(), expectedConversationId: chat.id,
          content: 'Wait for compaction recovery.' } })
      expect(blocked.isError).toBe(true)
      expect(JSON.stringify(blocked.content)).toContain('SESSION_COMPACT_UNCONFIRMED')
      const beforeRead = (await fixture.provider.calls()).length
      const requestsBeforeRead = fixture.conversationRequests.length
      const denied = await fixture.access.issue({ name: 'Denied compaction observer', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [] })
      await expectMcpAccessDenied(fixture.call('agent_chat_controls_get', target, denied.token))
      const recovered = AgentChatControlsStateSchema.parse(await fixture.value('agent_chat_controls_get', target))
      expect(recovered).toMatchObject({ profileKey: controls.profileKey,
        nativeSessionId: session.nativeSessionId,
        compaction: { requestId: request.requestId, status: 'completed', nativeSessionId: session.nativeSessionId },
        configuration: { versionId: saved.result.value.agent.configurationVersionId,
          harness: { model: 'other-model', reasoningEffort: 'medium' } } })
      expect(identityAlive(original[0]!.provider!)).toBe(true)
      const recoveryCalls = (await fixture.provider.calls()).slice(beforeRead)
      const recoveryRequests = fixture.conversationRequests.slice(requestsBeforeRead)
      expect(recoveryRequests).toContainEqual(expect.objectContaining({ method: 'conversation.compact-read',
        session: { harness: 'codex', ...session }, binding: expect.objectContaining({ profile: binding.profile }) }))
      expect(recoveryRequests.filter(request => request.method === 'conversation.open')).toEqual([])
      expect(recoveryCalls.filter(call => ['thread/start', 'thread/resume', 'thread/fork', 'turn/start',
        'thread/compact/start'].includes(String(call.method)))).toEqual([])
      const replay = AgentChatControlsStateSchema.parse(await fixture.value('agent_chat_controls_update', {
        ...target, request,
      }))
      expect(replay.completedRequestId).toBe(request.requestId)
      expect(replay.compactions).toContainEqual(recovered.compaction)
      const persisted = AgentChatControlsStateSchema.parse(await fixture.value('agent_chat_controls_get', target))
      expect(persisted.compactions).toContainEqual(recovered.compaction)
      const continued = await chat.send('Continue with the saved settings after compaction.')
      expect(continued.state.conversation).toMatchObject({ id: chat.id, nativeSession: session,
        agentConfigurationVersionId: saved.result.value.agent.configurationVersionId })
      const calls = await fixture.provider.calls()
      expect(calls.filter(call => call.method === 'thread/compact/start')).toHaveLength(1)
      expect(calls.filter(call => call.method === 'turn/start'
        && call.correlationId === `agent-chat:${chat.id}:${continued.message.requestId}`)).toHaveLength(1)
      expect(calls).toContainEqual(expect.objectContaining({ method: 'thread/resume',
        threadId: session.nativeSessionId, model: 'other-model', reasoningEffort: 'medium' }))
      expect(await fixture.details(chat.started.run.id)).toEqual(chat.before)
    }, { includeNodeRuntimePayload: false, sourceAccessMode: 'exclusive-write' })
  }, 240_000,
)
