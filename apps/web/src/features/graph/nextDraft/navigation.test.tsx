import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
import { act, cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { UnsavedChangesContext, type EditorRegistration } from '../../../shared/ui/unsavedChanges'
import { useGraphDraftStore } from '../store'
import { nextDraftKey } from './state'
import { fixture } from './core.cases'
import { NextDraftEditor } from './NextDraftEditor'
import { queryKeys } from '../../../shared/api/query'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import { http, HttpResponse } from 'msw'
import { server } from '../../../mocks/server'
import { agentChatFixtureFor } from '../../../shared/mocks/agentChatHandlers'

async function confirmDiscard(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Discard changes$/ }))
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }))
}
// Form/registration tests. This is not React Flow or authenticated browser evidence.
vi.mock('./DraftCanvas', () => ({ DraftCanvas: ({ open, panels, setOpen }: { open?: { nodeId: string; panel: 'chat' | 'settings' | 'info' }; panels?: (nodeId: string) => Record<string, unknown>; setOpen?: (panel: { nodeId: string; panel: 'chat' }) => void }) => <div>Canvas fixture<button onClick={() => setOpen?.({ nodeId: 'node-0', panel: 'chat' })}>Open fixture chat</button>{open && panels
  ? <section role="dialog" aria-label={`${open.nodeId} ${open.panel}`}>{panels(open.nodeId)[open.panel] as never}</section> : null}</div> }))
vi.mock('../../../shared/api/query', async (original) => ({
  ...await original<typeof import('../../../shared/api/query')>(),
  useInteractionsQuery: () => ({ data: { items: [] } }),
}))
const key = nextDraftKey('workspace', 'workflow')
beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts()
  const queues = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (name: string, work: (() => unknown) | LockOptions, claim?: (lock: { name: string }) => unknown) => {
    if (typeof work !== 'function') return claim!({ name: name })
    const result = (queues.get(name) ?? Promise.resolve()).then(work)
    queues.set(name, result.catch(() => {
      // ignore: the caller observes this request's failure; later lock requests must still run.
    }))
    return result
  } } })
})
afterEach(() => { cleanup(); useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks() })

function readyClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.managedWorkspace('workspace'), { workspace: { id: 'workspace', name: 'Fixture' },
    locationRevision: 1, locationValidation: { status: 'ready', checkedAt: '2026-09-23T00:00:00.000Z' } })
  return client
}
it.each(['workflow', 'agent'])('explains the required Save before chatting with an unsaved %s', async (kind) => {
  const context = fixture(['coder'])
  if (kind === 'workflow') context.draft.baseWorkflowVersionId = null
  else delete context.agents[0]!.agent.configurationVersionId
  useGraphDraftStore.getState().installNextDraft(key, context)
  const client = readyClient()
  render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
  await userEvent.click(screen.getByRole('button', { name: 'Open fixture chat' }))
  expect(await screen.findByRole('heading', { name: 'Save this Agent and workflow to chat' })).toBeVisible()
  expect(screen.getByText(/Save the Agent settings and workflow changes/)).toBeVisible()
  expect(document.querySelector('.agent-chat-panel')).not.toBeInTheDocument()
})
it.each([
  ['attachment', 'allowed'],
  ['second node', 'allowed'],
  ['attachment', 'denied'],
  ['second node', 'denied'],
])('requires Save for an unsaved %s of an existing Agent (%s chat access)', async (kind, access) => {
  const reads: string[] = []
  server.use(http.get('/api/local-human', () => HttpResponse.json({ principal: {
    id: 'chat-test-principal', name: 'Chat tester', expiresAt: '2099-01-01T00:00:00.000Z',
    grants: access === 'allowed' ? [{ actions: ['agent_chat:read'],
      scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'] } }] : [],
  } })))
  server.use(http.get('/api/workspaces/:workspaceId/agent-chat', ({ request }) => {
    reads.push(new URL(request.url).searchParams.get('workflowNodeId')!)
    return HttpResponse.json(agentChatFixtureFor(agentChatFixtures.empty, {
      workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node-0', agentId: 'agent-0',
    }))
  }))
  const context = fixture(['coder'])
  context.draft.graph.nodes[0]!.id = 'original-node'
  context.draft.graph.entryNodeId = 'original-node'
  useGraphDraftStore.getState().installNextDraft(key, context)
  act(() => useGraphDraftStore.getState().changeNextDraft(key, graph => ({ ...graph,
    entryNodeId: 'node-0',
    nodes: kind === 'attachment' ? [{ ...graph.nodes[0]!, id: 'node-0' }]
      : [...graph.nodes, { ...graph.nodes[0]!, id: 'node-0' }],
  })))
  const client = readyClient()
  const view = render(<QueryClientProvider client={client}>
    <NextDraftEditor workspaceId="workspace" workflowId="workflow" />
  </QueryClientProvider>)
  await userEvent.click(screen.getByRole('button', { name: 'Open fixture chat' }))
  expect(await screen.findByRole('heading', { name: 'Save this Agent and workflow to chat' })).toBeVisible()
  expect(screen.queryByTestId('agent-conversation')).not.toBeInTheDocument()
  expect(reads).toEqual([])
  act(() => useGraphDraftStore.getState().updateNextDraft(key, state => {
    const saved = { ...state.context.draft, graph: state.graph, baseWorkflowVersionId: 'workflow-version-2' }
    return { ...state, context: { ...state.context, draft: saved, savedDraft: saved } }
  }))
  if (access === 'allowed') {
    expect(await screen.findByTestId('agent-conversation')).toBeVisible()
    expect(reads).toEqual(['node-0'])
  } else {
    expect(await screen.findByText('Agent chat access unavailable')).toBeVisible()
    expect(screen.queryByTestId('agent-conversation')).not.toBeInTheDocument()
    expect(reads).toEqual([])
  }
  view.unmount()
  client.clear()
})
it('registers local form dirtiness and discard with the existing navigation guard', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const registrations = new Map<string, EditorRegistration>()
  const guard = { changed: vi.fn(), surfaces: async () => true, request: async () => true,
    register: (id: string, editor: EditorRegistration) => { registrations.set(id, editor); return () => { registrations.delete(id) } } }
  const user = userEvent.setup(), client = readyClient()
  render(<QueryClientProvider client={client}><UnsavedChangesContext.Provider value={guard}>
    <NextDraftEditor workspaceId="workspace" workflowId="workflow" />
  </UnsavedChangesContext.Provider></QueryClientProvider>)
    await user.click(screen.getByRole('button', { name: /Entry · Node 0/ }))
  const panel = await screen.findByRole('dialog', { name: /settings$/ })
  const name = within(panel).getByRole('textbox', { name: 'Name' }), original = (name as HTMLInputElement).value
  await user.clear(name); await user.type(name, 'Unsaved name')
  await user.click(within(panel).getByRole('button', { name: 'Apply agent settings to draft' }))
  const registered = [...registrations.values()].find((item) => item.current.label.endsWith('next draft'))!
  expect(registered.current.dirty).toBe(true)
  await act(async () => { await registered.current.discard() })
  expect(within(screen.getByRole('dialog', { name: /settings$/ })).getByRole('textbox', { name: 'Name' })).toHaveValue(original)
  expect(registered.current.dirty).toBe(false)
})
it('discarding a semantic edit preserves independent node layout', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const client = readyClient(), user = userEvent.setup()
  render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
  const position = { x: 615, y: -90 }
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node, index) => index === 0 ? { ...node, position, initialPrompt: 'Unpublished instruction' } : node),
  })))
  await confirmDiscard(user)
  const draft = useGraphDraftStore.getState().nextDrafts[key]!
  expect(nativeNode(draft.graph.nodes[0])?.initialPrompt).toBeUndefined()
  expect(nativeNode(draft.graph.nodes[0])?.position).toEqual(position)
  expect(draft.context.draft.revision).toBe(7)
})
it('principal teardown purges the unified local draft store', () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  useGraphDraftStore.getState().clearAllDrafts()
  expect(useGraphDraftStore.getState().nextDrafts).toEqual({})
})

