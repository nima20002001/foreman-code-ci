import { useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { TELEMETRY_LIMITS, TelemetryReadResultSchema, TelemetrySelectorSchema, telemetrySelectorKey, type TelemetryReadResult, type TelemetrySelector } from '@foreman-code/contracts/resource-telemetry'
import { apiClient, ApiError } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export const RESOURCE_TELEMETRY_READ_PATH = '/api/management/resource-telemetry/read'

/** Preserve server facts; display ages add the full request duration plus monotonic elapsed since arrival. */
export interface ReceivedTelemetry {
  selectorKey: string
  result: TelemetryReadResult
  receivedMonoMs: number
  requestDurationMs: number
}

export const resourceTelemetryKeys = {
  root: ['workbench', 'resource-telemetry'] as const,
  /** The full shared selector key already carries main/host/boot/generation/placement/owner/attribution fields. */
  read: (selectorKey: string) => [...resourceTelemetryKeys.root, sessionGeneration(), selectorKey] as const,
}

function mismatch(): ApiError {
  return new ApiError({ code: 'INVALID_RESPONSE', message: 'Telemetry readback belongs to a different selection.' })
}

/** Rejects any response whose own selector key differs from the one requested, including lastKnown. */
export function assertTelemetryMatchesSelector(result: TelemetryReadResult, selectorKey: string): void {
  if (result.kind === 'sample') {
    if (result.sample.selectorKey !== selectorKey || (result.lastKnown && result.lastKnown.selectorKey !== selectorKey)) throw mismatch()
  } else if (result.selectorKey !== selectorKey || (result.kind === 'no-sample' && telemetrySelectorKey(result.selector) !== selectorKey)) throw mismatch()
}

export async function readResourceTelemetry(selector: TelemetrySelector, options: { signal?: AbortSignal } = {}): Promise<ReceivedTelemetry> {
  const body = TelemetrySelectorSchema.parse(selector)
  const selectorKey = telemetrySelectorKey(body)
  const requestedMonoMs = performance.now()
  try {
    const result = await apiClient.request(RESOURCE_TELEMETRY_READ_PATH, TelemetryReadResultSchema, { method: 'POST', body, signal: options.signal })
    options.signal?.throwIfAborted()
    assertTelemetryMatchesSelector(result, selectorKey)
    const receivedMonoMs = performance.now()
    return { selectorKey, result, receivedMonoMs, requestDurationMs: Math.max(0, receivedMonoMs - requestedMonoMs) }
  } catch (error) {
    // The service answers a caller denial with HTTP 403 and no private values; keep it distinct from OS permission-denied.
    if (error instanceof ApiError && error.status === 403) {
      const receivedMonoMs = performance.now()
      return { selectorKey, result: { kind: 'denied', selectorKey }, receivedMonoMs, requestDurationMs: Math.max(0, receivedMonoMs - requestedMonoMs) }
    }
    throw error
  }
}

/** Removes every cached private reading, e.g. on denial or principal change. */
export function clearResourceTelemetry(client: QueryClient): void {
  client.removeQueries({ queryKey: resourceTelemetryKeys.root })
}

function parseSelector(selector: TelemetrySelector | undefined) {
  if (!selector) return undefined
  const parsed = TelemetrySelectorSchema.safeParse(selector)
  return parsed.success ? { selector: parsed.data, key: telemetrySelectorKey(parsed.data) } : undefined
}

/**
 * One query per full selector key. Switching selection unsubscribes the previous key (aborting its request) and a
 * revisit starts a fresh request: nothing is retained (gcTime 0), so a late A response cannot land on a later A visit.
 * Mount only for open Info surfaces; never one subscription per graph node.
 */
export function useResourceTelemetryQuery(selector: TelemetrySelector | undefined, options: { enabled?: boolean } = {}) {
  const epoch = useHarnessSessionEpoch()
  const client = useQueryClient()
  const parsed = useMemo(() => parseSelector(selector), [selector])
  // Principal/session switches drop private values immediately.
  const seenEpoch = useRef(epoch)
  useEffect(() => {
    if (seenEpoch.current === epoch) return
    seenEpoch.current = epoch
    clearResourceTelemetry(client)
  }, [client, epoch])
  const query = useQuery<ReceivedTelemetry>({
    queryKey: parsed ? resourceTelemetryKeys.read(parsed.key) : [...resourceTelemetryKeys.root, sessionGeneration(), 'unselected'],
    enabled: Boolean(parsed) && (options.enabled ?? true) && !sessionIsSwitching(),
    retry: false, gcTime: 0, structuralSharing: false, refetchIntervalInBackground: false,
    refetchInterval: current => {
      const data = current.state.data
      if (data?.result.kind === 'denied') return false
      if (data?.result.kind === 'sample' && ['ended', 'closed'].includes(data.result.sample.ownershipState)) return false
      return TELEMETRY_LIMITS.intervalMs
    },
    queryFn: ({ signal }) => readResourceTelemetry(parsed!.selector, { signal }),
  })
  // A cached value for a different key must never be shown for this selection.
  const data = parsed && query.data?.selectorKey === parsed.key ? query.data : undefined
  return { ...query, data, selectorKey: parsed?.key }
}
