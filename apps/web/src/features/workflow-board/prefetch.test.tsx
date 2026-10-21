import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { apiClient } from '../../shared/api/client'
import { queryKeys } from '../../shared/api/query'
import { nextDraftApi } from '../graph/nextDraft/transport'
import { runsSelectorApi, runsSelectorKeys } from '../runs-selector'
import { boardDraftContextKey, boardLiveRunSnapshotKey } from './keys'
import { usePrefetchWorkflowBoard } from './prefetch'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('prefetches the draft, Run list and active Run pin under the Board keys once, without re-reading the workspace', async () => {
  const getWorkflow = vi.spyOn(apiClient, 'getManagedWorkflow').mockResolvedValue({ workflow: { id: 'workflow-a' } } as never)
  const context = vi.spyOn(nextDraftApi, 'context').mockResolvedValue({ draft: { id: 'draft-a' } } as never)
  const list = vi.spyOn(runsSelectorApi, 'list').mockResolvedValue({ items: [], nextCursor: null } as never)
  const snapshot = vi.spyOn(runsSelectorApi, 'snapshot').mockResolvedValue({ snapshot: { kind: 'available', runId: 'run-a' } } as never)
  const request = vi.spyOn(apiClient, 'request')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  client.setQueryData(queryKeys.workspaceDetails('workspace-a'), { runs: [
    { id: 'run-a', workspaceId: 'workspace-a', workflowId: 'workflow-a', executionState: 'running', cleanupPending: false },
    { id: 'run-b', workspaceId: 'workspace-a', workflowId: 'workflow-a', executionState: 'completed', cleanupPending: false },
    { id: 'run-c', workspaceId: 'workspace-a', workflowId: 'workflow-b', executionState: 'running', cleanupPending: false },
  ] })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => usePrefetchWorkflowBoard(), { wrapper })
  act(() => result.current('workspace-a', 'workflow-a'))
  await waitFor(() => expect(client.isFetching()).toBe(0))
  expect(client.getQueryData(boardDraftContextKey('workspace-a', 'workflow-a'))).toEqual({ draft: { id: 'draft-a' } })
  expect(client.getQueryData(runsSelectorKeys.list({ workspaceId: 'workspace-a', workflowId: 'workflow-a' }))).toBeDefined()
  expect(client.getQueryData(boardLiveRunSnapshotKey('workspace-a', 'workflow-a', 'run-a'))).toBeDefined()
  expect(snapshot).toHaveBeenCalledOnce()
  expect(snapshot.mock.calls[0]![0]).toEqual({ workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a' })
  act(() => result.current('workspace-a', 'workflow-a'))
  await waitFor(() => expect(client.isFetching()).toBe(0))
  expect([getWorkflow, context, list, snapshot].map((spy) => spy.mock.calls.length)).toEqual([1, 1, 1, 1])
  expect(request).not.toHaveBeenCalled()
  client.clear()
})
