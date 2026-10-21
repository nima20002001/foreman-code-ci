import { HarnessQualificationSchema } from '@foreman-code/contracts/harness-qualification'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { AgentSchema } from '@foreman-code/contracts'
import { AgentMutationResultSchema, AgentVersionResultSchema, ManagedAgentDetailSchema } from '@foreman-code/contracts/management'
import { HostHarnessProfileEvidenceSchema, HostHarnessOverrideSaveResultSchema,
  HostHarnessInstanceCheckResultSchema } from '@foreman-code/contracts/harness-registry'
import { CURRENT_WORKFLOW_TOOLS, CurrentEditReadResultSchema, CurrentWorkflowReadResultSchema }
  from '@foreman-code/contracts/wave25'
import { HarnessQualificationRepository } from '../src/modules/harnesses/qualification/repository.js'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'

it('uses the selected Worker qualification when the general harness cache has a conflicting record', async () => {
  const fixture = await remoteReviewProduction({ workflow: 'single', parallelSetup: true })
  let failure: unknown
  try {
    const profile = fixture.profiles[0]!
    const workspaceId = fixture.version.workspaceId
    const workflowId = fixture.version.workflowId
    const scope = { workspaceId, workflowId }
    const before = CurrentWorkflowReadResultSchema.parse(await fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope))
    const node = before.version.definition.nodes[0]!
    if (!('agentId' in node)) throw new Error('Agent chat requires an Agent fixture node')
    const managed = ManagedAgentDetailSchema.parse(await fixture.value('agent_get',
      { workspaceId, agentId: node.agentId }))
    const agent = AgentSchema.parse({ ...managed.agent, harness: profile.driverId, model: profile.configuration.model,
      harnessConfiguration: profile.configuration, harnessProfileSelection: { instanceId: profile.instanceId,
        instanceRevision: profile.instanceRevision, target: profile.target } })
    const draftId = randomUUID()
    await fixture.value('workflow_edit_v3', { action: 'stage_edits', ...scope, draftId, commandId: randomUUID(),
      executionSemanticsVersion: 3, expectedRevision: before.revision, expectedWorkflowVersionId: before.version.id,
      expectedAgentConfigurationVersionIds: before.version.agentConfigurationVersionIds,
      graph: before.version.definition, stagedAgents: [{ agent, baseRevision: managed.metadataRevision }] })
    const intent = CurrentEditReadResultSchema.parse(await fixture.value('workflow_edits_get_v3',
      { action: 'read_edits', ...scope, draftId })).intent
    expect(intent?.state).toBe('staged')
    expect(intent?.affected).toEqual([])
    await fixture.value('workflow_edit_v3', { action: 'stop_and_save', ...scope, draftId,
      intentId: intent!.id, commandId: intent!.advanceCommandId })
    const saved = CurrentWorkflowReadResultSchema.parse(await fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope))
    const configuration = AgentVersionResultSchema.parse(await fixture.value('agent_configuration_version_get',
      { workspaceId, agentId: node.agentId, versionId: saved.version.agentConfigurationVersionIds[node.agentId] })).version
    expect(configuration.harnessProfileSelection).toEqual(agent.harnessProfileSelection)
    const row = await fixture.db.pool.query<{ record: unknown }>(`select record
      from harness_instance_profile_evidence where instance_id=$1 order by created_at desc limit 1`,
    [profile.instanceId])
    const proof = HostHarnessProfileEvidenceSchema.parse(row.rows[0]!.record)
    const native = HarnessQualificationSchema.parse(proof.completedNativeQualification!.record)
    if (native.version === null || native.binarySha256 === null) {
      throw new Error('Expected a completed Worker qualification version and binary fingerprint')
    }
    const qualifications = new HarnessQualificationRepository(fixture.db.pool)
    const retained = await qualifications.findInstalled(profile.target, native.binarySha256, native.suiteRevision)
    expect(retained).toHaveLength(1)
    await qualifications.save({ ...native, status: 'failed', failureReason: 'Another host failed its native check.' })
    expect((await qualifications.find(native.harness, native.version, native.binarySha256,
      native.suiteRevision))?.status).toBe('failed')
    expect(await qualifications.findInstalled(profile.target, native.binarySha256, native.suiteRevision))
      .toEqual(retained)

    const context = { workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const reader = await fixture.access.issue({ name: 'Worker chat read-only caller', audience: 'operator',
      grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: [workspaceId] } }],
      expiresAt: new Date(Date.now() + 600_000) })
    const request = { requestId: randomUUID(), content: 'Reply with ACK.', intent: 'next_turn',
      expectedConversationId: null, context }
    const denied = await fixture.call('agent_chat_send', { workspaceId, request }, reader.token)
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    await fixture.value('agent_chat_send', { workspaceId, request })
    const state = await waitForRemoteReview(async () => AgentChatStateSchema.parse(await fixture.value(
      'agent_chat_read', { workspaceId, query: context })), value =>
      Boolean(value.conversation?.nativeSession) && value.turns.some(turn =>
        turn.requestId === request.requestId && turn.nativeTurnId !== undefined && turn.delivery === 'completed'),
    'selected Worker chat completion')
    expect(state.conversation?.nativeSession?.nativeSessionId).toBeTruthy()
    const turn = state.turns.find(turn => turn.requestId === request.requestId)!
    expect(turn.nativeTurnId).toBeTruthy()
    const readback = AgentChatStateSchema.parse(await fixture.value('agent_chat_read',
      { workspaceId, query: context }))
    expect(readback.conversation?.id).toBe(state.conversation?.id)
    expect(readback.messages.find(message => message.id === turn.messageId))
      .toMatchObject({ role: 'user', content: request.content })
    const persisted = await fixture.db.pool.query<{ native_session_id: string | null }>(
      'select native_session_id from operator_conversations where id=$1', [state.conversation!.id])
    expect(persisted.rows[0]?.native_session_id).toBe(state.conversation?.nativeSession?.nativeSessionId)
    let selectedProfile = profile
    for (const replaceProfile of [false, true]) {
      const calls = await fixture.provider.calls()
      const firstPid = calls.filter(call => call.method === 'turn/start'
        && call.threadId === state.conversation?.nativeSession?.nativeSessionId).at(-1)?.pid
      expect(firstPid).toBeTypeOf('number')
      const resumesBefore = calls.filter(call => call.method === 'thread/resume'
        && call.threadId === state.conversation?.nativeSession?.nativeSessionId).length
      if (selectedProfile.configuration.harness !== 'codex') throw new Error('Codex profile required')
      const changedHarness = { ...selectedProfile.configuration,
        reasoningEffort: selectedProfile.configuration.reasoningEffort === 'medium' ? 'low' as const : 'medium' as const }
      const changedProfile = HostHarnessOverrideSaveResultSchema.parse(await fixture.value('harness_instance_save', {
        commandId: randomUUID(), instanceId: replaceProfile ? randomUUID() : selectedProfile.instanceId,
        expectedRevision: replaceProfile ? 0 : selectedProfile.revision,
        target: selectedProfile.target, presetId: selectedProfile.presetId, enabled: true, configuration: changedHarness,
      })).value
      const checked = HostHarnessInstanceCheckResultSchema.parse(await fixture.value('harness_instance_check', {
        commandId: randomUUID(), instanceId: changedProfile.instanceId, expectedRevision: changedProfile.revision,
        target: selectedProfile.target,
      }))
      expect(checked.proof.qualified).toBe(true)
      const detail = ManagedAgentDetailSchema.parse(await fixture.value('agent_get', { workspaceId, agentId: node.agentId }))
      const updated = AgentMutationResultSchema.parse(await fixture.value('agent_update', {
        workspaceId, agentId: node.agentId, commandId: randomUUID(), expectedRevision: detail.metadataRevision,
        expectedConfigurationVersionId: detail.agent.configurationVersionId,
        configuration: changedHarness, harnessProfileSelection: { instanceId: checked.value.instanceId,
          instanceRevision: checked.value.instanceRevision, target: checked.value.target },
      }))
      const following = { ...request, requestId: randomUUID(), expectedConversationId: state.conversation!.id }
      await fixture.value('agent_chat_send', { workspaceId, request: following })
      const after = await waitForRemoteReview(async () => AgentChatStateSchema.parse(await fixture.value(
        'agent_chat_read', { workspaceId, query: context })), value => value.turns.some(item =>
        item.requestId === following.requestId && ['completed', 'failed'].includes(item.delivery)),
      'Worker chat after Agent settings change')
      expect(after.turns.find(item => item.requestId === following.requestId)?.delivery).toBe('completed')
      const nativeSessionId = after.conversation!.nativeSession!.nativeSessionId
      if (replaceProfile) {
        expect(nativeSessionId).not.toBe(state.conversation!.nativeSession!.nativeSessionId)
        expect(after.messages.filter(message => message.role === 'user').map(message => message.content))
          .toEqual([request.content, request.content, request.content])
      } else {
        expect(nativeSessionId).toBe(state.conversation!.nativeSession!.nativeSessionId)
      }
      const binding = (await fixture.db.pool.query<{ worker_conversation_binding: { owner: { configurationVersionId: string } } }>(
        'select worker_conversation_binding from operator_conversations where id=$1', [state.conversation!.id])).rows[0]!
      expect(binding.worker_conversation_binding.owner.configurationVersionId).toBe(updated.value.agent.configurationVersionId)
      const starts = (await fixture.provider.calls()).filter(call =>
        call.method === 'thread/resume' && call.threadId === state.conversation?.nativeSession?.nativeSessionId)
      expect(starts).toHaveLength(resumesBefore + (replaceProfile ? 0 : 1))
      expect((await fixture.provider.calls()).filter(call => call.method === 'turn/start'
        && call.threadId === nativeSessionId && call.correlationId === `agent-chat:${state.conversation!.id}:${following.requestId}`))
        .toHaveLength(1)
      expect(() => process.kill(firstPid as number, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
      selectedProfile = checked.value
    }
  } catch (error) {
    failure = error
    console.error('Worker chat qualification regression failed', { failures: fixture.failures().slice(-8) })
  }
  let cleanupFailure: unknown
  try {
    await fixture.close()
  } catch (error) {
    cleanupFailure = error
  }
  if (failure && cleanupFailure) throw new AggregateError([failure, cleanupFailure],
    'Worker chat regression and fixture cleanup failed.', { cause: failure })
  if (failure) throw failure
  if (cleanupFailure) throw cleanupFailure
}, 240_000)
