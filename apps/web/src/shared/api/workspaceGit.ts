import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  WorkspaceRepositoryAddInputSchema, WorkspaceRepositoryAddResultSchema,
  WorkspaceRepositoryGetInputSchema, WorkspaceRepositoryReadResultSchema,
  type WorkspaceRepositoryAddInput, type WorkspaceRepositoryGetInput,
} from '@foreman-code/contracts/workspace-git'
import { ApiError, apiClient, type RequestOptions } from './client'
import { useHarnessSessionEpoch } from './harnessSettings'
import { assertSession, sessionGeneration, sessionIsSwitching } from './sessionBoundary'
import { boundLocationKeys } from './workspaceBoundLocation'
import { queryKeys } from './query'

export const workspaceGitKeys = {
  scope: (workspaceId: string) => ['workbench', 'workspace-git', sessionGeneration(), workspaceId] as const,
  read: (workspaceId: string, commandId?: string) => [...workspaceGitKeys.scope(workspaceId), 'read', commandId ?? null] as const,
  add: (workspaceId: string) => [...workspaceGitKeys.scope(workspaceId), 'add'] as const,
}
const path = (workspaceId: string) => `/api/management/workspaces/${encodeURIComponent(workspaceId)}/repository`

export function originalRepositoryRequest(cache: QueryClient, workspaceId: string, commandId?: string) {
  if (!commandId) return undefined
  for (const mutation of cache.getMutationCache().findAll({ mutationKey: workspaceGitKeys.add(workspaceId), exact: true })) {
    const parsed = WorkspaceRepositoryAddInputSchema.safeParse(mutation.state.variables)
    if (parsed.success && parsed.data.commandId === commandId) return parsed.data
  }
  return undefined
}

export async function readWorkspaceRepository(raw: WorkspaceRepositoryGetInput, options?: RequestOptions) {
  const input = WorkspaceRepositoryGetInputSchema.parse(raw)
  const query = input.commandId ? `?${new URLSearchParams({ commandId: input.commandId })}` : ''
  const result = await apiClient.request(`${path(input.workspaceId)}${query}`, WorkspaceRepositoryReadResultSchema, options)
  if (result.workspaceId !== input.workspaceId
    || input.commandId && result.operation && result.operation.commandId !== input.commandId) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Project status belongs to another workspace or import.' })
  }
  return result
}

export async function addWorkspaceRepository(raw: WorkspaceRepositoryAddInput, options?: RequestOptions) {
  const input = WorkspaceRepositoryAddInputSchema.parse(raw)
  const result = await apiClient.request(`${path(input.workspaceId)}/add`, WorkspaceRepositoryAddResultSchema,
    { ...options, method: 'POST', body: input })
  if (result.value.workspaceId !== input.workspaceId || result.value.operation?.commandId !== input.commandId) {
    throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Project preparation belongs to another workspace or import.' })
  }
  return result
}

export function repositoryReadOptions(workspaceId: string, commandId?: string) {
  const generation = sessionGeneration()
  return {
    queryKey: workspaceGitKeys.read(workspaceId, commandId), retry: false as const,
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const result = await readWorkspaceRepository({ workspaceId, ...(commandId ? { commandId } : {}) }, { signal })
      assertSession(generation)
      return result
    },
  }
}

export function useWorkspaceRepository(workspaceId: string, commandId?: string) {
  useHarnessSessionEpoch()
  return useQuery({ ...repositoryReadOptions(workspaceId, commandId), enabled: !sessionIsSwitching() })
}

export function useAddWorkspaceRepository(workspaceId: string) {
  const cache = useQueryClient()
  const generation = useHarnessSessionEpoch()
  return useMutation({ mutationKey: workspaceGitKeys.add(workspaceId), retry: false, gcTime: Infinity,
    mutationFn: async (input: WorkspaceRepositoryAddInput) => {
      let readback: Awaited<ReturnType<typeof readWorkspaceRepository>> | undefined
      try {
        readback = await readWorkspaceRepository({ workspaceId, commandId: input.commandId })
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 404 || error.code !== 'IMPORT_NOT_FOUND') throw error
      }
      assertSession(generation)
      if (readback?.operation && (readback.state === 'ready' || readback.operation.failure?.newCommandRequired)) {
        return { value: readback, replayed: true }
      }
      const result = await addWorkspaceRepository(input)
      assertSession(generation)
      return result
    },
    onSuccess: result => {
      cache.setQueryData(workspaceGitKeys.read(workspaceId, result.value.operation?.commandId), result.value)
      cache.setQueryData(workspaceGitKeys.read(workspaceId), result.value)
      void cache.invalidateQueries({ queryKey: queryKeys.managedWorkspace(workspaceId) })
      void cache.invalidateQueries({ queryKey: queryKeys.managedWorkspaces })
      void cache.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
      void cache.invalidateQueries({ queryKey: boundLocationKeys.scope(workspaceId) })
      void cache.invalidateQueries({ queryKey: ['workbench', 'source-roots', generation, workspaceId] })
      void cache.invalidateQueries({ queryKey: ['workbench', 'worktree-choices', generation, workspaceId] })
    },
    onError: error => {
      if (generation !== sessionGeneration() || !(error instanceof ApiError) || !error.code.endsWith('CONFLICT')) return
      void cache.invalidateQueries({ queryKey: queryKeys.managedWorkspace(workspaceId) })
      void cache.invalidateQueries({ queryKey: boundLocationKeys.scope(workspaceId) })
      void cache.invalidateQueries({ queryKey: ['workbench', 'source-roots', generation, workspaceId] })
    },
  })
}
