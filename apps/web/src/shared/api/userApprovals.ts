import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiClient } from './client'

export type UserApprovalResponseInput = Parameters<typeof apiClient.respondToUserInteraction>[0]

export function useUserInteractionQuery(interactionId: string) {
  return useQuery({
    queryKey: ['user-approval', interactionId],
    queryFn: ({ signal }) => apiClient.getUserInteraction(interactionId, { signal }),
    retry: false, gcTime: 0, staleTime: 0, refetchInterval: 5_000,
  })
}

export function useUserInteractionResponse() {
  const client = useQueryClient()
  return useMutation({
    mutationKey: ['user-approval-response'],
    mutationFn: (input: UserApprovalResponseInput) => apiClient.respondToUserInteraction(input),
    retry: false, gcTime: 0,
    onSettled: async () => { await client.invalidateQueries({ queryKey: ['user-approval'] }) },
  })
}
