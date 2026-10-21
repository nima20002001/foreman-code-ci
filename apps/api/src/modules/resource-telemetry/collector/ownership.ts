import type { TelemetrySelector } from '@foreman-code/contracts/resource-telemetry'
import type { AccountingHandle } from './linuxCgroup.js'
import type { ProcessIdentity } from './processSet.js'

/** Local read capability, projected by existing HRT/W08/CI owners, never deserialized from telemetry. */
export interface OwnershipView {
  selector: Extract<TelemetrySelector, { scope: 'owned' }>
  leaseId: string
  launchIds: readonly string[]
  observedDeviceId: string
  observedInstallationId: string
  roots: readonly ProcessIdentity[]
  accountingHandles: readonly AccountingHandle[]
  accountingIncomplete?: boolean
  captureTruncated?: boolean
  shared: boolean
  lifecycle: 'active' | 'ended' | 'closure-unconfirmed' | 'closed'
}
export interface OwnershipSnapshot { revision: string; views: readonly OwnershipView[] }
export interface OwnershipReader {
  /** Atomic snapshot or internally revision/re-read; must not call mutating recovery inventory. */
  snapshot(signal: AbortSignal): Promise<OwnershipSnapshot>
  /** Ordered passive publication; gap -> take a new atomic snapshot. */
  changes(afterRevision: string, signal: AbortSignal): AsyncIterable<{ revision: string; gap: boolean }>
}
/** Consume existing producers with revision retry; this stores no ownership authority. */
export function revisionedOwnershipReader(source: {
  revision(): string
  read(signal: AbortSignal): Promise<readonly OwnershipView[]>
  changes(afterRevision: string, signal: AbortSignal): AsyncIterable<{ revision: string; gap: boolean }>
}): OwnershipReader {
  return { async snapshot(signal) {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted()
      const revision = source.revision()
      const views = await source.read(signal)
      if (revision === source.revision()) return { revision, views }
    }
    throw new Error('ownership-changed')
  }, changes: (revision, signal) => source.changes(revision, signal) }
}
