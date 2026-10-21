import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RootShell } from './RootShell'

let defaults: {
  data?: { value: { operator: { uiEnabled: boolean } } }; error: unknown; failureReason: unknown;
  isSuccess: boolean; isError: boolean; failureCount: number; dataUpdatedAt: number
}
vi.mock('@tanstack/react-router', () => ({ Outlet: () => null, useLocation: () => ({ pathname: '/workspaces' }), useBlocker: () => undefined }))
// These tests isolate Operator visibility; the connection boundary has separate tests.
vi.mock('./AppConnectionBoundary', () => ({ AppConnectionBoundary: ({ children }: { children: ReactNode }) => children }))
vi.mock('../shared/ui/AppNavigationHistory', () => ({ AppNavigationHistoryProvider: ({ children }: { children: ReactNode }) => children }))
vi.mock('../shared/api/query', () => ({ useAgentDefaultsQuery: () => defaults }))
// Theme sync reads shared settings; it is unrelated to Operator visibility.
vi.mock('../features/theme/useSyncedTheme', () => ({ useSyncedTheme: () => undefined }))
vi.mock('../features/operator-chat', () => ({
  OperatorChatVisibilityProvider: ({ enabled, children }: { enabled: boolean; children: ReactNode }) => enabled ? children : null,
  OperatorChat: ({ settingsWarning }: { settingsWarning?: string }) => <div><button>Operator available</button>{settingsWarning ? <p role="status">{settingsWarning}</p> : null}</div>,
}))
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })
function mountShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const shell = () => <QueryClientProvider client={client}><RootShell /></QueryClientProvider>
  const view = render(shell())
  return { rerender: () => view.rerender(shell()) }
}
function success(enabled = true) {
  defaults = { data: { value: { operator: { uiEnabled: enabled } } }, error: null, failureReason: null,
    isSuccess: true, isError: false, failureCount: 0, dataUpdatedAt: Date.now() }
}
describe('PR17 authorized last-known visibility', () => {
  it('retains enabled UI on a failed background refresh and shows a warning', () => {
    success()
    const view = mountShell()
    defaults = { ...defaults, isSuccess: false, isError: true, error: new Error('offline'), failureCount: 1 }
    view.rerender()
    expect(screen.getByRole('button', { name: 'Operator available' })).toBeInTheDocument()
    expect(screen.getByRole('status')).toHaveTextContent('last confirmed')
  })
  it.each([401, 403])('fails closed on %s, stays closed through network errors, and recovers only after success', (status) => {
    success()
    const view = mountShell()
    defaults = { ...defaults, isSuccess: false, isError: true, error: { status }, failureCount: 1 }
    view.rerender()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    defaults = { ...defaults, error: new Error('offline') }
    view.rerender()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    success()
    view.rerender()
    expect(screen.getByRole('button')).toBeInTheDocument()
  })
  it('does not invent an enabled setting before the first successful read or after explicit disablement', () => {
    success(false)
    const view = mountShell()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    defaults = { ...defaults, data: undefined, isSuccess: false, isError: true, failureCount: 1 }
    view.rerender()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
