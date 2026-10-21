import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'
import { ApiError } from '../../shared/api/client'
import { BoardAgentSettings } from '../workflow-board/AgentControls'
import { fixture } from '../graph/nextDraft/core.cases'
import { useGraphDraftStore } from '../graph/store'
import * as client from './client'
import { savedPlacementFixture as placement } from './fixtures'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { worktreeFixture } from '../workflow-board/worktree.fixtures'

it('Board Apply changes the exact node draft while keeping saved placement and other nodes separate', async () => {
  const context = fixture(), key = 'placement-apply-test'
  useGraphDraftStore.getState().installNextDraft(key, context)
  const read = vi.spyOn(client, 'readPlacementChoices').mockResolvedValue({ workspaceId: 'workspace', workflowId: 'workflow', nodeId: 'node-0', agentConfigurationVersionId: 'configuration-0',
    pending: false, choices: [{ id: 'choice-laptop', label: 'Laptop', placement, availability: 'ready', reason: null }] })
  function Board() {
    const edit = useGraphDraftStore((state) => state.nextDrafts[key])!
    return <BoardAgentSettings draftKey={key} edit={edit} nodeId="node-0" close={() => undefined} />
  }
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={query}><Board /></QueryClientProvider>)
  await screen.findByRole('option', { name: 'Laptop' })
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), '0')
  const before = useGraphDraftStore.getState().nextDrafts[key]!
  expect(nativeNode(before.graph.nodes[0])?.placement).toBeUndefined()
  expect(before.agentForms?.['node-0']?.placement).toEqual(placement)
  expect(screen.getByText(/Editing computer choice/)).toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Apply agent settings to draft' }))
  const applied = useGraphDraftStore.getState().nextDrafts[key]!
  expect(nativeNode(applied.graph.nodes[0])?.placement).toEqual(placement)
  expect(screen.getByText('Applied to draft')).toBeInTheDocument()
  const user = userEvent.setup()
  const computerHint = screen.getByRole('button', { name: 'About Computer' })
  await user.hover(computerHint)
  expect(screen.getByRole('tooltip')).toHaveTextContent(
    'Apply changes this node’s draft. Save graph persists it for a later Run. An accepted Run keeps its original placement.',
  )
  await user.unhover(computerHint)
  expect(nativeNode(applied.graph.nodes[1])?.placement).toBeUndefined()
  expect(nativeNode(applied.context.draft.graph.nodes[0])?.placement).toBeUndefined()
  expect(applied.agentForms?.['node-0']).toBeUndefined()
  view.unmount(); query.clear(); read.mockRestore(); useGraphDraftStore.getState().dropNextDraft(key)
})

it('keeps computer selection on the clicked node when two nodes share one Agent', async () => {
  const context = fixture(), key = 'shared-agent-placement-test'
  const original = nativeNode(context.draft.graph.nodes[0])!
  const sibling = { ...original, id: 'same-agent-second-node', position: { x: 500, y: 0 } }
  context.draft.graph = { ...context.draft.graph, nodes: [...context.draft.graph.nodes, sibling] }
  useGraphDraftStore.getState().installNextDraft(key, context)
  const read = vi.spyOn(client, 'readPlacementChoices').mockImplementation(async scope => ({ ...scope,
    pending: false, choices: [{ id: 'choice-laptop', label: 'Laptop', placement, availability: 'ready', reason: null }] }))
  function Board() {
    const edit = useGraphDraftStore(state => state.nextDrafts[key])!
    return <BoardAgentSettings draftKey={key} edit={edit} nodeId={sibling.id} close={() => undefined} />
  }
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={query}><Board /></QueryClientProvider>)
  await screen.findByRole('option', { name: 'Laptop' })
  expect(read.mock.calls[0]?.[0].nodeId).toBe(sibling.id)
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), '0')
  expect(useGraphDraftStore.getState().nextDrafts[key]?.agentForms?.[sibling.id]?.placement).toEqual(placement)
  expect(useGraphDraftStore.getState().nextDrafts[key]?.agentForms?.[original.id]).toBeUndefined()
  await userEvent.click(screen.getByRole('button', { name: 'Apply agent settings to draft' }))
  const applied = useGraphDraftStore.getState().nextDrafts[key]!
  expect(nativeNode(applied.graph.nodes.find(node => node.id === sibling.id))?.placement).toEqual(placement)
  expect(nativeNode(applied.graph.nodes.find(node => node.id === original.id))?.placement).toBeUndefined()
  expect(nativeNode(applied.context.draft.graph.nodes.find(node => node.id === sibling.id))?.placement).toBeUndefined()
  view.unmount(); query.clear(); read.mockRestore(); useGraphDraftStore.getState().dropNextDraft(key)
})

