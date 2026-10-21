import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
import { boardStartClient } from '../../workflow-board/startClient'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GraphEditIntentV3Schema, type GraphEditReadResultV3, type GraphEditStageInputV3 } from '@foreman-code/contracts/wave25'
import { queryKeys } from '../../../shared/api/query'
import { useGraphDraftStore } from '../store'
import { fixture } from './core.cases'
import { NextDraftEditor } from './NextDraftEditor'
import { nextDraftKey } from './state'
import { nextDraftApi } from './transport'
import { readEditOutbox } from './editIntentStorage'
import { journalIntent } from './nim2644Journal.fixture'

async function confirmDiscard(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Discard changes$/ }))
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog).toHaveTextContent('Agent positions on the board are kept. Running work isn’t affected.')
  await user.click(within(dialog).getByRole('button', { name: 'Discard changes' }))
}

async function confirmStop(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole('button', { name: 'Stop affected Runs and save' }))
  const dialog = await screen.findByRole('alertdialog')
  expect(dialog).toHaveTextContent('Stop-and-save stops every affected Run and waits for full cleanup before saving.')
  expect(dialog).toHaveTextContent('Stopped runs are not restarted.')
  await user.click(within(dialog).getByRole('button', { name: 'Stop runs and save' }))
}

// Mounted React state/form tests with a mocked transport and canvas. These do
// not claim an authenticated browser, React Flow geometry or native Stop test.
vi.mock('../../workflow-board/context', () => ({ useWorkflowBoard: () => ({ activeRuns: 1 }) }))
vi.mock('./DraftCanvas', () => ({ DraftCanvas: ({ open, panels }: { open?: { nodeId: string; panel: 'chat' | 'settings' | 'info' }; panels?: (nodeId: string) => Record<string, unknown> }) => <div>Canvas fixture{open && panels
  ? <section role="dialog" aria-label={`${open.nodeId} ${open.panel}`}>{panels(open.nodeId)[open.panel] as never}</section> : null}</div> }))
vi.mock('../../../shared/api/query', async (original) => ({
  ...await original<typeof import('../../../shared/api/query')>(),
  useInteractionsQuery: () => ({ data: { items: [] } }),
}))
const key = nextDraftKey('workspace', 'workflow')
const empty: GraphEditReadResultV3 = { intent: null, current: [], canStop: false, affectedSetChanged: false }
const clients: QueryClient[] = []
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  client.setQueryData(queryKeys.managedWorkspace('workspace'), { workspace: { id: 'workspace', name: 'Fixture' },
    locationRevision: 1, locationValidation: { status: 'ready', checkedAt: '2026-09-23T00:00:00.000Z' } })
  return render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
}
function changeMeaning() {
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node, index) => index ? node : { ...node, initialPrompt: 'Retained exact instruction', position: { x: 802, y: -71 } }),
  })))
}
function staged(request: GraphEditStageInputV3): GraphEditReadResultV3 {
  const pins = ['run-one', 'run-two'].map((runId, index) => ({ workspaceId: 'workspace', workflowId: index ? 'shared-workflow' : 'workflow',
    runId, workflowVersionId: `accepted-${runId}`, executionSemanticsVersion: 3 as const, agentConfigurationVersionIds: { agent: 'accepted-configuration' } }))
  // The journal retains the complete submitted V3 definition and pins, not an old server draft.
  const intent = GraphEditIntentV3Schema.parse({ ...journalIntent(request, fixture(), pins),
    id: 'private-intent', advanceCommandId: 'exact-advance', discardCommandId: 'exact-discard' })
  return { intent, canStop: true, affectedSetChanged: false, current: pins.map((pin) => ({ pin, terminal: false, settled: false,
    outcome: 'pending', cleanupPending: false, nativePending: true, interactionPending: true, reviewPending: false })) }
}
beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts(); localStorage.clear(); sessionStorage.clear()
  useGraphDraftStore.getState().installNextDraft(key, fixture())
  vi.stubGlobal('navigator', { ...navigator, locks: { request: async (_name: string, work: (() => Promise<unknown>) | LockOptions, claim?: (lock: { name: string }) => unknown) => typeof work === 'function' ? work() : claim!({ name: _name }) } })
  vi.spyOn(nextDraftApi, 'context').mockResolvedValue(fixture())
  vi.spyOn(nextDraftApi, 'editRead').mockResolvedValue(empty)
  vi.spyOn(nextDraftApi, 'pins').mockImplementation(async (_workspaceId, graph, _stagedAgents, agents) => ({
    expectedAgentConfigurationVersionIds: Object.fromEntries(graph.nodes.map(nativeNode).map(({ agentId }) => {
      const pin = agents?.find((item) => item.agent.id === agentId)?.agent.configurationVersionId
      if (!pin) throw new Error(`Fixture lacks the displayed configuration for ${agentId}`)
      return [agentId, pin]
    })), agents: agents ?? [],
  }))
})
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear())
  useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