it.each(['navigation', 'reload'])('quietly retains unfinished agent settings across %s', async (departure) => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const registrations = new Map<string, EditorRegistration>()
  const guard = { changed: vi.fn(), surfaces: async () => true, request: async () => true,
    register: (id: string, editor: EditorRegistration) => { registrations.set(id, editor); return () => { registrations.delete(id) } } }
  const user = userEvent.setup(), client = readyClient()
  const mount = () => render(<QueryClientProvider client={client}><UnsavedChangesContext.Provider value={guard}>
    <NextDraftEditor workspaceId="workspace" workflowId="workflow" />
  </UnsavedChangesContext.Provider></QueryClientProvider>)
  const first = mount()
  await user.click(screen.getByRole('button', { name: /Entry · Node 0/ }))
  const name = within(await screen.findByRole('dialog', { name: /settings$/ })).getByRole('textbox', { name: 'Name' })
  await user.clear(name); await user.type(name, 'Continue here')
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, description: 'Local workflow edit' })))
  const form = [...registrations.values()].find((entry) => entry.current.label === 'agent settings')!
  expect(form.current.dirty).toBe(true)
  expect(form.current.canResume?.()).toBe(true)
  first.unmount()
  if (departure === 'reload') useGraphDraftStore.setState({ nextDrafts: {} })
  mount()
  await user.click(await screen.findByRole('button', { name: /Entry · Node 0/ }))
  expect(within(await screen.findByRole('dialog', { name: /settings$/ })).getByRole('textbox', { name: 'Name' })).toHaveValue('Continue here')
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  expect(screen.queryByText(/Draft restored/)).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Apply agent settings to draft' }))
  const draft = useGraphDraftStore.getState().nextDrafts[key]!
  expect(nativeNode(draft.graph.nodes[0])?.name).toBe('Continue here')
  expect(draft.graph.description).toBe('Local workflow edit')
  expect(draft.context.draft.revision).toBe(7)
})

it('keeps protection when local storage fails', async () => {
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  const registrations = new Map<string, EditorRegistration>()
  const guard = { changed: vi.fn(), surfaces: async () => true, request: async () => true,
    register: (id: string, editor: EditorRegistration) => { registrations.set(id, editor); return () => { registrations.delete(id) } } }
  render(<QueryClientProvider client={readyClient()}><UnsavedChangesContext.Provider value={guard}>
    <NextDraftEditor workspaceId="workspace" workflowId="workflow" />
  </UnsavedChangesContext.Provider></QueryClientProvider>)
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, name: 'Unpublished name' })))
  const board = [...registrations.values()].find((entry) => entry.current.label.endsWith('next draft'))!
  expect(board.current.canResume?.()).toBe(true)
  const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('Storage full') })
  expect(board.current.canResume?.()).toBe(false)
  fail.mockRestore()
})