it('applies inherited Main by removing only the selected node placement from the draft', async () => {
  const context = fixture()
  const key = 'placement-clear-test'
  context.draft.graph.nodes = context.draft.graph.nodes.map(node => ({ ...node, placement }))
  useGraphDraftStore.getState().installNextDraft(key, context)
  const read = vi.spyOn(client, 'readPlacementChoices').mockImplementation(async scope => ({ ...scope,
    pending: false, choices: [{ id: 'choice-laptop', label: 'Laptop', placement, availability: 'ready', reason: null }] }))
  function Board() {
    const edit = useGraphDraftStore(state => state.nextDrafts[key])!
    return <BoardAgentSettings draftKey={key} edit={edit} nodeId="node-0" close={() => undefined} />
  }
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={query}><Board /></QueryClientProvider>)
  await screen.findByRole('option', { name: 'Laptop' })
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), 'inherited')
  expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]).placement).toEqual(placement)
  await userEvent.click(screen.getByRole('button', { name: 'Apply agent settings to draft' }))
  const applied = useGraphDraftStore.getState().nextDrafts[key]!
  expect(applied.graph.nodes[0]).not.toHaveProperty('placement')
  expect(nativeNode(applied.graph.nodes[1]).placement).toEqual(placement)
  expect(nativeNode(applied.context.draft.graph.nodes[0]).placement).toEqual(placement)
  view.unmount()
  query.clear()
  read.mockRestore()
  useGraphDraftStore.getState().dropNextDraft(key)
})

it('inherits a workflow worktree and applies a branch-only override to the selected node', async () => {
  const context = fixture()
  const project = worktreeFixture('workspace')
  context.draft.graph.defaultWorktree = { rootBinding: project.rootBinding, branchPrefix: 'foreman/workflow' }
  const key = 'branch-prefix-node-test'
  useGraphDraftStore.getState().installNextDraft(key, context)
  server.use(
    http.get('/api/management/workspaces/workspace/source-roots', () => HttpResponse.json({ items: [project.root], readiness: 'metadata-only' })),
    http.get('/api/management/workspaces/workspace/root-policies', () => HttpResponse.json({ workspaceId: 'workspace',
      policies: [project.location.binding], allowlists: [], readiness: 'metadata-only' })),
    http.post('/api/management/workspaces/workspace/sources/get', () => HttpResponse.json(project.source)),
    http.get('/api/management/workspaces/workspace', () => HttpResponse.json({ workspace: { id: 'workspace', name: 'Website',
      repository: project.repository }, revision: 2, archivedAt: null, executionLocation: project.location.executionLocation,
      locationRevision: 1, locationValidation: { status: 'ready', checkedAt: project.source.approvedAt } })),
  )
  const read = vi.spyOn(client, 'readPlacementChoices').mockImplementation(async scope => ({ ...scope,
    pending: false, choices: [{ id: 'choice-laptop', label: 'Laptop', placement, availability: 'ready', reason: null }] }))
  function Board() {
    const edit = useGraphDraftStore(state => state.nextDrafts[key])!
    return <BoardAgentSettings draftKey={key} edit={edit} nodeId="node-0" close={() => undefined} />
  }
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={query}><Board /></QueryClientProvider>)
  const user = userEvent.setup()
  try {
    await screen.findByText(/Inherited from workflow: Main · octo-owner\/website/)
    expect(screen.getByRole('textbox', { name: 'Agent branch prefix' })).toHaveValue('')
    await user.type(screen.getByRole('textbox', { name: 'Agent branch prefix' }), 'foreman/reviewer')
    expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]).worktree).toBeUndefined()
    await user.click(screen.getByRole('button', { name: 'Apply agent settings to draft' }))
    const applied = useGraphDraftStore.getState().nextDrafts[key]!
    expect(nativeNode(applied.graph.nodes[0]).worktree).toEqual({ branchPrefix: 'foreman/reviewer' })
    expect(applied.graph.nodes[0]).not.toHaveProperty('placement')
    expect(applied.graph.nodes[1]).not.toHaveProperty('worktree')
    expect(applied.context.draft.graph.nodes[0]).not.toHaveProperty('worktree')
    expect(screen.getByRole('textbox', { name: 'Agent branch prefix' })).toHaveValue('foreman/reviewer')
    const prefixHint = screen.getByRole('button', { name: 'About Agent branch prefix' })
    await user.hover(prefixHint)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Optional override. Each execution adds a unique suffix.')
    await user.unhover(prefixHint)
  } finally {
    view.unmount()
    query.clear()
    read.mockRestore()
    useGraphDraftStore.getState().dropNextDraft(key)
  }
})

