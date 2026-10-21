import { useEffect, useMemo, useRef } from 'react'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import type { PermanentFileScope } from '@foreman-code/contracts/files'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import {
  type ReferenceDownload, type ReferenceRemoval, type ReferenceUpload,
  type WorkflowFilesClient, saveReferenceDownload,
} from './workflowFilesClient'
import {
  inheritedReferenceScope, referenceFilesKey, workflowReferenceScope, type WorkflowFilesIdentity,
} from './workflowFilesModel'

function useReferencePage(scope: PermanentFileScope, open: boolean, client: WorkflowFilesClient, generation: number) {
  return useInfiniteQuery({
    queryKey: referenceFilesKey(scope, generation),
    queryFn: ({ pageParam, signal }) => client.list(scope, pageParam, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page, _pages, _lastParam, pageParams) => {
      const cursor = page.pageInfo.nextCursor
      return cursor && !pageParams.includes(cursor) ? cursor : undefined
    },
    enabled: open,
    // Explicitly override a host's keepPreviousData default. Never show A under B.
    placeholderData: () => undefined,
    retry: false,
  })
}

export function useWorkflowFiles(identity: WorkflowFilesIdentity, open: boolean, client: WorkflowFilesClient) {
  const generation = sessionGeneration()
  const { workspaceId, workflowId } = identity
  const workflowScope = useMemo(() => workflowReferenceScope({ workspaceId, workflowId }), [workspaceId, workflowId])
  const workspaceScope = useMemo(() => inheritedReferenceScope({ workspaceId, workflowId }), [workspaceId, workflowId])
  const queryClient = useQueryClient()
  const lifecycle = useRef<AbortController | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    lifecycle.current = controller
    return () => { controller.abort(); lifecycle.current = null }
  }, [workspaceId, workflowId, generation])
  function signal() {
    assertSession(generation)
    if (!lifecycle.current) throw new DOMException('Files view closed.', 'AbortError')
    return lifecycle.current.signal
  }
  const refresh = () => {
    if (sessionGeneration() !== generation) return
    // The closure is the original scope, never the currently open Board.
    return queryClient.invalidateQueries({ queryKey: referenceFilesKey(workflowScope, generation) })
  }
  const workflow = useReferencePage(workflowScope, open, client, generation)
  const workspace = useReferencePage(workspaceScope, open, client, generation)
  const upload = useMutation({
    mutationKey: [...referenceFilesKey(workflowScope, generation), 'upload'], retry: false, gcTime: 0,
    mutationFn: (input: Pick<ReferenceUpload, 'requestId' | 'file'>) =>
      client.upload({ ...input, scope: workflowScope, signal: signal() }),
    onSettled: refresh,
  })
  const remove = useMutation({
    mutationKey: [...referenceFilesKey(workflowScope, generation), 'remove'], retry: false, gcTime: 0,
    mutationFn: (input: Pick<ReferenceRemoval, 'ref' | 'commandId'>) =>
      client.remove({ ...input, scope: workflowScope, signal: signal() }),
    onSettled: refresh,
  })
  const download = useMutation({
    mutationKey: [...referenceFilesKey(workflowScope, generation), 'download'], retry: false, gcTime: 0,
    mutationFn: async (input: Pick<ReferenceDownload, 'row' | 'scope'>) => {
      const requestSignal = signal()
      const blob = await client.download({ ...input, signal: requestSignal })
      // Also guard injected/late clients which ignore abort.
      assertSession(generation)
      requestSignal.throwIfAborted()
      saveReferenceDownload(blob, input.row.revision.filename)
    },
  })
  return { workflow, workspace, workflowScope, workspaceScope, upload, remove, download }
}
