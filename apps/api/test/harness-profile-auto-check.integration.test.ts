import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HostHarnessOverrideSaveResultSchema } from '@foreman-code/contracts/harness-registry'
import { NodePlacementChoicesResultSchema } from '@foreman-code/contracts/placement-readback'
import { CurrentWorkflowReadResultSchema, CURRENT_WORKFLOW_TOOLS, ManualRunStartResultSchema }
  from '@foreman-code/contracts/wave25'
import { remoteReviewProduction, waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { profiles } from './helpers/harnessInstallationUpdate.js'
import { expectMcpAccessDenied } from './helpers/deniedMcpTool.js'

describe('automatic checks of enabled harness profiles', () => {
  it.each(['start-missing', 'choices-stale'] as const)('checks automatically from %s', async trigger => {
    const fixture = await remoteReviewProduction({ workflow: 'single', executionHost: 'main', parallelSetup: true })
    let blocked = false
    try {
      const profile = fixture.profiles[0]!
      const scope = { workspaceId: fixture.version.workspaceId, workflowId: fixture.version.workflowId }
      const saved = CurrentWorkflowReadResultSchema.parse(await fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope))
      const node = saved.version.definition.nodes[0]!
      if (node.kind === 'job' || !node.placement) throw new Error('Expected an Agent placement.')
      const input = { ...scope, commandId: randomUUID(), executionSemanticsVersion: 3,
        workflowVersionId: saved.version.id, expectedWorkflowRevision: saved.revision,
        expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
        expectedLocationRevision: Number(node.placement.locationRevision), input: {} }
      const choicesInput = { ...scope, nodeId: node.id,
        agentConfigurationVersionId: saved.version.agentConfigurationVersionIds[node.agentId] }
      await fixture.provider.blockModels()
      blocked = true
      if (trigger === 'start-missing') {
        await fixture.db.pool.query('delete from harness_instance_profile_evidence where instance_id=$1', [profile.instanceId])
      } else {
        await fixture.db.pool.query(`update harness_instance_profile_evidence
          set record=jsonb_set(record,'{environmentGeneration}','"stale"') where instance_id=$1`, [profile.instanceId])
      }
      const callsBefore = (await fixture.provider.calls()).length
      if (trigger === 'choices-stale') {
        const choices = NodePlacementChoicesResultSchema.parse(
          await fixture.value('workflow_node_placement_choices', choicesInput))
        expect(choices.choices.find(choice => choice.placement.instanceId === profile.instanceId))
          .toMatchObject({ availability: 'unavailable' })
      }
      const pending = await fixture.call('run_start', input)
      expect(decodeMcpToolResult(pending)).toMatchObject({ error: {
        code: 'HARNESS_PROFILE_CHECK_PENDING', details: { retryable: true },
      } })
      await waitForRemoteReview(() => fixture.provider.calls(), calls =>
        calls.slice(callsBefore).some(call => call.method === 'model/list'), 'automatic profile check from product action')
      await fixture.provider.releaseModels()
      blocked = false
      await waitForRemoteReview(() => profiles(fixture), values =>
        values.some(value => value.instanceId === profile.instanceId && value.qualification === 'qualified'),
      'refreshed profile qualification')
      const started = ManualRunStartResultSchema.parse(await fixture.value('run_start', input))
      expect((await fixture.details(started.run.id)).run.workflowVersionId).toBe(saved.version.id)
      expect(ManualRunStartResultSchema.parse(await fixture.value('run_start', input)).run.id).toBe(started.run.id)
    } finally {
      if (blocked) await fixture.provider.releaseModels()
      await fixture.close()
    }
  }, 240_000)

  it('blocks Start with the persisted native failure instead of requesting manual qualification', async () => {
    const fixture = await remoteReviewProduction({ workflow: 'single', executionHost: 'main', parallelSetup: true })
    try {
      const original = fixture.profiles[0]!
      const scope = { workspaceId: fixture.version.workspaceId, workflowId: fixture.version.workflowId }
      const saved = CurrentWorkflowReadResultSchema.parse(await fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope))
      const node = saved.version.definition.nodes[0]!
      if (node.kind === 'job' || !node.placement) throw new Error('Expected an Agent placement.')
      await fixture.provider.hideModels()
      const enabled = HostHarnessOverrideSaveResultSchema.parse(await fixture.value('harness_instance_save', {
        instanceId: original.instanceId, target: original.target, presetId: original.presetId,
        configuration: original.configuration, enabled: true,
      })).value
      const failed = await waitForRemoteReview(() => profiles(fixture), values => values.some(profile =>
        profile.instanceId === original.instanceId && profile.revision === enabled.revision
          && profile.qualificationFailure !== undefined && profile.qualification !== 'qualifying'),
      'persisted automatic check failure')
      const profile = failed.find(value => value.instanceId === original.instanceId)!
      expect(profile.qualification).toBe('unqualified')
      expect(profile.qualificationFailure?.code).toBe('CODEX_MODEL_UNAVAILABLE')
      const result = await fixture.call('run_start', { ...scope, commandId: randomUUID(),
        executionSemanticsVersion: 3, workflowVersionId: saved.version.id,
        expectedWorkflowRevision: saved.revision,
        expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
        expectedLocationRevision: Number(node.placement.locationRevision), input: {},
      })
      expect(result.isError).toBe(true)
      expect(decodeMcpToolResult(result)).toMatchObject({ error: {
        code: profile.qualificationFailure!.code, message: profile.qualificationFailure!.message,
      } })
    } finally {
      await fixture.close()
    }
  }, 240_000)

  it.each(['main', 'worker'] as const)(
    'starts a saved workflow on %s after disable and enable without a manual profile check',
    async executionHost => {
      const fixture = await remoteReviewProduction({ workflow: 'single', executionHost, parallelSetup: true })
      let blocked = false
      try {
        const original = fixture.profiles[0]!
        const scope = { workspaceId: fixture.version.workspaceId, workflowId: fixture.version.workflowId }
        const saved = CurrentWorkflowReadResultSchema.parse(await fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope))
        const node = saved.version.definition.nodes[0]!
        if (node.kind === 'job' || !node.placement) throw new Error('Expected an Agent placement.')
        const input = { ...scope, commandId: randomUUID(), executionSemanticsVersion: 3,
          workflowVersionId: saved.version.id, expectedWorkflowRevision: saved.revision,
          expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
          expectedLocationRevision: Number(node.placement.locationRevision), input: {} }
        const save = (enabled: boolean, expectedRevision: number) => fixture.value('harness_instance_save', {
          commandId: randomUUID(), instanceId: original.instanceId, target: original.target,
          presetId: original.presetId, configuration: original.configuration, enabled, expectedRevision,
        }).then(HostHarnessOverrideSaveResultSchema.parse)
        const disabled = await save(false, original.revision)
        expect(disabled.value.qualification).toBe('disabled')
        await fixture.provider.blockModels()
        blocked = true
        const callsBefore = (await fixture.provider.calls()).length
        const enabled = await save(true, disabled.value.revision)
        // Setup qualifies the original placement; after re-enabling, only product actions request checks.
        await waitForRemoteReview(() => fixture.provider.calls(), calls =>
          calls.slice(callsBefore).some(call => call.method === 'model/list'), 'save starting the profile check')
        const reader = await fixture.access.issue({ name: 'Profile reader', audience: 'operator',
          grants: [{ actions: ['harnesses:read'], scope: {} }] })
        await expectMcpAccessDenied(fixture.call('harness_instance_save', {
          instanceId: original.instanceId, target: original.target, presetId: original.presetId,
          configuration: original.configuration, enabled: true,
        }, reader.token))
        await expectMcpAccessDenied(fixture.call('run_start', input, reader.token))
        const pending = await fixture.call('run_start', input)
        expect(pending.isError).toBe(true)
        expect(decodeMcpToolResult(pending)).toMatchObject({ error: {
          code: 'HARNESS_PROFILE_CHECK_PENDING', details: { retryable: true },
        } })
        const choices = NodePlacementChoicesResultSchema.parse(await fixture.value('workflow_node_placement_choices', {
          ...scope, nodeId: node.id, agentConfigurationVersionId: saved.version.agentConfigurationVersionIds[node.agentId],
        }))
        expect(choices.choices.find(choice => choice.placement.instanceId === original.instanceId))
          .toMatchObject({ availability: 'unavailable' })
        await fixture.provider.releaseModels()
        blocked = false
        await waitForRemoteReview(() => profiles(fixture, reader.token), values =>
          values.some(profile => profile.instanceId === original.instanceId
            && profile.revision === enabled.value.revision && profile.qualification === 'qualified'), 'automatic qualification')
        const started = ManualRunStartResultSchema.parse(await fixture.value('run_start', input))
        const readback = await fixture.details(started.run.id)
        expect(readback.run.id).toBe(started.run.id)
        expect(readback.run.workflowVersionId).toBe(saved.version.id)
        expect(ManualRunStartResultSchema.parse(await fixture.value('run_start', input)).run.id).toBe(started.run.id)
        expect(CurrentWorkflowReadResultSchema.parse(await fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope)))
          .toEqual(saved)
        const ready = NodePlacementChoicesResultSchema.parse(await fixture.value('workflow_node_placement_choices', {
          ...scope, nodeId: node.id, agentConfigurationVersionId: saved.version.agentConfigurationVersionIds[node.agentId],
        }))
        expect(ready.choices.find(choice => choice.placement.instanceId === original.instanceId))
          .toMatchObject({ availability: 'ready' })
      } finally {
        if (blocked) await fixture.provider.releaseModels()
        await fixture.close()
      }
    }, 240_000,
  )
})
