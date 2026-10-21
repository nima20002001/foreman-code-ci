import { useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GeneralSettingsUpdateInputSchema, GeneralSettingsUpdateResultSchema, ManagedGeneralSettingsSchema,
  type GeneralSettingsUpdateInput, type ManagedGeneralSettings, type Theme } from '@foreman-code/contracts/management'
import { apiClient } from './client'
import { commandWasRejected } from './commandAttempt'
import { useHarnessSessionEpoch } from './harnessSettings'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'
import { useAccessFailureLatch } from './useAccessFailureLatch'

export function useGeneralSettings() {
  const generation = useHarnessSessionEpoch()
  const queryKey = ['general-settings', generation] as const
  const cache = useQueryClient()
  const keepLatest = (value: ManagedGeneralSettings) => {
    const current = cache.getQueryData<ManagedGeneralSettings>(queryKey)
    return current && current.revision > value.revision ? current : value
  }
  const settings = useQuery({ queryKey, retry: false, refetchInterval: 10_000,
    enabled: !sessionIsSwitching(),
    queryFn: async ({ signal }) => keepLatest(await apiClient.request(
      '/api/management/settings/general', ManagedGeneralSettingsSchema, { signal })),
  })
  const denied = useAccessFailureLatch(settings)
  const unconfirmed = useRef(false)
  const update = useMutation({ mutationKey: [...queryKey, 'update'], retry: false,
    mutationFn: (input: GeneralSettingsUpdateInput) => apiClient.request(
      '/api/management/settings/general', GeneralSettingsUpdateResultSchema,
      { method: 'PUT', body: GeneralSettingsUpdateInputSchema.parse(input) }),
    onSuccess: result => {
      unconfirmed.current = false
      if (sessionGeneration() === generation) cache.setQueryData(queryKey, keepLatest(result.value))
    },
    onError: error => { if (!commandWasRejected(error)) unconfirmed.current = true },
  })
  const uncertain = update.isError && (unconfirmed.current || !commandWasRejected(update.error))
  useEffect(() => {
    if (update.isError && !uncertain && !denied && settings.isSuccess
      && settings.dataUpdatedAt > update.submittedAt) update.reset()
  }, [update, uncertain, denied, settings.isSuccess, settings.dataUpdatedAt])
  const refresh = async () => {
    const result = await settings.refetch()
    if (!result.isError && !uncertain) update.reset()
  }
  const changeTheme = (theme: Theme) => {
    if (!settings.data || denied || settings.isError || update.isPending || update.isError || sessionIsSwitching()) return
    update.mutate({ value: { theme }, expectedRevision: settings.data.revision, commandId: crypto.randomUUID() })
  }
  return { settings, update, changeTheme, denied, uncertain, refresh, retry: () => {
    if (update.variables && !denied && !sessionIsSwitching()) update.mutate(update.variables)
  } }
}
