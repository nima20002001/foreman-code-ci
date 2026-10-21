import {
  FileRetentionDurationSchema,
  type FileRetentionPreference,
  type FileRetentionPreviewResult,
} from '@foreman-code/contracts/files'

export type RetentionUnit = 'hours' | 'days'
/** Local form representation only; all HTTP/domain shapes come from shared contracts. */
export interface RetentionDraft {
  amount: string
  unit: RetentionUnit
  applyToExisting: boolean
}
export const secondsPerUnit: Readonly<Record<RetentionUnit, number>> = { hours: 3_600, days: 86_400 }

export function retentionDraft(preference: FileRetentionPreference): RetentionDraft {
  const unit = preference.durationSeconds % secondsPerUnit.days === 0 ? 'days' : 'hours'
  return { amount: String(preference.durationSeconds / secondsPerUnit[unit]), unit, applyToExisting: false }
}

export function retentionSeconds(draft: RetentionDraft): number | undefined {
  if (!draft.amount.trim()) return undefined
  const seconds = Number(draft.amount) * secondsPerUnit[draft.unit]
  const rounded = Math.round(seconds)
  // Accommodate floating-point round trips of integer server seconds, not fractional seconds.
  if (!Number.isFinite(seconds) || Math.abs(seconds - rounded) > 0.000001) return undefined
  const parsed = FileRetentionDurationSchema.safeParse(rounded)
  return parsed.success ? parsed.data : undefined
}

export function matchesRetentionPreview(
  preview: FileRetentionPreviewResult | undefined,
  draft: RetentionDraft | undefined,
  ownerPrincipalId: string | undefined,
  revision: number | undefined,
): boolean {
  return Boolean(preview && draft?.applyToExisting && preview.ownerPrincipalId === ownerPrincipalId
    && preview.preferenceRevision === revision && preview.durationSeconds === retentionSeconds(draft))
}