it('shows both exact board actions; Discard does not Stop, publish, or erase independent layout', async () => {
  const stage = vi.spyOn(nextDraftApi, 'editStage'), advance = vi.spyOn(nextDraftApi, 'editAdvance'), start = vi.spyOn(boardStartClient, 'start')
  const user = userEvent.setup(); mount(); changeMeaning()
  expect(screen.getByRole('button', { name: /^Save workflow$/ })).toBeInTheDocument()
  await confirmDiscard(user)
  const edit = useGraphDraftStore.getState().nextDrafts[key]!
  expect(nativeNode(edit.graph.nodes[0])?.initialPrompt).toBeUndefined()
  expect(nativeNode(edit.graph.nodes[0])?.position).toEqual({ x: 802, y: -71 }); expect(edit.context.draft.revision).toBe(7)
  expect(stage).not.toHaveBeenCalled(); expect(advance).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled()
})
it('recovers a dropped Stage reply after full form-memory loss and retries the same payload, without Start', async () => {
  let persisted: GraphEditReadResultV3 = empty
  vi.mocked(nextDraftApi.editRead).mockImplementation(async () => persisted)
  const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => {
    if (!persisted.intent) { persisted = staged(input); throw new Error('Stage reply lost') }
    return persisted
  })
  const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => {
    persisted = { ...persisted, intent: { ...persisted.intent!, state: 'waiting' } }; return persisted
  })
  const start = vi.spyOn(boardStartClient, 'start'), user = userEvent.setup(), first = mount()
  changeMeaning()
  await user.click(screen.getByRole('button', { name: /^Save workflow$/ }))
  await waitFor(() => expect(stage).toHaveBeenCalledOnce())
  expect(advance).not.toHaveBeenCalled()
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  await waitFor(() => expect(readEditOutbox(key)).toBeDefined())
  const request = stage.mock.calls[0]![0]
  expect(readEditOutbox(key)?.request).toEqual(request)
  first.unmount()
  // Deliberate memory loss only; logout/clearAllDrafts would correctly purge the session.
  act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
  mount()
  await confirmStop(user)
  await waitFor(() => expect(advance).toHaveBeenCalledOnce())
  expect(stage.mock.calls.length).toBeGreaterThan(1)
  for (const [replay] of stage.mock.calls) expect(replay).toEqual(request)
  expect(advance.mock.calls[0]![0]).toMatchObject({ intentId: 'private-intent', commandId: 'exact-advance', action: 'stop_and_save' })
  expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]?.graph.nodes[0])?.initialPrompt).toBe('Retained exact instruction')
  expect(screen.getByText(/ · another workflow/)).toBeInTheDocument()
  expect(start).not.toHaveBeenCalled()
})
it('duplicate clicks share one stage/advance; private Discard reconciles without another Stop', async () => {
  let persisted: GraphEditReadResultV3 = empty
  vi.mocked(nextDraftApi.editRead).mockImplementation(async () => persisted)
  let releaseStage!: () => void
  const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => {
    // Discard reconciles the same Stage first; only the initial reply is delayed.
    if (persisted.intent) return persisted
    persisted = staged(input)
    await new Promise<void>((resolve) => { releaseStage = resolve })
    return persisted
  })
  let release!: (value: GraphEditReadResultV3) => void
  const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => new Promise((resolve) => { release = resolve }))
  const discard = vi.spyOn(nextDraftApi, 'editDiscard').mockImplementation(async () => (persisted = { ...persisted, intent: { ...persisted.intent!, state: 'discarded' } }))
  const user = userEvent.setup(); mount(); changeMeaning()
  await user.dblClick(screen.getByRole('button', { name: /^Save workflow$/ }))
  await waitFor(() => expect(stage).toHaveBeenCalledOnce())
  expect(advance).not.toHaveBeenCalled()
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  const request = stage.mock.calls[0]![0]
  await act(async () => { releaseStage() })
  expect(advance).not.toHaveBeenCalled()
  await user.dblClick(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop runs and save' }))
  await waitFor(() => expect(advance).toHaveBeenCalledOnce())
  // Confirmation re-reads the exact Stage receipt; it must not stage a new edit.
  for (const [replay] of stage.mock.calls) expect(replay).toEqual(request)
  await act(async () => { persisted = { ...persisted, intent: { ...persisted.intent!, state: 'waiting' } }; release(persisted) })
  await confirmDiscard(user)
  await waitFor(() => expect(discard).toHaveBeenCalledOnce())
  expect(discard.mock.calls[0]![0]).toMatchObject({ intentId: 'private-intent', commandId: 'exact-discard', action: 'discard_edits' })
  expect(advance).toHaveBeenCalledOnce()
  expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]?.graph.nodes[0])?.position).toEqual({ x: 802, y: -71 })
  expect(readEditOutbox(key)).toBeUndefined()
})

