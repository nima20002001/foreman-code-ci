import type { CurrentRunDetails, CurrentWorkspaceDetails } from '@foreman-code/contracts/wave25'
import { useEffect } from 'react'
import {
  useMutation,
  useInfiniteQuery,
  useIsMutating,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type UseQueryOptions,
} from '@tanstack/react-query'
import type { GetHarnessDefaultsResponse } from '@foreman-code/contracts'
import type {
  ManagedWorkspace, WorkspaceArchiveInput, WorkspaceCreateInput, WorkspaceUpdateInput,
  WorkflowArchiveInput, WorkflowUpdateInput,
} from '@foreman-code/contracts/management'

import {
  apiClient,
  ApiError,
  getRun,
  getWorkflow,
  getWorkspaceDetails,
  listAgents,
  listVisibleResources,
  listManagedWorkspaces, createManagedWorkspace, updateManagedWorkspace, archiveManagedWorkspace,
  getManagedWorkspace, validateWorkspaceLocation, setWorkspaceLocation,
  createManagedWorkflow, updateManagedWorkflow, archiveManagedWorkflow,
  listManagedAgents,
  startManagedRun, stopManagedRun,
  getManagedHarnessCatalog, updateManagedHarnessDefaults,
  getManagedAgentDefaults, updateManagedAgentDefaults,
  getManagedWorkflowDefaults, updateManagedWorkflowDefaults,
  getScopedMcpDetection,
  listInteractions, getInteraction, respondToInteraction,
  type RequestOptions,
} from './client'
import { keepLatestWorkspaceLocation, locationMutationKey, shareManagedWorkspace } from './workspaceLocationCache'
import { shareRunResponseOrSelection } from './runLiveCache'

/**
 * Query keys deliberately carry every scope identity used by the endpoint.
 * This prevents a conversation/workspace projection from leaking across tabs.
 */
export const queryKeys = {
  all: ['workbench'] as const,
  workspace: (workspaceId: string) => ['workbench', 'workspace', workspaceId] as const,
  workspaceDetails: (workspaceId: string) => ['workbench', 'workspace', workspaceId, 'details'] as const,
  agents: (workspaceId: string) => ['workbench', 'workspace', workspaceId, 'agents'] as const,
  workflow: (workspaceId: string, workflowId: string) =>
    ['workbench', 'workspace', workspaceId, 'workflow', workflowId] as const,
  run: (workspaceId: string, runId: string) =>
    ['workbench', 'workspace', workspaceId, 'run', runId] as const,
  resources: (workspaceId: string) => ['workbench', 'workspace', workspaceId, 'resources'] as const,
  managedWorkspaces: ['workbench', 'management', 'workspaces'] as const,
  workspaceStorageFolders: ['workbench', 'management', 'workspace-storage-folders'] as const,
  managedWorkspace: (workspaceId: string) => ['workbench', 'management', 'workspace', workspaceId] as const,
  managedWorkflow: (workspaceId: string, workflowId: string) => ['workbench', 'management', 'workspace', workspaceId, 'workflows', 'detail', workflowId] as const,
  managedWorkflows: (workspaceId: string) => ['workbench', 'management', 'workspace', workspaceId, 'workflows'] as const,
  workflowOrderMutation: (workspaceId: string) => ['workbench', 'workflow-order', workspaceId] as const,
  managedAgents: (workspaceId: string) => ['workbench', 'management', 'workspace', workspaceId, 'agents'] as const,
  managedDraft: (workspaceId: string, workflowId: string) => ['workbench', 'management', 'workspace', workspaceId, 'workflow', workflowId, 'draft'] as const,
  managedHarnessCatalog: ['workbench', 'management', 'harnesses'] as const,
  agentDefaults: ['workbench', 'management', 'settings', 'agents'] as const,
  workflowDefaults: ['workbench', 'management', 'settings', 'workflows'] as const,
  interactions: (workspaceId?: string, workflowId?: string, status?: string, cursor?: string, limit = 50) =>
    ['workbench', 'interactions', workspaceId ?? 'all', workflowId ?? 'all', status ?? 'all', cursor ?? null, limit] as const,
  interaction: (interactionId: string) => ['workbench', 'interaction', interactionId] as const,
  mcpDetection: (workspaceId: string, harness: string) => ['workbench', 'management', 'workspace', workspaceId, 'mcp-detection', harness] as const,
  managedGraphContext: (workspaceId: string, workflowId: string) =>
    ['workbench', 'management', 'workspace', workspaceId, 'workflow', workflowId, 'context'] as const,
}

