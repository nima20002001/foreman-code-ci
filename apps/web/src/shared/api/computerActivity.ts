import { queryOptions, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { ComputerActivityListSchema, ComputerRenameInputSchema, ComputerRenameResultSchema } from '@foreman-code/contracts/computer-activity'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { TELEMETRY_LIMITS, TelemetrySelectorResultSchema } from '@foreman-code/contracts/resource-telemetry'
import { apiClient, ApiError } from './client'
import { readResourceTelemetry } from './resourceTelemetry'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export function computerKey(target: Pick<DeviceProvisioningTarget, 'hostRef'>) {
  const host = target.hostRef
  return `${host.mainId}:${host.kind === 'main' ? 'main' : host.deviceId}`
}
/** Saved computer names by computerKey, for labels built outside a React tree. Without settings access the
 * caller keeps its default labels. */
export async function readComputerNames(signal?: AbortSignal): Promise<ReadonlyMap<string, string>> {
  try {
    const activity = await apiClient.request('/api/management/computers/activity', ComputerActivityListSchema, { signal })
    return new Map(activity.computers.map(computer => [computerKey(computer.target), computer.name]))
  } catch (error) {
    if (signal?.aborted) throw error
    // ignore: names need settings:read; an unreadable list only leaves the default computer labels.
    return new Map()
  }
}
export function useComputerActivity() {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: ['computer-activity', sessionGeneration()], enabled: !sessionIsSwitching(),
    retry: false, refetchInterval: 5_000,
    queryFn: ({ signal }) => apiClient.request('/api/management/computers/activity', ComputerActivityListSchema, { signal }) })
}
/** Saves a computer's name; every list refreshes from the activity readback. */
export function useRenameComputer() {
  const client = useQueryClient()
  return useMutation({ retry: false,
    mutationFn: (input: { target: DeviceProvisioningTarget; name: string }) => apiClient.request(
      '/api/management/computers/rename', ComputerRenameResultSchema,
      { method: 'POST', body: ComputerRenameInputSchema.parse(input) }),
    onSettled: () => client.invalidateQueries({ queryKey: ['computer-activity'] }) })
}
function computerUtilizationOptions(target: DeviceProvisioningTarget, online: boolean) {
  return queryOptions({ queryKey: ['computer-utilization', sessionGeneration(), target],
    enabled: online && !sessionIsSwitching(), retry: false, gcTime: 0, refetchInterval: TELEMETRY_LIMITS.intervalMs,
    queryFn: async ({ signal }) => {
      const resolved = await apiClient.request('/api/management/resource-telemetry/selector',
        TelemetrySelectorResultSchema, { method: 'POST', signal,
          body: { schemaVersion: 1, scope: 'computer', mainId: target.hostRef.mainId, hostRef: target.hostRef } })
      if (resolved.kind !== 'selector') return null
      const selector = resolved.selector
      if (selector.scope !== 'computer' || computerKey(selector.host) !== computerKey(target)
        || selector.host.applicationInstallationId !== target.applicationInstallationId
        || selector.host.keyRevision !== target.keyRevision
        || selector.host.authorizationRevision !== target.authorizationRevision) {
        throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Utilization belongs to another computer.' })
      }
      return readResourceTelemetry(selector, { signal })
    } })
}

export function useComputerUtilization(target: DeviceProvisioningTarget, online: boolean) {
  useHarnessSessionEpoch()
  return useQuery(computerUtilizationOptions(target, online))
}

/** Shares the same per-computer cache and polling as the individual detail cards. */
export function useComputerUtilizations(computers: { target: DeviceProvisioningTarget; online: boolean }[]) {
  useHarnessSessionEpoch()
  return useQueries({ queries: computers.map(computer => computerUtilizationOptions(computer.target, computer.online)) })
}
