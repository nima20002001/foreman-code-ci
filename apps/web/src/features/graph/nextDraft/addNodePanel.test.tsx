import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { server } from '../../../mocks/server'
import { queryKeys } from '../../../shared/api/query'
import { definition } from '../../jobs/fixtures'
import { useGraphDraftStore } from '../store'
import { nextDraftKey } from './state'
import { fixture } from './core.cases'
import { NextDraftEditor } from './NextDraftEditor'

// Panel test with a stubbed canvas whose buttons stand for pane and node clicks (both go through the editor's `inspect`).
vi.mock('./DraftCanvas', () => ({ DraftCanvas: ({ inspect }: { inspect(action: () => void): void }) => <>
  <button onClick={() => inspect(() => undefined)}>Canvas fixture</button>
  <button onClick={() => inspect(() => undefined)}>Select fixture node</button></> }))
vi.mock('../../../shared/api/query', async (original) => ({
  ...await original<typeof import('../../../shared/api/query')>(),
  useInteractionsQuery: () => ({ data: { items: [] } }),
}))
const key = nextDraftKey('workspace', 'workflow')
const saved = { ...definition, workspaceId: 'workspace' }
beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts()
  const queues = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, work: (() => unknown) | LockOptions, claim?: (lock: { name: string }) => unknown) => {
    if (typeof work !== 'function') return claim!({ name: name })
    const result = (queues.get(name) ?? Promise.resolve()).then(work)
    queues.set(name, result.catch(() => { /* ignore: a failed lock holder must not block the next one */ }))
    return result
  } } })
  server.use(http.get('*/api/management/workspaces/:workspaceId/jobs/definitions', () => HttpResponse.json({ definitions: [saved] })))
})
afterEach(() => { cleanup(); useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks() })

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.managedWorkspace('workspace'), { workspace: { id: 'workspace', name: 'Fixture' },
    locationRevision: 1, locationValidation: { status: 'ready', checkedAt: '2026-09-23T00:00:00.000Z' } })
  return render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
}

const panel = () => within(screen.getByRole('complementary', { name: 'Add node' }))
const openPanel = (user: ReturnType<typeof userEvent.setup>) => user.click(screen.getByRole('button', { name: 'Add agent or job to graph' }))

it('offers only the available Agents, each with one Add action', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const user = userEvent.setup(); mount()
  await openPanel(user)
  expect(panel().getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Agent 0WorkerAdd', 'Agent 1WorkerAdd'])
  expect(panel().getByRole('button', { name: 'Add Agent 0' })).toBeEnabled()
  for (const gone of [/Saved jobs/, /one-pass/i, /Existing agent/, /Choose a node/, /Add to workflow/]) expect(panel().queryByText(gone)).toBeNull()
  expect(panel().queryByRole('button', { name: 'Worker' })).toBeNull()
  expect(panel().queryByRole('button', { name: 'Orchestrator' })).toBeNull()
  expect(panel().queryByRole('button', { name: /Web build/ })).toBeNull()
})

it('shows no job or one-pass explanation on a handoff workflow either', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, handoffs: { contractVersion: 1 } }) as typeof graph))
  const user = userEvent.setup(); mount()
  await openPanel(user)
  expect(panel().queryByText(/Saved jobs|one-pass/i)).toBeNull()
  expect(panel().queryByRole('button', { name: 'Use one-pass dependencies' })).toBeNull()
  expect(panel().getByRole('button', { name: 'Add Agent 1' })).toBeVisible()
})

it('adds the chosen Agent to the draft without a fixed position and keeps the panel open', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const user = userEvent.setup(); mount()
  await openPanel(user)
  await user.click(panel().getByRole('button', { name: 'Add Agent 1' }))
  const added = useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes.filter((node) => node.kind !== 'job')
  expect(added).toHaveLength(3)
  expect(added[2]).toMatchObject({ agentId: 'agent-1' })
  expect(added[2]).not.toHaveProperty('position')
  expect(screen.getByRole('complementary', { name: 'Add node' })).toBeVisible()
})

it('stays open when the Board is clicked or an Agent is selected, and closes only from its X or Escape', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const user = userEvent.setup(); mount()
  await openPanel(user)
  const picker = screen.getByRole('complementary', { name: 'Add node' })
  await user.click(screen.getByRole('button', { name: 'Canvas fixture' }))
  await user.click(screen.getByRole('button', { name: 'Select fixture node' }))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
  expect(picker).toBeVisible()
  await user.click(within(picker).getByRole('button', { name: 'Close node picker' }))
  await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Add node' })).toBeNull())
  await openPanel(user)
  expect(screen.getByRole('complementary', { name: 'Add node' })).toHaveFocus()
  await user.keyboard('{Escape}')
  await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Add node' })).toBeNull())
})