export const workspaceQueryKeys = queryKeys

type QueryOptions<T> = Omit<UseQueryOptions<T>, 'queryKey' | 'queryFn'>

export function useWorkspaceDetailsQuery(
  workspaceId: string,
  options?: QueryOptions<CurrentWorkspaceDetails>,
) {
  return useQuery({
    ...options,
    queryKey: queryKeys.workspaceDetails(workspaceId),
    queryFn: ({ signal }) => getWorkspaceDetails({ workspaceId }, { signal }),
  })
}

// Directory load-all must not expand the independently paged sidebar cache.
type CatalogView = 'navigation' | 'directory'
const CATALOG_REFRESH_MS = 3_000

export function useWorkspacePages(enabled = true, view: CatalogView = 'navigation') {
  const client = useQueryClient()
  type Pages = InfiniteData<Awaited<ReturnType<typeof apiClient.listManagedWorkspacePage>>, string | undefined>
  return useInfiniteQuery({
    enabled, queryKey: [...queryKeys.managedWorkspaces, 'pages', ...(view === 'directory' ? ['directory'] : [])],
    // The directory shows the sidebar's already-loaded page while it reads the full list.
    ...(view === 'directory' ? { maxPages: 0, placeholderData: () => client.getQueryData<Pages>([...queryKeys.managedWorkspaces, 'pages']) } : {}),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => apiClient.listManagedWorkspacePage(pageParam, { signal }),
    // Workspaces created or deleted elsewhere (Operator, other tabs) appear without a reload.
    refetchInterval: enabled ? CATALOG_REFRESH_MS : false,
    getNextPageParam: (last, _pages, _lastParam, params) => {
      const next = last.pageInfo.nextCursor
      return next && !params.includes(next) ? next : undefined
    },
  })
}

export function useWorkspaceStorageFolderPages(enabled = true) {
  return useInfiniteQuery({
    enabled, maxPages: 0, queryKey: queryKeys.workspaceStorageFolders, initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => apiClient.listWorkspaceStorageFolderPage(pageParam, { signal }),
    getNextPageParam: (last, _pages, _lastParam, params) => {
      const next = last.pageInfo.nextCursor
      return next && !params.includes(next) ? next : undefined
    },
  })
}

export function useManagedWorkflowQuery(workspaceId: string, workflowId: string, enabled = true) {
  return useQuery({
    enabled: enabled && Boolean(workflowId), queryKey: queryKeys.managedWorkflow(workspaceId, workflowId),
    queryFn: ({ signal }) => apiClient.getManagedWorkflow(workspaceId, workflowId, { signal }),
  })
}

type Named = { id?: unknown; name?: unknown }
function namedIn(value: unknown, id: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const entry = value as Named
  return entry.id === id && typeof entry.name === 'string' ? entry.name : undefined
}
/** A workspace's name from any cached list or detail, so labels do not wait for a dedicated read. */
export function cachedWorkspaceName(client: ReturnType<typeof useQueryClient>, workspaceId: string): string | undefined {
  for (const [, data] of client.getQueriesData<unknown>({ queryKey: ['workbench'] })) {
    if (!data || typeof data !== 'object') continue
    const record = data as { workspace?: unknown; pages?: { items?: { workspace?: unknown }[] }[] }
    const direct = namedIn(record.workspace, workspaceId)
    if (direct) return direct
    for (const page of record.pages ?? []) for (const item of page.items ?? []) {
      const name = namedIn(item.workspace, workspaceId)
      if (name) return name
    }
  }
  return undefined
}
/** A workflow's name from any cached workspace detail or workflow list. */
export function cachedWorkflowName(client: ReturnType<typeof useQueryClient>, workflowId: string): string | undefined {
  for (const [, data] of client.getQueriesData<unknown>({ queryKey: ['workbench'] })) {
    if (!data || typeof data !== 'object') continue
    const record = data as { workflow?: unknown; workflows?: unknown[]; pages?: { items?: { workflow?: unknown }[] }[] }
    const direct = namedIn(record.workflow, workflowId) ?? record.workflows?.map(item => namedIn(item, workflowId)).find(Boolean)
    if (direct) return direct
    for (const page of record.pages ?? []) for (const item of page.items ?? []) {
      const name = namedIn(item.workflow, workflowId)
      if (name) return name
    }
  }
  return undefined
}