it('Use workflow default clears both placement and prefix while retaining other node fields', async () => {
  const context = fixture()
  const key = 'clear-node-worktree-test'
  context.draft.graph.nodes = context.draft.graph.nodes.map(node => ({ ...node, placement,
    initialPrompt: 'Keep this task', worktree: { branchPrefix: 'foreman/override' } }))
  useGraphDraftStore.getState().installNextDraft(key, context)
  const read = vi.spyOn(client, 'readPlacementChoices').mockImplementation(async scope => ({ ...scope,
    pending: false, choices: [{ id: 'choice-laptop', label: 'Laptop', placement, availability: 'ready', reason: null }] }))
  function Board() {
    const edit = useGraphDraftStore(state => state.nextDrafts[key])!
    return <BoardAgentSettings draftKey={key} edit={edit} nodeId="node-0" close={() => undefined} />
  }
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={query}><Board /></QueryClientProvider>)
  try {
    await userEvent.click(screen.getByRole('button', { name: 'Use workflow default' }))
    expect(screen.getByRole('textbox', { name: 'Agent branch prefix' })).toHaveValue('')
    expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]).placement).toEqual(placement)
    await userEvent.click(screen.getByRole('button', { name: 'Apply agent settings to draft' }))
    const applied = useGraphDraftStore.getState().nextDrafts[key]!
    expect(applied.graph.nodes[0]).not.toHaveProperty('placement')
    expect(applied.graph.nodes[0]).not.toHaveProperty('worktree')
    expect(nativeNode(applied.graph.nodes[0]).initialPrompt).toBe('Keep this task')
    expect(nativeNode(applied.graph.nodes[1]).worktree).toEqual({ branchPrefix: 'foreman/override' })
    expect(nativeNode(applied.context.draft.graph.nodes[0]).placement).toEqual(placement)
    expect(nativeNode(applied.context.draft.graph.nodes[0]).worktree).toEqual({ branchPrefix: 'foreman/override' })
  } finally {
    view.unmount()
    query.clear()
    read.mockRestore()
    useGraphDraftStore.getState().dropNextDraft(key)
  }
})

it('keeps unrelated Agent edits when placement choices are denied for a saved placed node', async () => {
  const context = fixture(), key = 'placement-denied-retains-edits'
  context.draft.graph = { ...context.draft.graph, nodes: context.draft.graph.nodes.map((node, index) => index ? node : { ...nativeNode(node)!, placement }) }
  useGraphDraftStore.getState().installNextDraft(key, context)
  let deny!: () => void
  const read = vi.spyOn(client, 'readPlacementChoices').mockImplementation(() => new Promise((_, reject) => { deny = () => reject(new ApiError({ code: 'FORBIDDEN', message: 'Forbidden' }, 403)) }))
  function Board() {
    const edit = useGraphDraftStore((state) => state.nextDrafts[key])!
    return <BoardAgentSettings draftKey={key} edit={edit} nodeId="node-0" close={() => undefined} />
  }
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={query}><Board /></QueryClientProvider>)
  await userEvent.clear(screen.getByRole('textbox', { name: 'Name' }))
  await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), 'Renamed')
  expect(useGraphDraftStore.getState().nextDrafts[key]?.agentForms?.['node-0']?.name).toBe('Renamed')
  await act(async () => { deny() })
  await screen.findByText('Computer choices are unavailable.')
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Renamed')
  await userEvent.type(screen.getByRole('textbox', { name: 'Name' }), '!')
  const form = useGraphDraftStore.getState().nextDrafts[key]?.agentForms?.['node-0']
  expect(form).toMatchObject({ name: 'Renamed!' })
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveValue('Renamed!')
  view.unmount(); query.clear(); read.mockRestore(); useGraphDraftStore.getState().dropNextDraft(key)
})

it.each([403, 404, 503])('retains and clears a saved placement after choices discovery returns %s', async (status) => {
  const context = fixture()
  const key = `placement-discovery-failure-${status}`
  context.draft.graph.nodes = context.draft.graph.nodes.map(node => ({ ...node, placement }))
  useGraphDraftStore.getState().installNextDraft(key, context)
  const read = vi.spyOn(client, 'readPlacementChoices').mockRejectedValue(
    new ApiError({ code: 'CHOICES_UNAVAILABLE', message: 'Choices unavailable' }, status),
  )
  function Board() {
    const edit = useGraphDraftStore(state => state.nextDrafts[key])!
    return <BoardAgentSettings draftKey={key} edit={edit} nodeId="node-0" close={() => undefined} />
  }
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={query}><Board /></QueryClientProvider>)
  try {
    await screen.findByText('Computer choices are unavailable.')
    const computer = screen.getByRole('combobox', { name: 'Computer' })
    expect(computer).toHaveValue('retained')
    expect(screen.getByText(placement.projectRoot)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply agent settings to draft' })).toBeDisabled()
    await userEvent.selectOptions(computer, 'inherited')
    expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]).placement).toEqual(placement)
    await userEvent.click(screen.getByRole('button', { name: 'Apply agent settings to draft' }))
    const applied = useGraphDraftStore.getState().nextDrafts[key]!
    expect(applied.graph.nodes[0]).not.toHaveProperty('placement')
    expect(nativeNode(applied.graph.nodes[1]).placement).toEqual(placement)
    expect(nativeNode(applied.context.draft.graph.nodes[0]).placement).toEqual(placement)
  } finally {
    view.unmount()
    query.clear()
    read.mockRestore()
    useGraphDraftStore.getState().dropNextDraft(key)
  }
})
