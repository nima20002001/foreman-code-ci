import { describe, expect, it } from 'vitest'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import { ApprovedSourceSchema } from '@foreman-code/contracts/source-admission'
import { installationUpdateFixture, profileReader, profiles, startWhenReady, pinnedPlacements, completedRun }
  from './helpers/harnessInstallationUpdate.js'

describe('installed harness updates', () => {
  it('rejects failed required Worker discovery without persisting a Run and starts after discovery succeeds', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'single', executionHost: 'worker' })
    try {
      const reader = await profileReader(fixture)
      const discovering = fixture.blockWorkerDiscovery()
      const rejected = expect(fixture.start()).rejects.toThrow('HARNESS_INVENTORY_UNAVAILABLE')
      await discovering
      fixture.cancelWorkerDiscovery()
      await rejected
      expect((await fixture.db.pool.query('select id from runs')).rows).toEqual([])
      expect((await profiles(fixture, reader))[0]!.qualification).toBe('qualified')
      await fixture.releaseWorkerDiscovery()
      const started = (await startWhenReady(fixture))!
      expect(fixture.sourceManifest.git?.repository).toBe(fixture.repositoryName)
      const node = fixture.version.definition.nodes[0]!
      const result = RunPlacementGetResultSchema.parse(await fixture.value('run_node_placement_get', {
        workspaceId: fixture.version.workspaceId,
        workflowId: fixture.version.workflowId,
        runId: started.run.id,
        nodeId: node.id,
      }))
      if (result.readback.evidence !== 'accepted') throw new Error('Expected accepted placement readback')
      const placement = result.readback.placement
      expect(await pinnedPlacements(fixture, started.run.id)).toEqual([placement])
      expect(placement.hostRef).toEqual(fixture.hostRef)
      const source = placement.source
      if (!('kind' in source) || source.kind !== 'pending') throw new Error('Expected Run-start source pins')
      const approved = ApprovedSourceSchema.parse(await fixture.value('source_get', {
        workspaceId: fixture.version.workspaceId,
        approvedSourceId: source.approvedSourceId,
        snapshotId: source.snapshotId,
        manifestDigest: source.manifestDigest,
      }))
      expect(approved.manifest).toMatchObject({
        approvedSourceId: source.approvedSourceId,
        snapshotId: source.snapshotId,
        manifestDigest: source.manifestDigest,
        capturePolicy: fixture.sourceManifest.capturePolicy,
        executablePolicy: fixture.sourceManifest.executablePolicy,
        git: fixture.sourceManifest.git,
        entries: fixture.sourceManifest.entries,
        deletions: fixture.sourceManifest.deletions,
      })
      await completedRun(fixture, started.run.id)
    } finally {
      await fixture.releaseWorkerDiscovery()
      await fixture.close()
    }
  }, 240_000)
})
