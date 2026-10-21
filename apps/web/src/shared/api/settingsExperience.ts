import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ManagedWorkspaceDefaultsSchema, WorkspaceDefaultsSchema, WorkspaceDefaultsUpdateInputSchema, WorkspaceDefaultsUpdateResultSchema,
  LocalHumanAccessSchema, type WorkspaceDefaultsUpdateInput } from '@foreman-code/contracts/management'
import { apiClient, type RequestOptions } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export const settingsExperienceKeys = {
  workspaceDefaults: () => ['workbench', 'management', 'settings', 'workspaces', sessionGeneration()] as const,
  workspaceCreation: () => ['workbench', 'management', 'workspace-creation', sessionGeneration()] as const,
  access: () => ['workbench', 'local-human', sessionGeneration()] as const,
}
export function useWorkspaceDefaultsQuery() {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: settingsExperienceKeys.workspaceDefaults(), enabled: !sessionIsSwitching(), retry: false,
    queryFn: ({ signal }) => apiClient.request('/api/management/settings/workspaces', ManagedWorkspaceDefaultsSchema, { signal }) })
}
export function useWorkspaceCreationDefaultsQuery(enabled: boolean) {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: settingsExperienceKeys.workspaceCreation(), enabled: enabled && !sessionIsSwitching(), retry: false,
    queryFn: ({ signal }) => apiClient.request('/api/management/settings/workspaces/creation', WorkspaceDefaultsSchema, { signal }) })
}
export function useUpdateWorkspaceDefaultsMutation() {
  const client = useQueryClient()
  return useMutation({ retry: false, onMutate: () => sessionGeneration(), mutationFn: (input: WorkspaceDefaultsUpdateInput) =>
    apiClient.request('/api/management/settings/workspaces', WorkspaceDefaultsUpdateResultSchema, { method: 'PUT', body: WorkspaceDefaultsUpdateInputSchema.parse(input) }),
    onSuccess: (result, _input, epoch) => {
      if (epoch !== sessionGeneration() || sessionIsSwitching()) return
      client.setQueryData(settingsExperienceKeys.workspaceDefaults(), result.value)
      // A cache refresh failure does not turn a committed save into a failed write.
      void client.invalidateQueries({ queryKey: settingsExperienceKeys.workspaceCreation() }).catch(() => undefined)
    },
  })
}
export function readLocalHumanAccess(options?: RequestOptions) {
  return apiClient.request('/api/local-human', LocalHumanAccessSchema, options)
}
export function useLocalHumanAccessQuery() {
  useHarnessSessionEpoch()
  return useQuery({ queryKey: settingsExperienceKeys.access(), enabled: !sessionIsSwitching(), retry: false, staleTime: 0, refetchInterval: 60_000,
    queryFn: ({ signal }) => readLocalHumanAccess({ signal }) })
}
