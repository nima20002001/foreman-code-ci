import { useInfiniteQuery, useMutation, useMutationState, useQueryClient } from '@tanstack/react-query'
import { assertSession, sessionGeneration, sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { ApiError } from '../../shared/api/client'
import { isTransientReadError, useBlockingReadError } from '../../shared/api/readFailure'
import { projectFilesClient, type ProjectFileRemoveInput, type ProjectFileUploadInput } from './projectFilesClient'

export const projectFilesKeys = {
  list: (workspaceId: string, generation = sessionGeneration()) => ['project-files', generation, workspaceId, 'list'] as const,
  upload: (workspaceId: string, generation = sessionGeneration()) => ['project-files', generation, workspaceId, 'upload'] as const,
  remove: (workspaceId: string, generation = sessionGeneration()) => ['project-files', generation, workspaceId, 'remove'] as const,
}

type ScopedUpload = ProjectFileUploadInput & { generation: number }
type ScopedRemoval = ProjectFileRemoveInput & { generation: number }

function uploadContentGuidance(error: unknown): string | null {
  if (!ApiError.is(error) || error.code !== 'FILE_TYPE_INVALID') return null
  if (error.message === 'Markdown contains binary control characters.') {
    return 'Markdown contains binary control characters. Remove them in a text editor and upload the corrected UTF-8 file.'
  }
  if (error.message === 'Markdown must use valid UTF-8.') {
    return 'Markdown must use valid UTF-8. Save it as UTF-8 in a text editor and upload the corrected file.'
  }
  return 'The file content does not match a supported format. Check or re-export the file and upload the corrected copy.'
}

export function useProjectFilesQuery(workspaceId: string) {
  const query = useInfiniteQuery({
    queryKey: projectFilesKeys.list(workspaceId),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) => projectFilesClient.list(workspaceId, pageParam, signal),
    getNextPageParam: (lastPage, pages) => {
      const next = lastPage.pageInfo.nextCursor
      // A repeated cursor must not create an unbounded More loop.
      return next && !pages.slice(0, -1).some((page) => page.pageInfo.nextCursor === next) ? next : undefined
    },
    placeholderData: () => undefined, // Do not inherit an app-level keepPreviousData across workspaces.
    staleTime: 0,
    retry: false,
    refetchInterval: query => {
      if (query.state.error && !isTransientReadError(query.state.error)) return false
      return query.state.data?.pages.some(page => page.items.some(row => row.file.state === 'pending'))
        ? 2500 : false
    },
  })
  const blocked = useBlockingReadError(query)
  return { ...query, data: blocked ? undefined : query.data }
}

export function useProjectFileUpload(workspaceId: string) {
  const queryClient = useQueryClient()
  const generation = sessionGeneration()
  const mutationKey = projectFilesKeys.upload(workspaceId, generation)
  const mutation = useMutation({
    mutationKey, retry: false, networkMode: 'always',
    mutationFn: (input: ScopedUpload) => {
      assertSession(input.generation)
      return projectFilesClient.upload(input)
    },
    onSettled: (_data, _error, input) => {
      if (input.generation !== sessionGeneration() || sessionIsSwitching()) return
      // Hook-level callbacks run even when navigation unmounts the originating view.
      return queryClient.invalidateQueries({ queryKey: projectFilesKeys.list(input.workspaceId, input.generation), exact: true })
    },
  })
  // TanStack owns request state and File variables, including navigation away and back.
  // Nothing is mirrored into Zustand, localStorage, or a global selected-workspace variable.
  const history = useMutationState({
    filters: { mutationKey, exact: true },
    select: (entry) => ({
      status: entry.state.status,
      error: entry.state.error,
      input: entry.state.variables as ScopedUpload | undefined,
    }),
  })
  const latest = history.at(-1)
  const contentGuidance = latest?.status === 'error' ? uploadContentGuidance(latest.error) : null
  const pending = () => queryClient.getMutationCache().findAll({ mutationKey, exact: true })
    .some((entry) => entry.state.status === 'pending')
  return {
    isPending: history.some((entry) => entry.status === 'pending'),
    isError: latest?.status === 'error',
    contentGuidance,
    canRetry: latest?.status === 'error' && !contentGuidance,
    filename: latest?.input?.file.name,
    start(file: File) {
      if (!pending()) mutation.mutate({ workspaceId, generation, file, requestId: crypto.randomUUID() })
    },
    retry() {
      if (!pending() && latest?.status === 'error' && !contentGuidance && latest.input) mutation.mutate(latest.input)
    },
  }
}

export function useProjectFileRemove(workspaceId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: projectFilesKeys.remove(workspaceId), retry: false, networkMode: 'always',
    mutationFn: (input: ScopedRemoval) => {
      assertSession(input.generation)
      return projectFilesClient.remove(input)
    },
    onSettled: (_data, _error, input) => {
      if (input.generation !== sessionGeneration() || sessionIsSwitching()) return
      return queryClient.invalidateQueries({ queryKey: projectFilesKeys.list(input.workspaceId, input.generation), exact: true })
    },
  })
}
