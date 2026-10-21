import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { apiClient } from './client'
import { queryKeys, usePrefetchBoard } from './query'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('prefetches the Workflows directory under the key the directory reads', async () => {
  const page = { items: [], pageInfo: { nextCursor: null } }
  const list = vi.spyOn(apiClient, 'listManagedWorkflowPage').mockResolvedValue(page as never)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => usePrefetchBoard(), { wrapper })
  result.current.workflows('workspace-a')
  await waitFor(() => expect(client.getQueryData([...queryKeys.managedWorkflows('workspace-a'), 'pages', 'directory'])).toEqual({ pages: [page], pageParams: [undefined] }))
  expect(list).toHaveBeenCalledOnce()
  client.clear()
})
