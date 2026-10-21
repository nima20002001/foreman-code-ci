import { isRecord } from '../../shared/records'
/** Arrays are atomic: ordered permission policies must never be merged by index. */
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right) }
export interface SettingsChange { path: string; before: unknown; after: unknown }

export function settingsChanges(before: unknown, after: unknown, prefix = ''): SettingsChange[] {
  if (same(before, after)) return []
  if (isRecord(before) && isRecord(after)) {
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].flatMap((key) =>
      settingsChanges(before[key], after[key], prefix ? `${prefix}.${key}` : key))
  }
  return [{ path: prefix || 'Settings', before, after }]
}

/** Explicit keep-my-edits action. Locally changed leaves win; untouched leaves use current defaults. */
export function reapplySettingsEdits<T>(base: T, draft: T, latest: T): T {
  if (same(base, draft)) return structuredClone(latest)
  if (isRecord(base) && isRecord(draft) && isRecord(latest)) {
    // A provider change is an atomic replacement, not a union of incompatible configurations.
    if (typeof base.harness === 'string' && typeof draft.harness === 'string' && typeof latest.harness === 'string'
      && (base.harness !== draft.harness || base.harness !== latest.harness)) return structuredClone(draft)
    if ('configuration' in base && isRecord(base.configuration) && isRecord(draft.configuration) && isRecord(latest.configuration)
      && typeof base.configuration.harness === 'string' && typeof draft.configuration.harness === 'string'
      && typeof latest.configuration.harness === 'string'
      && (base.configuration.harness !== draft.configuration.harness || base.configuration.harness !== latest.configuration.harness)) return structuredClone(draft)
    const result: Record<string, unknown> = structuredClone(latest)
    for (const key of new Set([...Object.keys(base), ...Object.keys(draft)])) {
      if (same(base[key], draft[key])) continue
      if (!Object.hasOwn(draft, key)) delete result[key]
      else Object.defineProperty(result, key, { value: reapplySettingsEdits(base[key], draft[key], latest[key]),
        writable: true, enumerable: true, configurable: true })
    }
    return result as T
  }
  return structuredClone(draft)
}