it('stages default worktree changes through Stop-and-save and locks further worktree edits', async () => {
  let persisted: GraphEditReadResultV3 = empty
  vi.mocked(nextDraftApi.editRead).mockImplementation(async () => persisted)
  const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async input => (persisted = staged(input)))
  const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => {
    persisted = { ...persisted, intent: { ...persisted.intent!, state: 'waiting' } }
    return persisted
  })
  const worktree = { rootBinding: { rootId: '99999999-9999-4999-8999-999999999999', bindingRevision: 1 },
    branchPrefix: 'foreman/saved-default' }
  const user = userEvent.setup()
  mount()
  act(() => useGraphDraftStore.getState().changeNextDraft(key, graph => ({ ...graph, defaultWorktree: worktree })))
  expect(screen.getByRole('button', { name: /^Worktree:/ })).toBeVisible()
  await user.click(screen.getByRole('button', { name: /^Save workflow$/ }))
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop runs and save' }))
  await waitFor(() => expect(advance).toHaveBeenCalledOnce())
  expect(stage.mock.calls[0]?.[0].graph.defaultWorktree).toEqual(worktree)
  expect(advance.mock.calls[0]?.[0]).toMatchObject({ action: 'stop_and_save' })
  expect(screen.getByRole('button', { name: /^Worktree:/ })).toBeDisabled()
  expect(useGraphDraftStore.getState().nextDrafts[key]?.graph.defaultWorktree).toEqual(worktree)
})


it('opens ordinary Agent settings without a Stop warning or staging a save', async () => {
  const stage = vi.spyOn(nextDraftApi, 'editStage')
  mount()
  await userEvent.setup().click(screen.getByRole('button', { name: /^(Entry · )?Node 0$/ }))
  const panel = await screen.findByRole('dialog', { name: 'node-0 settings' })
  expect(panel).not.toHaveTextContent('Executable changes require every affected Run')
  expect(stage).not.toHaveBeenCalled()
})
