import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ClaudePluginListResultSchema, type ClaudePluginListInput } from '@foreman-code/contracts/management'
import { apiClient } from './client'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'
import { useHarnessSessionEpoch } from './harnessSettings'

function readPlugins(input: ClaudePluginListInput, signal: AbortSignal) {
  const query = new URLSearchParams({
    view: input.view, query: input.query, offset: String(input.offset), limit: String(input.limit),
  })
  if (input.refresh) query.set('refresh', 'true')
  return apiClient.request(`/api/management/harnesses/claude/plugins?${query}`, ClaudePluginListResultSchema, { signal })
}

export function useClaudePlugins(input: ClaudePluginListInput, enabled = true) {
  useHarnessSessionEpoch()
  const client = useQueryClient()
  const queryKey = ['harness-settings', sessionGeneration(), 'claude-plugins', input]
  const result = useQuery({
    queryKey, enabled: enabled && !sessionIsSwitching(), retry: false, refetchOnWindowFocus: false,
    queryFn: ({ signal }) => readPlugins(input, signal),
  })
  const refresh = () => client.fetchQuery({
    queryKey, staleTime: 0, queryFn: ({ signal }) => readPlugins({ ...input, refresh: true }, signal),
  })
  return { ...result, refresh }
}
