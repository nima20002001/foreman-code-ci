import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ManagedPromptSettingSchema,
  PromptSettingUpdateInputSchema,
  PromptSettingUpdateResultSchema,
  type PromptSettingUpdateInput,
} from '@foreman-code/contracts/management'
import { apiClient, ApiError } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export type PromptSettingsPage = 'system-prompt' | 'operator-initial-prompt'

export const promptSettingsKey = (page: PromptSettingsPage) =>
  ['workbench', 'management', 'settings', page, sessionGeneration()] as const

export function usePromptSettingQuery(page: PromptSettingsPage) {
  useHarnessSessionEpoch()
  return useQuery({
    queryKey: promptSettingsKey(page),
    enabled: !sessionIsSwitching(),
    retry: false,
    queryFn: ({ signal }) => apiClient.request(
      `/api/management/settings/${page}`, ManagedPromptSettingSchema, { signal },
    ),
  })
}

export function useUpdatePromptSettingMutation(page: PromptSettingsPage) {
  const client = useQueryClient()
  return useMutation({
    retry: false,
    onMutate: () => sessionGeneration(),
    mutationFn: (input: PromptSettingUpdateInput) => apiClient.request(
      `/api/management/settings/${page}`, PromptSettingUpdateResultSchema,
      { method: 'PUT', body: PromptSettingUpdateInputSchema.parse(input) },
    ),
    onSuccess: (result, _input, generation) => {
      if (generation !== sessionGeneration() || sessionIsSwitching()) return
      client.setQueryData(promptSettingsKey(page), result.value)
    },
    onError: async (error, _input, generation) => {
      if (generation !== sessionGeneration() || sessionIsSwitching()) return
      if (error instanceof ApiError && error.code === 'REVISION_CONFLICT') {
        await client.invalidateQueries({ queryKey: promptSettingsKey(page) })
      }
    },
  })
}
