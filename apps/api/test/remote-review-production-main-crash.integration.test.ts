import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { retainedReviewRecovery, useRemoteReviewFixture, waitForReplacementReviewInventory }
  from './helpers/remoteReviewProductionCases.js'
import { harnessConnectionGeneration } from '../src/modules/harnesses/hostConnectionGeneration.js'

const withRemoteReviewFixture = useRemoteReviewFixture()

describe('production remote review and native recovery through authenticated MCP', () => {
  it.each([false, true])('waits for boot-scoped installations (Worker restarted: %s)', async restarted => {
    await withRemoteReviewFixture(async fixture => {
      const previous = await fixture.inventory()
      const connection = previous.hostMetadata!.connection!
      const binding = { ...connection.binding, connectionEpoch: 'replacement-connection',
        bootId: restarted ? randomUUID() : connection.binding.bootId,
        connectionGeneration: connection.binding.connectionGeneration + 1 }
      const connecting = { ...previous, installations: [],
        hostMetadata: { ...previous.hostMetadata!, connection: { ...connection, binding } } }
      const ready = { ...connecting, installations: previous.installations.map(installation => ({
        ...installation, connectionGeneration: harnessConnectionGeneration(binding),
      })) }
      const snapshots = [connecting, { ...connecting, installations: previous.installations }, ready]
      let reads = 0
      const inventory = await waitForReplacementReviewInventory({ profiles: fixture.profiles, inventory: async () => {
        return snapshots[reads++]!
      } }, previous)
      expect(inventory).toEqual(ready)
      expect(reads).toBe(restarted ? 3 : 2)
    })
  })

  it.each(['crash'] as const)(
    'continues the original retained review after Main recovery from %s with the Worker alive', async recovery => {
      await withRemoteReviewFixture(async fixture => {
        const recovered = await retainedReviewRecovery(fixture, recovery)
        const details = await fixture.details(recovered.runId)
        expect(details.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
        expect(details.run.stopCause).toBeUndefined()
        expect(details.cleanupPending).toBe(false)
        const closed = fixture.registry.snapshot().launches.filter(owner => recovered.launchIds.includes(owner.launchId))
        expect(closed.map(owner => owner.launchId).sort()).toEqual(recovered.launchIds)
        expect(closed.every(owner => owner.lifecycle === 'closed'
          && owner.closureEvidence === 'cgroup_v2_empty')).toBe(true)
      })
    // Two full agent startups (reviewer, then requester) and a Main restart: ~60 s under a full parallel run.
    // The file stays within the suite's three-minute limit.
    }, 120_000,
  )
})
