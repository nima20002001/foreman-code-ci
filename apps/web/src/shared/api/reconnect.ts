import { useEffect, useRef, useSyncExternalStore } from 'react'
import { onlineManager, useQuery, useQueryClient, type Query } from '@tanstack/react-query'
import { RuntimeIdentitySchema } from '@foreman-code/contracts'
import { ApiError, apiClient, isApiRestartError } from './client'
import { isTransientReadError } from './readFailure'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export const reconnectingMessage = 'Updating — reconnecting…'
const reconnectIntervalMs = 1_000

function needsReconnect(query: Query): boolean {
  return query.isActive() && query.meta?.refetchOnApiReconnect !== false
    && (isApiRestartError(query.state.error) || isApiRestartError(query.state.fetchFailureReason))
}

function isRecoverableError(error: unknown): boolean {
  return isApiRestartError(error)
    || ApiError.is(error) && error.status >= 500 && isTransientReadError(error)
}

function needsRecovery(query: Query): boolean {
  return query.isActive() && query.meta?.refetchOnApiReconnect !== false
    && (isRecoverableError(query.state.error) || isRecoverableError(query.state.fetchFailureReason))
}

function hasPendingRetry(query: Query): boolean {
  return query.isActive() && query.meta?.refetchOnApiReconnect !== false
    && query.state.status === 'pending' && query.state.errorUpdateCount > 0
}

function canRefetchAfterReconnect(query: Query): boolean {
  return query.meta?.refetchOnApiReconnect !== false
    && (!query.state.error || isTransientReadError(query.state.error))
}

/** Request failures stay in Query; recovery refreshes the other mounted reads too. */
export function useApiReconnect(): boolean {
  const client = useQueryClient()
  const cache = client.getQueryCache()
  const reconnecting = useSyncExternalStore(
    listener => cache.subscribe(listener),
    () => cache.getAll().some(needsReconnect),
  )
  const recovering = useSyncExternalStore(
    listener => cache.subscribe(listener),
    () => cache.getAll().some(needsRecovery),
  )
  const retrying = useSyncExternalStore(
    listener => cache.subscribe(listener),
    () => cache.getAll().some(hasPendingRetry),
  )
  const online = useSyncExternalStore(
    listener => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
  )
  const probeFailed = useRef(false)
  // Probe independently of paused reads and identity retries waiting in backoff.
  useQuery({
    queryKey: ['workbench', 'api-reachability', sessionGeneration()],
    enabled: (recovering || !online) && !sessionIsSwitching(),
    networkMode: 'always', retry: false, staleTime: 0, gcTime: 0,
    refetchInterval: reconnectIntervalMs, refetchIntervalInBackground: true,
    refetchOnReconnect: false, meta: { refetchOnApiReconnect: false },
    queryFn: async ({ signal }) => {
      let identity
      try {
        identity = await apiClient.request('/api/runtime/identity', RuntimeIdentitySchema, { signal })
      } catch (error) {
        probeFailed.current = true
        throw error
      }
      onlineManager.setOnline(true)
      if (probeFailed.current) {
        probeFailed.current = false
        void client.invalidateQueries({
          refetchType: 'active',
          predicate: canRefetchAfterReconnect,
        })
      }
      return identity
    },
  })
  const wasReconnecting = useRef(false)
  useEffect(() => {
    if (!recovering && online) {
      // A retry without cached data clears its error before a response arrives.
      if (retrying) return
      if (wasReconnecting.current) void client.invalidateQueries({
        refetchType: 'active',
        predicate: canRefetchAfterReconnect,
      })
      wasReconnecting.current = false
      return
    }
    wasReconnecting.current = true
    if (!online) return
    const timer = window.setInterval(() => {
      void client.refetchQueries({ predicate: needsRecovery, type: 'active' }, { cancelRefetch: false })
    }, reconnectIntervalMs)
    return () => window.clearInterval(timer)
  }, [client, recovering, retrying, online])
  return reconnecting || !online
}
