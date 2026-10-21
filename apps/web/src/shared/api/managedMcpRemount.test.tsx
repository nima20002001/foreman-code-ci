import { act, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { apiClient } from './client'
import { useApplyManagedMcpChange } from './harnessSettings'

vi.mock('./client', () => ({ apiClient: { request: vi.fn() } }))
vi.mock('./sessionBoundary', () => {
  const controller = new AbortController()
  return { sessionGeneration: () => 1, sessionSignal: () => controller.signal,
    sessionIsSwitching: () => false, SessionChangedError: class extends Error {} }
})
afterEach(() => vi.clearAllMocks())
it('restores an uncertain original operation after leaving and returning to its harness panel', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  let fail!: (error: Error) => void
  vi.mocked(apiClient.request).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
  const first = renderHook(() => useApplyManagedMcpChange('codex'), { wrapper })
  act(() => first.result.current.start({ preset: 'graphql', installed: true, expectedRevision: `sha256:${'1'.repeat(64)}` }))
  await waitFor(() => expect(apiClient.request).toHaveBeenCalledTimes(1))
  const original = first.result.current.operation!.input
  first.unmount()
  const other = renderHook(() => useApplyManagedMcpChange('codex'), { wrapper })
  expect(other.result.current.operation?.input).toEqual(original)
  await act(async () => { fail(new Error('response lost')); await Promise.resolve() })
  other.unmount()
  const restored = renderHook(() => useApplyManagedMcpChange('codex'), { wrapper })
  await waitFor(() => expect(restored.result.current.operation?.phase).toBe('retry'))
  expect(restored.result.current.operation?.input).toEqual(original)
  vi.mocked(apiClient.request).mockRejectedValueOnce(new Error('still unavailable'))
  act(() => restored.result.current.retry())
  await waitFor(() => expect(apiClient.request).toHaveBeenCalledTimes(2))
  expect(vi.mocked(apiClient.request).mock.calls[1]?.[2]?.body).toEqual(original)
  restored.unmount(); client.clear()
})
