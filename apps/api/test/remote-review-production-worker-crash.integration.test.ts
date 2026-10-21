import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { waitForRemoteReview, receipts, reviewInProgress,
  useRemoteReviewFixture } from './helpers/remoteReviewProductionCases.js'

const withRemoteReviewFixture = useRemoteReviewFixture()

describe('production remote review and native recovery through authenticated MCP', () => {
  it('settles the original native owners after an installed Worker crash without launching a replacement', async () => {
    await withRemoteReviewFixture(async fixture => {
      const active = await reviewInProgress(fixture)
      const originalReceipts = await receipts(fixture, active.run.id)
      const ownerLaunchIds = fixture.registry.snapshot().launches.filter(owner => active.owners.some(
        original => original.owner === owner.owner)).map(owner => owner.launchId).sort()
      const workerPid = fixture.workerPid()
      await fixture.restartWorker()
      expect(fixture.workerPid()).not.toBe(workerPid)
      await fixture.value('run_stop', { workspaceId: active.run.workspaceId,
        runId: active.run.id, commandId: randomUUID() })
      const settled = await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return receipts(fixture, active.run.id)
      }, value => value.length === originalReceipts.length && value.every(receipt => receipt.phase === 'confirmed_terminal'),
      'positive original native closure after Worker restart')
      for (const receipt of settled) {
        const original = originalReceipts.find(value => value.intent.operationId === receipt.intent.operationId)!
        expect(receipt.native).toEqual(original.native)
        expect(receipt.terminal?.closureEvidenceDigest).toMatch(/^[a-f0-9]{64}$/)
      }
      const closed = fixture.registry.snapshot().launches.filter(owner => active.owners.some(
        original => original.launchId === owner.launchId))
      expect(closed.map(owner => owner.launchId).sort()).toEqual(active.owners.map(owner => owner.launchId).sort())
      expect(closed.every(owner => owner.lifecycle === 'closed' && owner.closureEvidence === 'cgroup_v2_empty')).toBe(true)
      expect(fixture.registry.snapshot().launches.filter(owner => active.owners.some(
        original => original.owner === owner.owner)).map(owner => owner.launchId).sort()).toEqual(ownerLaunchIds)
      const detail = await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return fixture.details(active.run.id)
      }, value => value.run.executionState === 'completed', 'settled Run after original worker closure')
      expect(detail.run.outcome).toBe('canceled')
      expect((await fixture.provider.calls()).filter(call => call.method === 'turn/start'
        && call.correlationId === active.job.correlationId)).toHaveLength(1)
    })
  }, 240_000)
})