/** Hover/focus prefetch so opening a workspace or workflow shows data instead of a loader. Fresh data is not refetched. */
export function usePrefetchBoard() {
  const client = useQueryClient()
  return {
    workspace: (workspaceId: string) => {
      void client.prefetchQuery({ queryKey: queryKeys.managedWorkspace(workspaceId), staleTime: 10_000,
        queryFn: ({ signal }) => getManagedWorkspace(workspaceId, { signal }) }).catch(() => undefined)
    },
    /** The Workflows directory's first page, under the same key the directory reads. */
    workflows: (workspaceId: string) => {
      void client.prefetchInfiniteQuery({ queryKey: [...queryKeys.managedWorkflows(workspaceId), 'pages', 'directory'], staleTime: 10_000,
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam, signal }) => apiClient.listManagedWorkflowPage(workspaceId, pageParam, { signal }) }).catch(() => undefined)
    },
  }
}

export function useWorkflowPages(workspaceId: string, enabled = true, view: CatalogView = 'navigation') {
  const client = useQueryClient()
  const reordering = useIsMutating({ mutationKey: queryKeys.workflowOrderMutation(workspaceId) }) > 0
  type Pages = InfiniteData<Awaited<ReturnType<typeof apiClient.listManagedWorkflowPage>>, string | undefined>
  const queryKey = [...queryKeys.managedWorkflows(workspaceId), 'pages', ...(view === 'directory' ? ['directory'] : [])]
  const query = useInfiniteQuery({
    enabled, queryKey,
    // The directory shows the sidebar's already-loaded page while it reads the full list.
    ...(view === 'directory' ? { maxPages: 0, placeholderData: () => client.getQueryData<Pages>([...queryKeys.managedWorkflows(workspaceId), 'pages']) } : {}),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => apiClient.listManagedWorkflowPage(workspaceId, pageParam, { signal }),
    // Workflows created or deleted elsewhere (Operator, Agents, other tabs) appear without a reload.
    refetchInterval: enabled && !reordering ? CATALOG_REFRESH_MS : false,
    refetchOnWindowFocus: !reordering,
    refetchOnReconnect: !reordering,
    getNextPageParam: (last, _pages, _lastParam, params) => {
      const next = last.pageInfo.nextCursor
      return next && !params.includes(next) ? next : undefined
    },
  })
  useEffect(() => {
    if (query.isFetching || !(query.error instanceof ApiError) || query.error.code !== 'REVISION_CONFLICT') return
    // A concurrent reorder invalidates older cursors. Restart from the first page.
    const key = [...queryKeys.managedWorkflows(workspaceId), 'pages', ...(view === 'directory' ? ['directory'] : [])]
    client.setQueryData<Pages>(key, data => data ? {
      ...data, pages: data.pages.slice(0, 1), pageParams: [undefined],
    } : data)
    void client.invalidateQueries({ queryKey: key })
  }, [client, query.error, query.isFetching, view, workspaceId])
  return query
}

export function useManagedWorkspacesQuery(enabled = true) {
  return useQuery({ enabled, queryKey: queryKeys.managedWorkspaces, queryFn: ({ signal }) => listManagedWorkspaces({ signal }) })
}

export function useManagedWorkspaceQuery(workspaceId: string, enabled = true) {
  return useQuery({
    enabled,
    queryKey: queryKeys.managedWorkspace(workspaceId),
    queryFn: ({ signal }) => getManagedWorkspace(workspaceId, { signal }),
    structuralSharing: shareManagedWorkspace,
    // A missing workspace stays missing; creation and navigation invalidate this key.
    refetchInterval: (query) => enabled && !(ApiError.is(query.state.error) && query.state.error.status === 404) ? 3_000 : false,
  })
}

