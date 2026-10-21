import { describe, expect, it } from 'vitest'
import { remoteReviewProduction } from './helpers/remoteReviewProduction.js'
import { latestEvidence, refreshedEvidence, assertMcpReadback, startWhenReady } from './helpers/workerProfileRequalification.js'
import { waitForReplacementReviewInventory } from './helpers/remoteReviewProductionCases.js'

describe('automatic Worker profile qualification', () => {
  it('rechecks Worker profiles after Main restarts while preserving their boot generation', async () => {
    const fixture = await remoteReviewProduction({ workflow: 'sequential', parallelProfileChecks: true,
      parallelSetup: true })
    try {
      const before = await latestEvidence(fixture)
      const workerPid = fixture.workerPid()
      const inventoryBefore = await fixture.inventory()
      const connectionBefore = inventoryBefore.hostMetadata!.connection!.binding
      expect(fixture.profiles).toHaveLength(2)
      expect(new Set(fixture.profiles.map(profile => profile.instanceId)).size).toBe(2)
      expect(before).toHaveLength(fixture.profiles.length)
      expect(before.every(proof => proof.qualified)).toBe(true)
      await fixture.restartMain()
      const inventoryAfter = await waitForReplacementReviewInventory(fixture, inventoryBefore)
      const evidence = await refreshedEvidence(fixture, before)
      await assertMcpReadback(fixture, evidence)
      expect(evidence.map(proof => proof.connectionGeneration)).toEqual(before.map(proof => proof.connectionGeneration))
      expect(evidence.map(proof => proof.completedNativeQualification!.checkId))
        .not.toEqual(before.map(proof => proof.completedNativeQualification!.checkId))
      const connectionAfter = inventoryAfter.hostMetadata!.connection!
      expect(fixture.workerPid()).toBe(workerPid)
      expect(connectionAfter.phase).toBe('ready')
      expect(connectionAfter.binding.bootId).toBe(connectionBefore.bootId)
      expect(connectionAfter.binding.connectionEpoch).not.toBe(connectionBefore.connectionEpoch)
      expect(connectionAfter.binding.connectionGeneration).toBeGreaterThan(connectionBefore.connectionGeneration)
      const deniedCaller = await fixture.access.issue({ name: 'Unprivileged operator', audience: 'operator',
        grants: [{ actions: ['settings:read'], scope: {} }], expiresAt: new Date('2099-01-01T00:00:00Z') })
      const denied = await fixture.call('harness_registry_get', fixture.hostRef, deniedCaller.token)
        .then(result => ({ result }), (error: unknown) => ({ error }))
      if ('error' in denied) expect(denied.error).toMatchObject({ code: -32602 })
      else expect(denied.result.isError).toBe(true)
      const started = (await startWhenReady(fixture))!
      expect((await fixture.details(started.run.id)).run.id).toBe(started.run.id)
    } catch (error) {
      const audit = await fixture.db.pool.query(`select outcome,details from management_audit
        where source='system' and action='harness.instance.check' order by sequence`)
      console.error('Main restart qualification failure', { error: String(error), audit: audit.rows,
        evidence: (await latestEvidence(fixture)).map(proof => ({ generation: proof.connectionGeneration,
          qualified: proof.qualified, failure: proof.failure })), failures: fixture.failures() })
      throw error
    } finally { await fixture.close() }
  }, 240_000)
})
