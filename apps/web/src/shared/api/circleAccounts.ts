import { useQuery } from '@tanstack/react-query'
import { ManagedCircleAccountsSchema } from '@foreman-code/contracts/management'
import { apiClient } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export function useCircleAccountsQuery() {
  useHarnessSessionEpoch()
  return useQuery({
    queryKey: ['circle-accounts', sessionGeneration()],
    enabled: !sessionIsSwitching(),
    retry: false,
    refetchInterval: 5_000,
    queryFn: ({ signal }) => apiClient.request(
      '/api/management/settings/circle-accounts', ManagedCircleAccountsSchema, { signal }),
  })
}