export function useValidateWorkspaceLocationMutation(workspaceId = 'unscoped') {
  return useMutation({
    mutationKey: [...locationMutationKey(workspaceId), 'validate'],
    mutationFn: (input: Parameters<typeof validateWorkspaceLocation>[0]) => validateWorkspaceLocation(input),
  })
}

export function useSetWorkspaceLocationMutation(workspaceId = 'unscoped') {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: [...locationMutationKey(workspaceId), 'save'],
    mutationFn: (input: Parameters<typeof setWorkspaceLocation>[0]) => setWorkspaceLocation(input),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.managedWorkspace(input.workspaceId), exact: true })
    },
    onSuccess: async (result, input) => {
      if (result.value.workspaceId !== input.workspaceId) throw new Error('The saved location belongs to another workspace.')
      const queryKey = queryKeys.managedWorkspace(input.workspaceId)
      // A new poll may have started while the mutation was pending.
      await queryClient.cancelQueries({ queryKey, exact: true })
      queryClient.setQueryData<ManagedWorkspace>(queryKey, (current) => current
        && current.workspace.id === input.workspaceId
        && current.locationValidation.status !== 'restricted' ? keepLatestWorkspaceLocation(current, {
          ...current,
          executionLocation: result.value.executionLocation,
          locationRevision: result.value.locationRevision,
          locationValidation: { status: 'ready', checkedAt: result.value.validation.checkedAt },
        }) : current)
      void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkspaces }).catch(() => undefined)
    },
  })
}

export function useReloadWorkspaceLocationMutation(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: [...locationMutationKey(workspaceId), 'reload'],
    mutationFn: async (input: { workspaceId: string }) => {
      const queryKey = queryKeys.managedWorkspace(input.workspaceId)
      await queryClient.cancelQueries({ queryKey, exact: true })
      return queryClient.fetchQuery({
        queryKey,
        queryFn: ({ signal }) => getManagedWorkspace(input.workspaceId, { signal }),
        staleTime: 0,
        structuralSharing: shareManagedWorkspace,
      })
    },
  })
}

export function useCreateManagedWorkspaceMutation() {
  return useMutation({ mutationFn: (input: WorkspaceCreateInput) => createManagedWorkspace(input) })
}

export function useUpdateManagedWorkspaceMutation() {
  return useMutation({ mutationFn: (input: WorkspaceUpdateInput) => updateManagedWorkspace(input) })
}

export function useArchiveManagedWorkspaceMutation() {
  return useMutation({ mutationFn: (input: WorkspaceArchiveInput) => archiveManagedWorkspace(input) })
}

export function useCreateManagedWorkflowMutation() {
  return useMutation({ mutationFn: (input: Parameters<typeof createManagedWorkflow>[0]) => createManagedWorkflow(input) })
}

export function useUpdateManagedWorkflowMutation() {
  return useMutation({ mutationFn: (input: WorkflowUpdateInput) => updateManagedWorkflow(input) })
}

export function useArchiveManagedWorkflowMutation() {
  return useMutation({ mutationFn: (input: WorkflowArchiveInput) => archiveManagedWorkflow(input) })
}

export function useManagedAgentsQuery(workspaceId: string, enabled = true) {
  return useQuery({ enabled, queryKey: queryKeys.managedAgents(workspaceId), queryFn: ({ signal }) => listManagedAgents(workspaceId, { signal }) })
}

export function useStartManagedRunMutation() {
  return useMutation({ mutationFn: (input: Parameters<typeof startManagedRun>[0]) => startManagedRun(input) })
}

export function useStopManagedRunMutation() {
  return useMutation({ mutationFn: (input: Parameters<typeof stopManagedRun>[0]) => stopManagedRun(input) })
}

export function useManagedHarnessCatalogQuery(enabled = true) {
  return useQuery({ enabled, queryKey: queryKeys.managedHarnessCatalog,
    queryFn: ({ signal }) => getManagedHarnessCatalog({ signal }), refetchInterval: enabled ? 3_000 : false })
}

export function useUpdateManagedHarnessDefaultsMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof updateManagedHarnessDefaults>[0]) => updateManagedHarnessDefaults(input),
    onSuccess: (response, input) => {
      client.setQueryData<Awaited<ReturnType<typeof getManagedHarnessCatalog>>>(queryKeys.managedHarnessCatalog, (current) => {
        if (!current || current.some(entry => entry.defaultsRevision > response.value.revision)) return current
        return Object.values(response.value.defaults).map(defaults => {
          const prior = current.find(entry => entry.harness === defaults.harness)
          const unchanged = prior && !input.configure?.includes(defaults.harness)
            && JSON.stringify(prior.defaults) === JSON.stringify(defaults)
          return { harness: defaults.harness, defaults, defaultsRevision: response.value.revision,
            capability: unchanged ? prior.capability : null, discoveryError: unchanged ? prior.discoveryError : null }
        })
      })
      void client.invalidateQueries({ queryKey: queryKeys.managedHarnessCatalog }).catch(() => undefined)
      void client.invalidateQueries({ queryKey: ['operator-chat', 'setup'] }).catch(() => undefined)
    },
  })
}

export function useAgentDefaultsQuery(enabled = true) {
  const client = useQueryClient()
  return useQuery({
    enabled,
    queryKey: queryKeys.agentDefaults,
    queryFn: async ({ signal }) => {
      const next = await getManagedAgentDefaults({ signal })
      const current = client.getQueryData<Awaited<ReturnType<typeof getManagedAgentDefaults>>>(queryKeys.agentDefaults)
      return current && current.revision > next.revision ? current : next
    },
    refetchInterval: enabled ? 3_000 : false,
  })
}

export function useUpdateAgentDefaultsMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof updateManagedAgentDefaults>[0]) => updateManagedAgentDefaults(input),
    onSuccess: (response) => client.setQueryData<Awaited<ReturnType<typeof getManagedAgentDefaults>>>(queryKeys.agentDefaults,
      (current) => current && current.revision > response.value.revision ? current : response.value),
  })
}

export function useWorkflowDefaultsQuery(enabled = true) {
  const client = useQueryClient()
  return useQuery({
    enabled,
    queryKey: queryKeys.workflowDefaults,
    queryFn: async ({ signal }) => {
      const next = await getManagedWorkflowDefaults({ signal })
      const current = client.getQueryData<Awaited<ReturnType<typeof getManagedWorkflowDefaults>>>(queryKeys.workflowDefaults)
      return current && current.revision > next.revision ? current : next
    },
    refetchInterval: enabled ? 3_000 : false,
  })
}

export function useUpdateWorkflowDefaultsMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof updateManagedWorkflowDefaults>[0]) => updateManagedWorkflowDefaults(input),
    onSuccess: (response) => client.setQueryData<Awaited<ReturnType<typeof getManagedWorkflowDefaults>>>(queryKeys.workflowDefaults,
      (current) => current && current.revision > response.value.revision ? current : response.value),
  })
}

export function useMcpDetectionQuery(workspaceId: string, harness: 'codex', enabled = true) {
  return useQuery({
    enabled,
    queryKey: queryKeys.mcpDetection(workspaceId, harness),
    queryFn: ({ signal }) => getScopedMcpDetection(workspaceId, harness, { signal }),
    refetchInterval: enabled ? 10_000 : false,
  })
}

export function useInteractionsQuery(input: Parameters<typeof listInteractions>[0], enabled = true) {
  return useQuery({
    enabled,
    queryKey: queryKeys.interactions(input.workspaceId, input.workflowId, input.status, input.cursor, input.limit),
    queryFn: ({ signal }) => listInteractions(input, { signal }),
    refetchInterval: enabled ? 3_000 : false,
  })
}

