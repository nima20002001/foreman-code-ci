import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { routeTree } from '../app/router'
import { clearEditIntentStorage } from '../features/graph/nextDraft/editIntentStorage'
import { useGraphDraftStore } from '../features/graph/store'
import { installFlowLayout } from '../features/run-board/testFlowLayout'
import { bindMockInstallation } from '../shared/mocks/handlers'
import { setMockScenario } from '../shared/mocks/scenarios'
import { installBrowserLocks } from '../test/browserLocks'

const clients: QueryClient[] = []

beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts()
  localStorage.clear()
  sessionStorage.clear()
  bindMockInstallation()
  installFlowLayout(1000, 720)
  installBrowserLocks()
})

afterEach(() => {
  cleanup()
  clearEditIntentStorage()
  clients.splice(0).forEach(client => client.clear())
  useGraphDraftStore.getState().clearAllDrafts()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  setMockScenario('normal')
})

it('opens the saved workflow for authoring before any departure', async () => {
  const history = createMemoryHistory({
    initialEntries: ['/workspaces/workspace-1?workflowId=workflow-content-pipeline'],
  })
  const router = createRouter({ routeTree, history })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)

  const authoring = await screen.findByLabelText('Workflow authoring', {}, { timeout: 8000 })
  expect(authoring).toHaveRole('region')
  expect(within(authoring).getByRole('heading', { name: 'Research to review' })).toBeVisible()
  const researcher = await within(authoring).findByLabelText(
    /^Researcher, .*starts the workflow.*Draft$/, {}, { timeout: 8000 },
  )
  expect(researcher).toHaveRole('button')
  expect(researcher).toBeVisible()
  expect(within(authoring).getByLabelText('Editable workflow graph')).toBeVisible()
  expect(router.state.location.pathname).toBe('/workspaces/workspace-1')
  expect(screen.queryByRole('heading', { name: 'Authoring unavailable' })).not.toBeInTheDocument()
  expect(router.state.location.search.workflowId).toBe('workflow-content-pipeline')
})

it.each([
  ['/workspaces/workspace-1/workflows', 'Workflows'],
  ['/workspaces/workspace-1/agents', 'Agents'],
  ['/workspaces', 'Workspaces'],
])(
  'leaves the board for %s without flashing an invalid board selection', async (destination, heading) => {
    const history = createMemoryHistory({ initialEntries: ['/workspaces/workspace-1?workflowId=workflow-content-pipeline'] })
    const router = createRouter({ routeTree, history })
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    clients.push(client)
    const flashes: string[] = []
    const observer = new MutationObserver(records => {
      for (const record of records) for (const node of record.addedNodes) {
        if (node instanceof Element && node.textContent?.includes('Invalid board selection')) flashes.push(destination)
      }
    })
    render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
    const authoring = await screen.findByRole('region', { name: 'Workflow authoring' }, { timeout: 8000 })
    expect(within(authoring).getByRole('heading', { name: 'Research to review' })).toBeVisible()
    const canvas = within(authoring).getByLabelText('Editable workflow graph')
    expect(await within(canvas).findByRole('button', { name: /^Researcher,/ }, { timeout: 8000 })).toBeVisible()
    expect(await within(authoring).findByRole('button', {
      name: /^Researcher, .*starts the workflow.*Draft$/,
    }, { timeout: 8000 })).toBeVisible()
    expect(screen.getByTestId('unified-workflow-board')).toBeVisible()
    observer.observe(document.body, { childList: true, subtree: true })
    await act(async () => { history.push(destination) })
    await waitFor(() => expect(router.state.location.pathname).toBe(destination))
    await waitFor(() => {
      expect(router.state.status).toBe('idle')
      expect(screen.queryByTestId('unified-workflow-board')).not.toBeInTheDocument()
    })
    expect(await screen.findByRole('heading', { name: heading, level: 1 })).toBeVisible()
    observer.disconnect()
    expect(screen.queryByText('Invalid board selection')).not.toBeInTheDocument()
    expect(flashes).toEqual([])
  }, 30_000)

it('still explains a board link that is invalid', async () => {
  const router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: ['/workspaces/workspace-1?selectedRunId=run-1'] }) })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  expect(await screen.findByText('Invalid board selection', {}, { timeout: 8000 })).toBeVisible()
})
