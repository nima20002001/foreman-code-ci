import { telemetryCanonical } from '@foreman-code/contracts/resource-telemetry'
import type { NativeLaunchObservation, NativeProcessRegistry } from '../../harnesses/recovery/processRegistry.js'
export type { NativeLaunchObservation } from '../../harnesses/recovery/processRegistry.js'
import { accountingHandle } from './linuxCgroup.js'
import { revisionedOwnershipReader, type OwnershipReader, type OwnershipView } from './ownership.js'

/** Structural read-only subset of HRT's existing registry. No recovery/mutation methods are exposed. */
export type PassiveNativeRegistry = Pick<NativeProcessRegistry, 'revision' | 'snapshot' | 'changes'>
/** Resolved from existing accepted HRT/W08/CI facts; owner strings are exact joins only. */
export interface TrustedNativeScope extends Omit<OwnershipView, 'roots' | 'accountingHandles' | 'launchIds'> {
  nativeOwner: string
  /** Original host-side OCI owner certificates, never incoming telemetry data. */
  captured?: { launchIds: readonly string[]; roots: OwnershipView['roots'];
    boundaries: readonly OwnershipView['accountingHandles'][number]['boundary'][]; incomplete: boolean }
}
export interface TrustedNativeScopes {
  revision(): string
  snapshot(signal: AbortSignal): Promise<readonly TrustedNativeScope[]>
  changes(afterRevision: string, signal: AbortSignal): AsyncIterable<{ revision: string; gap: boolean }>
}
export function passiveRegistryOwnershipReader(registry: PassiveNativeRegistry, scopes: TrustedNativeScopes): OwnershipReader {
  const revision = () => telemetryCanonical([registry.revision(), scopes.revision()])
  let observedLaunches: readonly NativeLaunchObservation[] | undefined
  let launchesByOwner = new Map<string, NativeLaunchObservation[]>()
  return revisionedOwnershipReader({ revision,
    async read(signal) {
      const native = registry.snapshot()
      if (native.launches !== observedLaunches) {
        launchesByOwner = new Map()
        for (const launch of native.launches) {
          let launches = launchesByOwner.get(launch.owner)
          if (!launches) {
            launches = []
            launchesByOwner.set(launch.owner, launches)
          }
          launches.push(launch)
        }
        observedLaunches = native.launches
      }
      const indexedLaunches = launchesByOwner
      const owners = await scopes.snapshot(signal)
      signal.throwIfAborted()
      let remaining = 4096
      return owners.slice(0, 65).map(scope => {
        let captureTruncated = false
        let accountingIncomplete = scope.captured?.incomplete ?? false
        const launches = indexedLaunches.get(scope.nativeOwner) ?? []
        const roots = new Map<string, OwnershipView['roots'][number]>()
        const handles: OwnershipView['accountingHandles'][number][] = []
        const certifiedRoots = scope.captured?.roots ?? []
        if (certifiedRoots.length > 4096) captureTruncated = true
        for (const process of certifiedRoots.slice(0, 4096)) {
          if (process.bootId !== scope.selector.host.bootId || scope.lifecycle === 'closed') continue
          const key = `${process.bootId}:${process.pid}:${process.startTicks}`
          if (!roots.has(key)) { if (remaining > 0) { roots.set(key, { ...process }); remaining-- } else captureTruncated = true }
        }
        if (scope.lifecycle !== 'closed') for (const boundary of scope.captured?.boundaries ?? []) {
          if (handles.length < 9) handles.push(accountingHandle(boundary, !scope.shared)); else captureTruncated = true
        }
        for (const launch of launches) {
          if (launch.bootId !== scope.selector.host.bootId || launch.lifecycle === 'closed') continue
          for (const process of [launch.guardian, launch.provider]) if (process) {
            const identity = { bootId: launch.bootId, ...process }
            const key = `${identity.bootId}:${identity.pid}:${identity.startTicks}`
            if (!roots.has(key)) { if (remaining > 0) { roots.set(key, identity); remaining-- } else captureTruncated = true }
          }
          if (launch.boundary) { if (handles.length < 9) handles.push(accountingHandle(launch.boundary, !scope.shared)); else captureTruncated = true }
          else accountingIncomplete = true
        }
        return { selector: scope.selector, leaseId: scope.leaseId, launchIds: [...new Set([...launches.map(launch => launch.launchId), ...(scope.captured?.launchIds ?? [])])],
          observedDeviceId: scope.observedDeviceId, observedInstallationId: scope.observedInstallationId,
          captureTruncated, accountingIncomplete, shared: scope.shared, lifecycle: scope.lifecycle, roots: [...roots.values()], accountingHandles: handles }
      })
    },
    changes: (afterRevision, signal) => joinedChanges(registry, scopes, afterRevision, signal),
  })
}
/** Two passive subscriptions, one bounded invalidation queue. Overflow explicitly requires resnapshot. */
async function* joinedChanges(registry: PassiveNativeRegistry, scopes: TrustedNativeScopes, afterRevision: string, signal: AbortSignal): AsyncIterable<{ revision: string; gap: boolean }> {
  const controller = new AbortController()
  const queue: Array<{ revision: string; gap: boolean }> = []
  let wake: (() => void) | undefined
  let finished = 0; let error: unknown
  const abort = () => { controller.abort(); wake?.(); wake = undefined }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const revisions = JSON.parse(afterRevision) as unknown
  if (!Array.isArray(revisions) || revisions.length !== 2 || revisions.some(value => typeof value !== 'string')) {
    signal.removeEventListener('abort', abort); throw new Error('ownership-changed')
  }
  const pump = async (source: AsyncIterable<{ revision: string; gap: boolean }>) => {
    try {
      for await (const change of source) {
        if (controller.signal.aborted) break
        const gap = change.gap || queue.length >= 2
        if (queue.length >= 2) { queue.shift(); if (queue[0]) queue[0].gap = true }
        queue.push({ revision: telemetryCanonical([registry.revision(), scopes.revision()]), gap }); wake?.(); wake = undefined
      }
    } catch (failure) { if (!controller.signal.aborted) { error = failure; abort() } }
    finally { finished++; wake?.(); wake = undefined }
  }
  const tasks = [pump(registry.changes(revisions[0] as string, controller.signal)), pump(scopes.changes(revisions[1] as string, controller.signal))]
  try {
    while (!controller.signal.aborted && (finished < 2 || queue.length)) {
      if (queue.length) { yield queue.shift()!; continue }
      await new Promise<void>(resolve => { wake = resolve; if (controller.signal.aborted || finished === 2) { wake = undefined; resolve() } })
    }
    if (error) throw error
  } finally { abort(); signal.removeEventListener('abort', abort); await Promise.allSettled(tasks) }
}
