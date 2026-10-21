import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { HostHarnessOverrideSaveResultSchema, HostHarnessInstanceCheckResultSchema }
  from '@foreman-code/contracts/harness-registry'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowReadResultSchema, CurrentWorkflowSaveResultSchema,
  ManualRunStartResultSchema, type WorkflowDefinitionV3, type WorkflowVersionV3 }
  from '@foreman-code/contracts/wave25'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { modelRequestDirectories } from './helpers/modelRequestDirectories.js'
import { completedRun, installationUpdateFixture, latestEvidence, pinnedPlacements, profileReader, profiles }
  from './helpers/harnessInstallationUpdate.js'

describe('profile-scoped Start after a Worker harness installation update', () => {
  it('prioritizes active placements and starts a checked profile while other profiles remain pending', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'single' })
    let modelsBlocked = false
    let turnsBlocked = false
    const scope = { workspaceId: fixture.version.workspaceId, workflowId: fixture.version.workflowId }
    const placedNode = fixture.version.definition.nodes[0]!
    if (placedNode.kind === 'job' || !placedNode.placement) throw new Error('Expected an Agent placement.')
    const locationRevision = Number(placedNode.placement.locationRevision)
    const startInput = async (version: WorkflowVersionV3) => {
      const current = CurrentWorkflowReadResultSchema.parse(await fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope))
      return { ...scope, commandId: randomUUID(), workflowVersionId: version.id,
        executionSemanticsVersion: 3 as const, expectedWorkflowRevision: current.revision,
        expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
        expectedLocationRevision: locationRevision, input: {} }
    }
    const saveGraph = async (graph: WorkflowDefinitionV3) => {
      const current = CurrentWorkflowReadResultSchema.parse(await fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope))
      const definition = {
        ...graph,
        version: current.version.definition.version,
        createdAt: current.version.definition.createdAt,
      }
      return CurrentWorkflowSaveResultSchema.parse(await fixture.value(CURRENT_WORKFLOW_TOOLS.save, {
        ...scope, commandId: randomUUID(), executionSemanticsVersion: 3, graph: definition,
        expectedRevision: current.revision, expectedWorkflowVersionId: current.version.id,
        expectedAgentConfigurationVersionIds: current.version.agentConfigurationVersionIds,
      })).value.version
    }
    try {
      const configured = fixture.profiles[0]!
      // Sort unused profiles before the active profile in the repository's default order.
      const unusedIds = [1, 2, 3].map(index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`)
      for (const instanceId of unusedIds) {
        const saved = HostHarnessOverrideSaveResultSchema.parse(await fixture.value('harness_instance_save', {
          commandId: randomUUID(), instanceId, expectedRevision: 0, target: configured.target,
          presetId: configured.presetId, enabled: true, configuration: configured.configuration,
        })).value
        const checked = HostHarnessInstanceCheckResultSchema.parse(await fixture.value('harness_instance_check', {
          commandId: randomUUID(), instanceId, expectedRevision: saved.revision, target: saved.target,
        }))
        expect(checked.proof.qualified).toBe(true)
      }
      const before = await latestEvidence(fixture)
      expect(before).toHaveLength(4)
      await fixture.provider.blockWorkflowTurns()
      turnsBlocked = true
      const active = await fixture.start()
      await waitForRemoteReview(() => fixture.provider.calls(), calls =>
        calls.some(call => call.workflowTurn !== undefined), 'active native placement')
      const originalProfiles = await waitForRemoteReview(() => profiles(fixture), values =>
        values.length === 4 && values.every(profile => profile.qualification === 'qualified'),
      'completed checks before the installation update')
      const callsBefore = (await fixture.provider.calls()).length
      // Keep real old-installation requests in the observation window to reproduce late check activity.
      for (const profile of originalProfiles.filter(value => unusedIds.slice(0, 2).includes(value.instanceId))) {
        const checked = HostHarnessInstanceCheckResultSchema.parse(await fixture.value('harness_instance_check', {
          commandId: randomUUID(), instanceId: profile.instanceId,
          expectedRevision: profile.revision, target: profile.target,
        }))
        expect(checked.proof.qualified).toBe(true)
      }
      const obsoleteCalls = (await fixture.provider.calls()).slice(callsBefore)
      expect(modelRequestDirectories(obsoleteCalls, fixture.stateDirectory, '0.154.0')).toHaveLength(2)
      // Hold only Worker profile checks; the later Run starts its session in a fresh source tree.
      await fixture.provider.blockModels({ workingDirectory: fixture.stateDirectory })
      modelsBlocked = true
      const providerVersion = await fixture.provider.updatePayload()
      expect(modelRequestDirectories(obsoleteCalls, fixture.stateDirectory, providerVersion)).toEqual([])
      // Checks from the previous installation may still arrive after the payload changes.
      const checking = await waitForRemoteReview(() => fixture.provider.calls(), calls =>
        modelRequestDirectories(calls.slice(callsBefore), fixture.stateDirectory, providerVersion).length === 2,
      'two parallel profile checks')
      const directories = modelRequestDirectories(checking.slice(callsBefore), fixture.stateDirectory, providerVersion)
      expect(directories).toHaveLength(2)
      await expect(fixture.start()).rejects.toThrow('HARNESS_PROFILE_CHECK_PENDING')
      await fixture.provider.allowModelDirectories(directories)
      let qualifications: unknown
      const mixed = await waitForRemoteReview(async () => {
        const values = await profiles(fixture)
        qualifications = values.map(profile => ({
          active: profile.instanceId === configured.instanceId,
          qualification: profile.qualification,
          revision: profile.revision,
          failure: profile.qualificationFailure,
        }))
        return values
      }, values => values.find(profile => profile.instanceId === configured.instanceId)?.qualification === 'qualified'
        && values.filter(profile => profile.qualification === 'qualified').length === 2
        && values.filter(profile => profile.qualification === 'qualifying').length === 2,
      'active placement ready while unused profiles remain pending').catch(async error => {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`${message} ${JSON.stringify({ qualifications,
          directories: directories.map(directory => directory.slice(fixture.stateDirectory.length)),
          failures: fixture.failures(),
          modelRequests: (await fixture.provider.calls()).slice(callsBefore).filter(call => call.method === 'model/list')
            .map(call => ({ directory: String(call.workingDirectory).replace(fixture.stateDirectory, ''),
              version: call.providerVersion, pid: call.pid })),
        })}`, { cause: error })
      })
      const ready = mixed.find(profile => profile.instanceId === configured.instanceId)!
      const pending = mixed.find(profile => profile.qualification === 'qualifying')!
      const evidence = await latestEvidence(fixture)
      const refreshed = evidence.filter(proof =>
        proof.target.installationFingerprint !== before[0]!.target.installationFingerprint)
      expect(refreshed).toHaveLength(2)
      expect(refreshed.every(proof => proof.qualified && proof.authenticated && proof.compatible)).toBe(true)

      const reader = await profileReader(fixture)
      const deniedStop = await fixture.call('run_stop', {
        workspaceId: scope.workspaceId, runId: active.run.id, commandId: randomUUID(),
      }, reader)
      expect(deniedStop.isError).toBe(true)
      expect(decodeMcpToolResult(deniedStop)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      await fixture.provider.releaseWorkflowTurns()
      turnsBlocked = false
      await fixture.value('run_stop', { workspaceId: scope.workspaceId, runId: active.run.id, commandId: randomUUID() })
      const stopped = await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return fixture.details(active.run.id)
      }, details => details.run.executionState === 'completed', 'closure of the active placement after the installation update')
      expect(stopped.run.outcome).toBe('canceled')
      const pendingGraph = structuredClone(fixture.version.definition)
      const node = pendingGraph.nodes[0]!
      if (node.kind === 'job' || !node.placement) throw new Error('Expected an Agent placement.')
      node.placement.instanceId = pending.instanceId
      node.placement.instanceRevision = pending.instanceRevision
      node.placement.harnessInstallationId = pending.target.harnessInstallationId
      const pendingVersion = await saveGraph(pendingGraph)
      const pendingInput = await startInput(pendingVersion)
      const refused = await fixture.call('run_start', pendingInput)
      expect(refused.isError).toBe(true)
      expect(decodeMcpToolResult(refused)).toMatchObject({ error: {
        code: 'HARNESS_PROFILE_CHECK_PENDING', details: { retryable: true },
      } })
      const response = await fetch(`${fixture.origin()}/api/management/workspaces/${scope.workspaceId}`
        + `/workflows/${scope.workflowId}/runs`, {
        method: 'POST', headers: { authorization: `Bearer ${fixture.writer.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(pendingInput),
      })
      expect(response.status).toBe(503)
      expect(await response.json()).toMatchObject({ error: {
        code: 'HARNESS_PROFILE_CHECK_PENDING', details: { retryable: true },
      } })
      expect((await fixture.db.pool.query('select id from runs')).rows).toHaveLength(1)
      expect((await profiles(fixture, reader)).find(profile => profile.instanceId === pending.instanceId)
        ?.qualification).toBe('qualifying')

      const pendingSaved = CurrentWorkflowReadResultSchema.parse(
        await fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope))
      expect(pendingSaved.version.id).toBe(pendingVersion.id)
      const staleSave = await fixture.call(CURRENT_WORKFLOW_TOOLS.save, {
        ...scope, commandId: randomUUID(), executionSemanticsVersion: 3,
        graph: fixture.version.definition,
        expectedRevision: pendingSaved.revision, expectedWorkflowVersionId: pendingVersion.id,
        expectedAgentConfigurationVersionIds: pendingVersion.agentConfigurationVersionIds,
      })
      expect(staleSave.isError).toBe(true)
      expect(decodeMcpToolResult(staleSave)).toMatchObject({ error: { code: 'WORKFLOW_BASE_CONFLICT' } })
      expect(CurrentWorkflowReadResultSchema.parse(
        await fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope))).toEqual(pendingSaved)

      const readyVersion = await saveGraph(fixture.version.definition)
      const readySaved = CurrentWorkflowReadResultSchema.parse(
        await fixture.value(CURRENT_WORKFLOW_TOOLS.saved, scope))
      expect(readySaved.version).toEqual(readyVersion)
      expect(readyVersion.definition.nodes).toEqual(fixture.version.definition.nodes)
      expect(readyVersion.version).toBe(pendingVersion.version + 1)
      const readyInput = await startInput(readyVersion)
      const started = ManualRunStartResultSchema.parse(await fixture.value('run_start', readyInput))
      expect((await fixture.details(started.run.id)).run.workflowVersionId).toBe(readyVersion.id)
      const placements = await pinnedPlacements(fixture, started.run.id)
      expect(placements.map(placement => placement.payload)).toEqual([expect.objectContaining({
        instanceId: ready.instanceId, instanceRevision: ready.instanceRevision,
      })])
      expect((await profiles(fixture, reader)).find(profile => profile.instanceId === pending.instanceId)
        ?.qualification).toBe('qualifying')
      const replay = ManualRunStartResultSchema.parse(await fixture.value('run_start', readyInput))
      expect(replay.run.id).toBe(started.run.id)
      // The Run on the checked profile must finish before Main shuts down, or its source preparation races the shutdown.
      await completedRun(fixture, started.run.id)
    } finally {
      if (modelsBlocked) await fixture.provider.releaseModels()
      if (turnsBlocked) await fixture.provider.releaseWorkflowTurns()
      await fixture.close()
    }
  }, 240_000)
})
