// @vitest-environment jsdom
import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, memoryBoardTools } from '@foreman-code/contracts'
import { queryKeys } from '../../shared/api/query'
import { UnsavedChangesProvider } from '../../shared/ui/UnsavedChangesProvider'
import { fixture } from '../graph/nextDraft/core.cases'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftKey } from '../graph/nextDraft/state'
import { readEditSnapshot, storeEditSnapshot } from '../graph/nextDraft/editIntentStorage'
import { stageAgentEdits } from '../graph/nextDraft/agentEdits'
import { CreateBoardAgent } from './CreateBoardAgent'

const draftKey = nextDraftKey('workspace', 'workflow'), clients: QueryClient[] = []
const report = vi.fn(), opened = vi.fn()
beforeEach(() => {
  report.mockClear(); opened.mockClear(); localStorage.clear(); sessionStorage.clear()
  useGraphDraftStore.setState({ nextDrafts: {} })
  const context = fixture([]); context.draft.baseWorkflowVersionId = null
  useGraphDraftStore.getState().installNextDraft(draftKey, context)
})
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear())
  useGraphDraftStore.setState({ nextDrafts: {} }); localStorage.clear(); sessionStorage.clear()
})
function Surface() {
  const edit = useGraphDraftStore(state => state.nextDrafts[draftKey]!), [visible, setVisible] = useState(true)
  return visible ? <CreateBoardAgent draftKey={draftKey} edit={edit} report={report}
    openSettings={nodeId => { opened(nodeId); setVisible(false) }} close={() => setVisible(false)} /> : <p>Creation closed</p>
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client)
  client.setQueryData(queryKeys.agentDefaults, { value: DEFAULT_AGENT_DEFAULTS, revision: 1, versionId: 'defaults-version' })
  client.setQueryData(queryKeys.managedHarnessCatalog, [{ harness: 'codex', defaults: DEFAULT_HARNESS_DEFAULTS.codex,
    defaultsRevision: 1, capability: null, discoveryError: null }])
  const route = createRootRoute({ component: () => <UnsavedChangesProvider><Surface /></UnsavedChangesProvider> })
  const router = createRouter({ routeTree: route, history: createMemoryHistory({ initialEntries: ['/'] }) })
  return render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
}

it('edits the complete form before staging one private Master and its initial prompt', async () => {
  mount()
  await userEvent.selectOptions(await screen.findByLabelText('Role'), 'master')
  expect(screen.getByRole('combobox', { name: 'Harness' })).toHaveValue('codex')
  expect(screen.getByRole('combobox', { name: 'Model' })).toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: 'Account' })).toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: 'Effort' })).toBeInTheDocument()
  await userEvent.clear(screen.getByRole('textbox', { name: 'Name' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Project lead')
  await userEvent.type(screen.getByRole('textbox', { name: 'Initial prompt' }), 'Coordinate the requested change.')
  await userEvent.type(screen.getByRole('textbox', { name: 'Agent branch prefix' }), 'foreman/lead-work')
  const before = useGraphDraftStore.getState().nextDrafts[draftKey]!
  expect(before.graph.nodes).toEqual([])
  expect(stageAgentEdits(before)).toEqual([])
  await userEvent.click(screen.getByRole('button', { name: 'Add Master to draft' }))
  await waitFor(() => expect(opened).toHaveBeenCalledOnce())
  const staged = useGraphDraftStore.getState().nextDrafts[draftKey]!, changes = stageAgentEdits(staged)
  expect(changes).toHaveLength(1)
  expect(changes[0]).toMatchObject({ baseRevision: null, agent: { name: 'Project lead', productRole: 'master',
    graphqlTools: expect.arrayContaining(memoryBoardTools('write')) } })
  expect(changes[0]!.agent.configurationVersionId).toBeUndefined()
  expect(staged.graph.nodes).toEqual([expect.objectContaining({ id: opened.mock.calls[0]![0],
    initialPrompt: 'Coordinate the requested change.', worktree: { branchPrefix: 'foreman/lead-work' } })])
  expect(staged.context.agents).toEqual([])
  expect(staged.workflowForms?.createAgent).toBeUndefined()
  expect(report).not.toHaveBeenCalled()
})

it('retains the unapplied creation form across remount and requires an explicit Cancel discard', async () => {
  const view = mount()
  await userEvent.clear(await screen.findByRole('textbox', { name: 'Name' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Unapplied Worker')
  await userEvent.type(screen.getByRole('textbox', { name: 'Initial prompt' }), 'Keep this unsaved task')
  storeEditSnapshot(draftKey, useGraphDraftStore.getState().nextDrafts[draftKey]!)
  const retained = readEditSnapshot(draftKey)!
  view.unmount()
  useGraphDraftStore.setState({ nextDrafts: {} })
  useGraphDraftStore.getState().installNextDraft(draftKey, retained.context)
  useGraphDraftStore.getState().updateNextDraft(draftKey, edit => ({ ...edit, ...retained }))
  mount()
  expect(await screen.findByRole('textbox', { name: 'Name' })).toHaveValue('Unapplied Worker')
  expect(screen.getByRole('textbox', { name: 'Initial prompt' })).toHaveValue('Keep this unsaved task')
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  const dialog = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
  expect(stageAgentEdits(useGraphDraftStore.getState().nextDrafts[draftKey]!)).toEqual([])
  await userEvent.click(within(dialog).getByRole('button', { name: 'Discard' }))
  await screen.findByText('Creation closed')
  expect(useGraphDraftStore.getState().nextDrafts[draftKey]!.graph.nodes).toEqual([])
  expect(useGraphDraftStore.getState().nextDrafts[draftKey]!.workflowForms?.createAgent).toBeUndefined()
  expect(opened).not.toHaveBeenCalled()
})
