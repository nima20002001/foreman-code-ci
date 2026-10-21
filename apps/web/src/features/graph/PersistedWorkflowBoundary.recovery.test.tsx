import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { createCurrentBoardMock } from '../../shared/mocks/currentBoard'
import { currentWorkflowFixture } from '../../shared/mocks/currentWorkflow'
import { installBrowserLocks } from '../../test/browserLocks'
import { boardDraftContextKey } from '../workflow-board/keys'
import { PersistedWorkflowBoundary } from './PersistedWorkflowBoundary'
import { useGraphDraftStore } from './store'

const warning = 'Draft updates unavailable. Running requires a fresh saved read.'
let client: QueryClient
let restoreLocks: () => void

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  useGraphDraftStore.getState().clearAllDrafts()
  sessionStorage.clear()
  restoreLocks = installBrowserLocks()
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  })
})

afterEach(() => {
  cleanup()
  client?.clear()
  useGraphDraftStore.getState().clearAllDrafts()
  restoreLocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mount() {
  const mock = createCurrentBoardMock({ workspaceId: 'ws-draft-recovery' })
  const graph = { ...currentWorkflowFixture('draft-recovery').version.definition, workspaceId: mock.workspaceId,
    nodes: [{ id: 'worker-node', agentId: mock.agents[0]!.id, name: 'Worker', position: { x: 0, y: 0 } }],
    edges: [], entryNodeId: 'worker-node' }
  mock.install(graph, true)
  server.use(...mock.handlers)
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><PersistedWorkflowBoundary
    workspaceId={mock.workspaceId} workflowId={graph.id} workflow={graph} /></QueryClientProvider>)
  await screen.findByRole('region', { name: 'Workflow authoring' })
  await screen.findByRole('button', { name: graph.name })
  return { mock, graph }
}

it('does not show a Board error for one failed draft poll and keeps polling without interaction', async () => {
  const { mock, graph } = await mount()
  let failed = false
  let recovered = false
  server.use(http.get(`/api/management/workspaces/${mock.workspaceId}/workflows/${graph.id}`, () => {
    if (!failed) {
      failed = true
      return HttpResponse.error()
    }
    recovered = true
    return HttpResponse.json(mock.managed(graph.id))
  }))
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
  await waitFor(() => expect(failed).toBe(true))
  await waitFor(() => expect(client.getQueryState(boardDraftContextKey(mock.workspaceId, graph.id))?.status).toBe('error'))
  expect(screen.queryAllByText(warning)).toHaveLength(0)
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
  await waitFor(() => expect(recovered).toBe(true))
  expect(screen.queryAllByText(warning)).toHaveLength(0)
  expect(screen.getByRole('button', { name: graph.name })).toBeVisible()
})

it('shows a sustained draft outage and clears it automatically after the next successful poll', async () => {
  const { mock, graph } = await mount()
  const editor = screen.getByRole('region', { name: 'Workflow authoring' })
  let available = false
  let failures = 0
  server.use(http.get(`/api/management/workspaces/${mock.workspaceId}/workflows/${graph.id}`, () => {
    if (available) return HttpResponse.json(mock.managed(graph.id))
    failures++
    return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Updates unavailable.' } }, { status: 503 })
  }))
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
  await waitFor(() => expect(failures).toBeGreaterThan(0))
  await waitFor(() => expect(client.getQueryState(boardDraftContextKey(mock.workspaceId, graph.id))?.status).toBe('error'))
  expect(screen.queryAllByText(warning)).toHaveLength(0)
  await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })
  expect(await screen.findAllByText(warning)).not.toHaveLength(0)
  available = true
  await act(async () => { await vi.advanceTimersByTimeAsync(3_000) })
  await waitFor(() => expect(screen.queryAllByText(warning)).toHaveLength(0))
  expect(screen.getByRole('region', { name: 'Workflow authoring' })).toBe(editor)
})
