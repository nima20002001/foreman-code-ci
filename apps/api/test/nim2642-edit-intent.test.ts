import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { CurrentJournalRunPinSchema, type CurrentJournalRunState } from '@foreman-code/contracts/wave25'
import { currentSaveAdmissionFixture } from './helpers/currentSaveAdmission.js'
import { readAffectedGraphRuns } from '../src/modules/graph-drafts/saveAdmission.js'
import { sameAffectedSet } from '../src/modules/graph-drafts/durableEditIntent.js'
import { CANCELED_INTERACTION_RETIRED_SQL } from '../src/modules/interactions/wave25/publication.js'

const { pin, row } = currentSaveAdmissionFixture('edit-intent')
const settled: CurrentJournalRunState = { pin, terminal: true, settled: true, outcome: 'succeeded',
  nativePending: false, cleanupPending: false, interactionPending: false, reviewPending: false }
const scope = { workspaceId: pin.workspaceId, workflowId: pin.workflowId, stagedAgentIds: ['shared'] }

describe('NIM-2642 exact affected-set and current settlement mapping', () => {
  it('keeps outcome changes independent of immutable accepted identities', () => {
    expect(sameAffectedSet({ affected: [pin] }, [settled])).toBe(true)
    expect(sameAffectedSet({ affected: [pin] }, [{ ...settled, outcome: 'failed' }])).toBe(true)
    expect(sameAffectedSet({ affected: [pin] }, [{ ...settled, settled: false }])).toBe(true)
  })
  it.each(['runId', 'workflowId', 'workflowVersionId', 'workspaceId'] as const)('rejects changed %s even after terminal settlement', (field) => {
    expect(sameAffectedSet({ affected: [pin] }, [{ ...settled, pin: { ...pin, [field]: 'other' } }])).toBe(false)
  })
  it('rejects added/missing Runs and changed Agent or semantics pins', () => {
    expect(sameAffectedSet({ affected: [pin] }, [])).toBe(false)
    expect(sameAffectedSet({ affected: [pin] }, [settled, { ...settled, pin: { ...pin, runId: 'new' } }])).toBe(false)
    const retired = { ...settled, pin: { ...pin, executionSemanticsVersion: 2 } }
    expect(CurrentJournalRunPinSchema.safeParse(retired.pin).success).toBe(false)
    // Deliberately corrupted persisted input: the comparator must not erase
    // the pin difference even before the current journal parser rejects it.
    expect(sameAffectedSet({ affected: [pin] }, [retired as unknown as CurrentJournalRunState])).toBe(false)
    expect(sameAffectedSet({ affected: [pin] }, [{ ...settled, pin: { ...pin, agentConfigurationVersionIds: { agent: 'new' } } }])).toBe(false)
  })
  it('requires the canceled retirement source receipt and counts unlaunched reviews by owning interaction', async () => {
    // The Run has no executions, so its canonical native-settlement page is empty.
    const query = vi.fn(async (text: string) => text.startsWith('select e.id,e.run_id,') ? { rows: [], rowCount: 0 } : { rows: [row], rowCount: 1 })
    const result = await readAffectedGraphRuns({ query } as unknown as Pick<pg.PoolClient, 'query'>, scope)
    expect(result).toEqual([settled])
    // The first query only locks the affected parents; this one computes every obligation flag.
    const [sql] = query.mock.calls.find(([text]) => text.includes(' as terminal'))! as unknown as [string, unknown[]]
    expect(sql).toContain(CANCELED_INTERACTION_RETIRED_SQL)
    expect(sql).toContain('review_owner.id=j.interaction_id')
    expect(sql).toContain('review_owner.run_id=r.id')
    expect(sql).toContain("e.record->'result'->>'outcome'")
    expect(sql).toContain('workflow_finalized_at is not null')
    expect(sql).toContain('b.revoked_at is null')
    expect(sql).toContain("v.record->'agentConfigurationVersionIds'=r.record->'agentConfigurationVersionIds'")
    expect(sql).not.toMatch(/\b(insert|update|delete)\b/i)
    expect(sql).not.toMatch(/order by r\.id\s+limit/i)
  })
  it.each(['cleanup', 'native', 'interactions', 'reviews'] as const)('waits beyond terminal on %s, including absent evidence', async (field) => {
    for (const value of [true, null, undefined]) {
      const query = vi.fn(async () => ({ rows: [{ ...row, [field]: value }], rowCount: 1 }))
      const [state] = await readAffectedGraphRuns({ query } as unknown as Pick<pg.PoolClient, 'query'>, scope)
      expect(state?.terminal).toBe(true); expect(state?.settled).toBe(false)
    }
  })
  it('does not promote unknown terminal evidence to settled', async () => {
    const query = vi.fn(async () => ({ rows: [{ ...row, terminal: undefined }], rowCount: 1 }))
    expect((await readAffectedGraphRuns({ query } as unknown as Pick<pg.PoolClient, 'query'>, scope))[0]?.settled).toBe(false)
  })
})
