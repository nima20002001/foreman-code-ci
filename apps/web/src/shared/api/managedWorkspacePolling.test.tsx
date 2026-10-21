import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { apiClient, ApiError } from './client'
import { useManagedWorkspaceQuery } from './query'

const clients: QueryClient[] = []
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } })
  clients.push(client)
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); vi.useRealTimers(); vi.restoreAllMocks() })

it('stops polling a workspace the server reports as missing', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const request = vi.spyOn(apiClient, 'request').mockRejectedValue(new ApiError({ code: 'WORKSPACE_NOT_FOUND', message: 'Workspace not found.' }, 404))
  const query = renderHook(() => useManagedWorkspaceQuery('missing-workspace'), { wrapper: wrapper() })
  await waitFor(() => expect(query.result.current.isError).toBe(true))
  await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
  expect(request).toHaveBeenCalledOnce()
})

it('keeps polling after a transient workspace read failure', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const request = vi.spyOn(apiClient, 'request').mockRejectedValue(new ApiError({ code: 'UNAVAILABLE', message: 'Try again.' }, 503))
  const query = renderHook(() => useManagedWorkspaceQuery('workspace-a'), { wrapper: wrapper() })
  await waitFor(() => expect(query.result.current.isError).toBe(true))
  await act(async () => { await vi.advanceTimersByTimeAsync(3100) })
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
})
