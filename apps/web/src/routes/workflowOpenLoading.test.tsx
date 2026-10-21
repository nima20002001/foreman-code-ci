import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RouterProvider, createMemoryHistory, createRouter } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { http } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { routeTree } from '../app/router'
import { clearEditIntentStorage } from '../features/graph/nextDraft/editIntentStorage'
import { useGraphDraftStore } from '../features/graph/store'
import { installFlowLayout } from '../features/run-board/testFlowLayout'
import { server } from '../mocks/server'
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

function gate() {
  let release!: () => void
  const opened = new Promise<void>(resolve => { release = resolve })
  return { opened, release }
}

/** Loading indicators in the Board area that are not the Board-shaped skeleton. */
function strayLoading(area: HTMLElement) {
  const inBoard = (element: Element) => element.closest('[data-testid="board-loading"]')
  return [...area.querySelectorAll('.n-loading, [role="status"]')]
    .filter(element => !inBoard(element) && /loading/i.test(element.textContent ?? ''))
    .map(element => element.textContent)
}

it('shows one Board-shaped skeleton in the Board area from the first byte until the editor opens', async () => {
  const workspace = gate(), draft = gate()
  server.use(
    http.get('/api/workspaces/workspace-1', async () => { await workspace.opened; return undefined }),
    http.get('/api/management/workspaces/workspace-1/agents', async () => { await draft.opened; return undefined }),
  )
  const router = createRouter({ routeTree,
    history: createMemoryHistory({ initialEntries: ['/workspaces/workspace-1?workflowId=workflow-content-pipeline'] }) })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)

  const area = await screen.findByRole('region', { name: 'Workflow graph' })
  const stray = new Set<string>()
  const observer = new MutationObserver(() => strayLoading(area).forEach(text => stray.add(text!)))
  observer.observe(area, { childList: true, subtree: true, characterData: true })
  try {
    // Workspace read pending: the skeleton already has the Board's place and shape.
    expect(await within(area).findByTestId('board-loading')).toBeVisible()
    expect(strayLoading(area)).toEqual([])
    workspace.release()

    // Draft read pending: the very same skeleton stays, nothing else loads over or beside it.
    await waitFor(() => expect(screen.queryByText('Loading workspace…')).not.toBeInTheDocument())
    expect(within(area).getByTestId('board-loading')).toBeVisible()
    expect(strayLoading(area)).toEqual([])
    draft.release()

    const authoring = await within(area).findByLabelText('Workflow authoring', {}, { timeout: 8000 })
    expect(within(authoring).getByLabelText('Editable workflow graph')).toBeVisible()
    expect(within(area).queryByTestId('board-loading')).not.toBeInTheDocument()
    expect(strayLoading(area)).toEqual([])
    expect([...stray]).toEqual([])
  } finally { observer.disconnect() }
})
