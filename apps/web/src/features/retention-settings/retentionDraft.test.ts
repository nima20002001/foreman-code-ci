import { describe, expect, it } from 'vitest'
import { FileRetentionPreferenceSchema, FileRetentionPreviewResultSchema } from '@foreman-code/contracts/files'
import { matchesRetentionPreview, retentionDraft, retentionSeconds } from './retentionDraft'

const preference = (durationSeconds: number) => FileRetentionPreferenceSchema.parse({
  ownerPrincipalId: 'retention-owner', durationSeconds, revision: 3,
})

describe('retention draft representation', () => {
  it.each([3_600, 3_601, 5_400, 86_400, 604_800, 31_536_000])('round trips %i server seconds', (seconds) => {
    expect(retentionSeconds(retentionDraft(preference(seconds)))).toBe(seconds)
  })

  it('shows whole days where exact and never assumes the server default', () => {
    expect(retentionDraft(preference(604_800))).toEqual({ amount: '7', unit: 'days', applyToExisting: false })
    expect(retentionDraft(preference(5_400))).toEqual({ amount: '1.5', unit: 'hours', applyToExisting: false })
  })

  it.each(['', ' ', '0', '-1', 'Infinity', 'NaN', 'hello', '0.5', '8761', '1.0001'])('rejects invalid hours %j', (amount) => {
    expect(retentionSeconds({ amount, unit: 'hours', applyToExisting: false })).toBeUndefined()
  })

  it('accepts decimal hours/days only when they represent bounded integer seconds', () => {
    expect(retentionSeconds({ amount: '1.5', unit: 'hours', applyToExisting: true })).toBe(5_400)
    expect(retentionSeconds({ amount: '0.5', unit: 'days', applyToExisting: true })).toBe(43_200)
    expect(retentionSeconds({ amount: '366', unit: 'days', applyToExisting: false })).toBeUndefined()
  })

  it('binds a confirmation to owner, revision, duration and explicit apply', () => {
    const preview = FileRetentionPreviewResultSchema.parse({
      ownerPrincipalId: 'retention-owner', preferenceRevision: 3, durationSeconds: 3_600,
      asOfUtc: '2026-09-28T05:00:00.000Z', expireNowCount: 2,
    })
    const draft = { amount: '1', unit: 'hours' as const, applyToExisting: true }
    expect(matchesRetentionPreview(preview, draft, 'retention-owner', 3)).toBe(true)
    expect(matchesRetentionPreview(preview, draft, 'other-owner', 3)).toBe(false)
    expect(matchesRetentionPreview(preview, draft, 'retention-owner', 4)).toBe(false)
    expect(matchesRetentionPreview(preview, { ...draft, amount: '2' }, 'retention-owner', 3)).toBe(false)
    expect(matchesRetentionPreview(preview, { ...draft, applyToExisting: false }, 'retention-owner', 3)).toBe(false)
    expect(matchesRetentionPreview(undefined, draft, 'retention-owner', 3)).toBe(false)
  })
})
