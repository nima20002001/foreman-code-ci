import assert from 'node:assert/strict'
import { describe, it } from 'vitest'
import { DistributedArtifactDeletionOwnership, type ArtifactPhysicalHoldPort } from '../src/modules/files/distributed/cleanup.js'
import type { FileCleanupCandidate } from '../src/modules/files/cleanup/repository.js'
import type { FileQuery } from '../src/modules/files/repository.js'

const candidate: FileCleanupCandidate = { fileId: 'exact-file', revisionId: 'exact-revision', storageKey: 'exact-storage-key',
  ownerPrincipalId: 'accepted-owner', requestId: 'original-publication', expiresAt: '2026-10-01T12:00:00.123456Z', retentionRevision: 2 }
const query: FileQuery = { query: async () => { throw new Error('Ownership inspection is provided by its actual producer') } }
const states = ['clear', 'held', 'unknown'] as const

describe('W09 physical deletion requires two positive ownership releases', () => {
  for (const transfer of states) for (const materialization of states) {
    it(`transfer ${transfer}, materialization ${materialization}`, async () => {
      const calls: { name: string; storageKey: string; sql: FileQuery }[] = []
      const port = (name: string, state: typeof states[number]): ArtifactPhysicalHoldPort => ({ inspect: async (storageKey, sql) => {
        calls.push({ name, storageKey, sql }); return state
      } })
      const ownership = new DistributedArtifactDeletionOwnership(port('transfer', transfer), port('materialization', materialization))
      assert.equal(await ownership.assertCanDelete(candidate, query), transfer === 'clear' && materialization === 'clear')
      assert.deepEqual(calls.map(call => call.name), transfer === 'clear' ? ['transfer', 'materialization'] : ['transfer'])
      for (const call of calls) { assert.equal(call.storageKey, candidate.storageKey); assert.equal(call.sql, query) }
    })
  }
  it('awaits transfer inspection before starting materialization inspection on the same SQL lease', async () => {
    let release!: () => void, materializationStarted = false
    const held = new Promise<void>(resolve => { release = resolve })
    const ownership = new DistributedArtifactDeletionOwnership({ inspect: async () => { await held; return 'clear' } },
      { inspect: async () => { materializationStarted = true; return 'clear' } })
    const pending = ownership.assertCanDelete(candidate, query)
    assert.equal(materializationStarted, false)
    release(); assert.equal(await pending, true); assert.equal(materializationStarted, true)
  })
  it('propagates failed ownership inspection without treating it as release evidence', async () => {
    let second = false
    const ownership = new DistributedArtifactDeletionOwnership({ inspect: async () => { throw new Error('ownership unavailable') } },
      { inspect: async () => { second = true; return 'clear' } })
    await assert.rejects(ownership.assertCanDelete(candidate, query), /ownership unavailable/)
    assert.equal(second, false)
  })
})
