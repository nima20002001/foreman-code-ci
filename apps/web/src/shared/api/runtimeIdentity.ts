import { useCallback, useLayoutEffect, useSyncExternalStore } from 'react'
import { RuntimeIdentitySchema, RuntimeBuildIdentitySchema, type RuntimeIdentity, type RuntimeBuildIdentity } from '@foreman-code/contracts'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { documentBuildIdentity } from './documentBuildIdentity'
import { ApiError, apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

function runtimeIdentityKey(generation: number) {
  return ['workbench', 'runtime-identity', generation] as const
}

export function useRuntimeInstallationId() {
  const generation = useHarnessSessionEpoch()
  const client = useQueryClient()
  const subscribe = useCallback((changed: () => void) => client.getQueryCache().subscribe(changed), [client])
  const snapshot = useCallback(() => client.getQueryData<RuntimeIdentity>(runtimeIdentityKey(generation))?.installationId,
    [client, generation])
  // Installation ownership must update before batched query observer notifications.
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}

export function useRuntimeIdentityQuery() {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: runtimeIdentityKey(sessionGeneration()),
    retry: (_failureCount, error) => ApiError.is(error)
      && (error.code === 'NETWORK_ERROR' || error.status >= 500),
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 10_000),
    enabled: !sessionIsSwitching(), staleTime: 0, refetchInterval: 60_000,
    queryFn: ({ signal }) => apiClient.request('/api/runtime/identity', RuntimeIdentitySchema, { signal }) })
}

function runtimeBuildIdentityKey(generation: number) {
  return ['workbench', 'runtime-build-identity', generation] as const
}

export function useRuntimeBuildIdentityQuery(guardRequests = false) {
  useHarnessSessionEpoch()
  const client = useQueryClient()
  useLayoutEffect(() => {
    if (!guardRequests) return
    return apiClient.bindRuntimeCompatibility(() => {
      const build = client.getQueryData<RuntimeBuildIdentity>(runtimeBuildIdentityKey(sessionGeneration()))
      return !build || build.contractsId === documentBuildIdentity.contractsId
    })
  }, [client, guardRequests])
  return useQuery({ queryKey: runtimeBuildIdentityKey(sessionGeneration()),
    retry: (_failureCount, error) => ApiError.is(error)
      && (error.code === 'NETWORK_ERROR' || error.status >= 500),
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 10_000),
    enabled: !sessionIsSwitching(), staleTime: 0, refetchInterval: 60_000,
    queryFn: ({ signal }) => apiClient.request('/api/runtime/build-identity/v1', RuntimeBuildIdentitySchema, { signal }) })
}