export function useInfiniteInteractionsQuery(input: Parameters<typeof listInteractions>[0], enabled = true) {
  return useInfiniteQuery({
    enabled,
    queryKey: [...queryKeys.interactions(input.workspaceId, input.workflowId, input.status, input.cursor, input.limit), 'pages'],
    initialPageParam: input.cursor as string | undefined,
    queryFn: ({ signal, pageParam }) => listInteractions({ ...input, cursor: pageParam }, { signal }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: enabled ? 3_000 : false,
  })
}

export function useInteractionQuery(interactionId: string | undefined) {
  const client = useQueryClient()
  return useQuery({
    enabled: Boolean(interactionId),
    queryKey: queryKeys.interaction(interactionId ?? 'none'),
    queryFn: async ({ signal }) => {
      const next = await getInteraction(interactionId!, { signal })
      const current = client.getQueryData<Awaited<ReturnType<typeof getInteraction>>>(queryKeys.interaction(interactionId!))
      return current && current.interaction.id === next.interaction.id && current.interaction.revision > next.interaction.revision
        ? { ...current, canRespond: next.canRespond, review: next.review } : next
    },
    refetchInterval: interactionId ? 3_000 : false,
  })
}

export function useRespondToInteractionMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: (input: Parameters<typeof respondToInteraction>[0]) => respondToInteraction(input),
    onSuccess: (response) => {
      client.setQueryData<Awaited<ReturnType<typeof getInteraction>>>(queryKeys.interaction(response.interaction.id), (current) =>
        current && current.interaction.revision > response.interaction.revision ? current : { ...current, interaction: response.interaction })
      void client.invalidateQueries({ queryKey: ['workbench', 'interactions'] }).catch(() => undefined)
    },
  })
}

export const useWorkspaceQuery = useWorkspaceDetailsQuery

export function useHarnessDefaultsQuery(options?: Omit<QueryOptions<Awaited<ReturnType<typeof getManagedHarnessCatalog>>>, 'select'>) {
  return useQuery({
    refetchInterval: 3_000,
    ...options,
    queryKey: queryKeys.managedHarnessCatalog,
    queryFn: ({ signal }) => getManagedHarnessCatalog({ signal }),
    select: (catalog): GetHarnessDefaultsResponse => {
      const codex = catalog.find((entry) => entry.harness === 'codex')?.defaults
      const claude = catalog.find((entry) => entry.harness === 'claude')?.defaults
      if (codex?.harness !== 'codex') throw new Error('Harness defaults are unavailable.')
      return { defaults: { codex, ...(claude?.harness === 'claude' ? { claude } : {}) } }
    },
  })
}

export function useAgentsQuery(workspaceId: string, options?: QueryOptions<Awaited<ReturnType<typeof listAgents>>>) {
  return useQuery({
    ...options,
    queryKey: queryKeys.agents(workspaceId),
    queryFn: ({ signal }) => listAgents({ workspaceId }, { signal }),
  })
}

export function useWorkflowQuery(
  workspaceId: string,
  workflowId: string,
  options?: QueryOptions<Awaited<ReturnType<typeof getWorkflow>>>,
) {
  return useQuery({
    ...options,
    queryKey: queryKeys.workflow(workspaceId, workflowId),
    queryFn: ({ signal }) => getWorkflow({ workspaceId, workflowId }, { signal }),
  })
}

export function useRunQuery(
  workspaceId: string,
  runId: string,
  options?: QueryOptions<CurrentRunDetails>,
) {
  return useQuery({
    ...options,
    queryKey: queryKeys.run(workspaceId, runId),
    queryFn: async ({ signal }) => {
      const result = await getRun({ workspaceId, runId }, { signal })
      if (result.run.workspaceId !== workspaceId || result.run.id !== runId
        || (result.liveActivity && (result.liveActivity.runId !== runId
          || result.liveActivity.workspaceId !== workspaceId || result.liveActivity.workflowId !== result.run.workflowId
          || result.liveActivity.workflowVersionId !== result.run.workflowVersionId))) {
        throw new Error('The Run response does not match the requested workspace and Run.')
      }
      return result
    },
    structuralSharing: shareRunResponseOrSelection,
  })
}

export function useVisibleResourcesQuery(
  workspaceId: string,
  options?: QueryOptions<Awaited<ReturnType<typeof listVisibleResources>>>,
) {
  return useQuery({
    ...options,
    queryKey: queryKeys.resources(workspaceId),
    queryFn: ({ signal }) => listVisibleResources({ workspaceId }, { signal }),
  })
}

// Keep these imports part of the public feature API for callers that want a
// client boundary but do not need React Query.
export { apiClient }
export type { RequestOptions }
