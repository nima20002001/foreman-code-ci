import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GraphEditReadResultV3 } from '@foreman-code/contracts/wave25'
import { boardDraftContextKey } from '../workflow-board/keys'
import { PersistedWorkflowBoundary } from './PersistedWorkflowBoundary'
import { useGraphDraftStore } from './store'
import { fixture } from './nextDraft/core.cases'
import { journalIntent, savedJournal } from './nextDraft/nim2644Journal.fixture'
import { nextDraftApi, type AuthoringContext } from './nextDraft/transport'
import { nextDraftKey } from './nextDraft/state'
import { clearEditIntentStorage } from './nextDraft/editIntentStorage'

vi.mock('./nextDraft/DraftCanvas', () => ({ DraftCanvas: () => <div>Workflow canvas</div> }))

const clients: QueryClient[] = []
const empty: GraphEditReadResultV3 = { intent: null, current: [], canStop: false, affectedSetChanged: false }
const warning = /The shared draft changed elsewhere/
const sourceKey = () => boardDraftContextKey('workspace', 'workflow')
const draftKey = nextDraftKey('workspace', 'workflow')

function mount(context: AuthoringContext) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}>
    <PersistedWorkflowBoundary workspaceId="workspace" workflowId="workflow" workflow={context.draft.graph} />
  </QueryClientProvider>)
  return client
}

async function rename() {
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Authoring fixture' }))
  const name = screen.getByRole('textbox', { name: 'Workflow name' })
  await user.clear(name)
  await user.type(name, 'Renamed workflow{Enter}')
  // A new name is applied only after the rename is confirmed.
  await user.click(await screen.findByRole('button', { name: 'Rename' }))
  return user
}

beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts()
  localStorage.clear()
  sessionStorage.clear()
  vi.stubGlobal('navigator', { ...navigator, locks: {
    request: async (name: string, optionsOrWork: LockOptions | ((lock: Lock) => Promise<unknown>),
      work?: (lock: Lock) => Promise<unknown>) => {
      const callback = typeof optionsOrWork === 'function' ? optionsOrWork : work!
      return callback({ name, mode: 'exclusive' })
    },
  } })
  vi.spyOn(nextDraftApi, 'editRead').mockResolvedValue(empty)
  vi.spyOn(nextDraftApi, 'pins').mockResolvedValue({ expectedAgentConfigurationVersionIds: {
    'agent-0': 'configuration-0', 'agent-1': 'configuration-1',
  }, agents: fixture().agents })
})

afterEach(() => {
  cleanup()
  clearEditIntentStorage()
  clients.splice(0).forEach((client) => client.clear())
  useGraphDraftStore.getState().clearAllDrafts()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

it('opens the persisted draft for editing without a storage error', async () => {
  const context = fixture()
  vi.spyOn(nextDraftApi, 'context').mockResolvedValue(context)
  mount(context)
  expect(await screen.findByRole('button', { name: 'Authoring fixture' })).toBeVisible()
  expect(screen.queryByRole('heading', { name: 'Authoring unavailable' })).not.toBeInTheDocument()
})

it.each(['draft read first', 'save reply first'] as const)(
  'does not report its own save as a conflict with %s', async (order) => {
    const context = fixture()
    let release!: (value: AuthoringContext) => void
    const refetch = new Promise<AuthoringContext>((resolve) => { release = resolve })
    let releaseSave!: () => void
    const acknowledgement = new Promise<void>((resolve) => { releaseSave = resolve })
    vi.spyOn(nextDraftApi, 'context').mockResolvedValueOnce(context).mockReturnValue(refetch)
    let saved: AuthoringContext | undefined
    vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => {
      const intent = savedJournal(journalIntent(input, context))
      const result = intent.result!
      saved = { ...context, draft: { ...context.draft, graph: result.version.definition,
        revision: result.revision, publishedRevision: result.revision, baseWorkflowVersionId: result.currentVersionId } }
      if (order === 'draft read first') await acknowledgement
      return { ...empty, intent }
    })
    const client = mount(context)
    const user = await rename()
    await user.click(screen.getByRole('button', { name: 'Save workflow' }))
    await waitFor(() => expect(saved).toBeDefined())
    if (order === 'draft read first') {
      await act(async () => {
        release(saved!)
        await client.refetchQueries({ queryKey: sourceKey() })
      })
      await waitFor(() => expect(client.getQueryData<AuthoringContext>(sourceKey())?.draft.revision).toBe(8))
      expect(useGraphDraftStore.getState().nextDrafts[draftKey]?.context.draft.revision).toBe(7)
      expect(screen.queryByText(warning)).not.toBeInTheDocument()
      await act(async () => { releaseSave() })
    }
    expect(await screen.findByText('Saved.')).toBeVisible()
    expect(screen.queryByText(warning)).not.toBeInTheDocument()
    await act(async () => { release(saved!) })
    await waitFor(() => expect(client.getQueryState(sourceKey())?.fetchStatus).toBe('idle'))
    expect(screen.queryByText(warning)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Renamed workflow' })).toBeVisible()
  },
)

it('warns about a newer external draft and retains the local rename and its original revision', async () => {
  const context = fixture()
  let incoming = context
  vi.spyOn(nextDraftApi, 'context').mockImplementation(async () => incoming)
  const client = mount(context)
  await rename()
  incoming = { ...context, draft: { ...context.draft, revision: 8, publishedRevision: 8,
    graph: { ...context.draft.graph, name: 'External rename' } } }
  await act(async () => { await client.refetchQueries({ queryKey: sourceKey() }) })
  expect(await screen.findByText(warning)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Renamed workflow' })).toBeVisible()
  expect(useGraphDraftStore.getState().nextDrafts[draftKey]?.context.draft.revision).toBe(7)
})
