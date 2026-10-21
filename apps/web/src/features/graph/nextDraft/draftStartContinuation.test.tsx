import { act, cleanup, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import type { GraphEditReadResultV3 } from '@foreman-code/contracts/wave25'
import { http, HttpResponse } from 'msw'
import { server } from '../../../mocks/server'
import { deferred } from '../../../test/deferred'
import { createCurrentBoardMock } from '../../../shared/mocks/currentBoard'
import { currentWorkflowFixture } from '../../../shared/mocks/currentWorkflow'
import { beginSessionChange, finishSessionChange } from '../../../shared/api/sessionBoundary'
import { useGraphDraftStore } from '../store'
import { clearBoardStartStorage, readBoardStart } from '../../workflow-board/startOutbox'
import { WorkflowBoardContext } from '../../workflow-board/context'
import { RunActivityPanel } from '../../workflow-board/RunActivityPanel'
import { boardRunListKey } from '../../workflow-board/keys'
import { boardStartClient } from '../../workflow-board/startClient'
import * as startPreflight from '../../workflow-board/startPreflight'
import { fixture } from './core.cases'
import { nextDraftKey } from './state'
import { journalIntent, journalRequest, savedJournal } from './nim2644Journal.fixture'
import { useDraftStartMutation, type DraftStartState } from './useDraftStart'
import type { DraftEditorCore } from './useDraftEditorCore'
import type { useGraphEditIntent } from './useGraphEditIntent'

const key = nextDraftKey('workspace', 'workflow')
const clients: QueryClient[] = []
const access = (allowed = true) => server.use(http.get('/api/local-human', () => HttpResponse.json({ principal: {
  id: 'local-principal', name: 'Operator', expiresAt: '2099-01-01T00:00:00Z',
  grants: allowed ? [{ actions: ['runs:start'], scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'] } }] : [],
} })))
beforeEach(() => {
  localStorage.clear()
  sessionStorage.clear()
  useGraphDraftStore.getState().clearAllDrafts()
  vi.stubGlobal('navigator', { locks: { request: async (_name: string, work: () => unknown) => work() } })
  access()
})
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  clearBoardStartStorage()
  useGraphDraftStore.getState().clearAllDrafts()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function setup() {
  const context = fixture()
  const mock = createCurrentBoardMock({ workspaceId: 'workspace', initialWorkflow: context.draft.graph,
    allowSimulatedStart: true, agents: context.agents.map(({ agent }) => ({ ...agent,
      harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex })) })
  const workflow = mock.managed('workflow')
  const displayed = mock.drafts.get('workflow')!
  const facts: startPreflight.BoardStartPreflight = {
    workflow, capabilities: mock.capabilities(), version: mock.versions.get(workflow.currentVersionId!)!,
    workspace: ManagedWorkspaceSchema.parse({ workspace: { id: 'workspace', name: 'Workspace', agentIds: [], workflowIds: ['workflow'] },
      revision: 1, archivedAt: null, locationRevision: 1, executionLocation: { runnerId: 'runner', rootPath: '/workspace' },
      locationValidation: { status: 'ready', checkedAt: '2026-10-01T00:00:00Z' } }),
  }
  useGraphDraftStore.getState().installNextDraft(key, { ...context, draft: displayed })
  vi.spyOn(startPreflight, 'readBoardStartPreflight').mockImplementation(async () => facts)
  let selection = 0
  const selectRun = vi.fn()
  const core = {
    alive: { current: true }, latestBoard: { current: { selectRun, getSelectionToken: () => selection } },
    runAfterSave: { current: false }, setLocalError: vi.fn(), setMessage: vi.fn(), report: vi.fn(),
  } as unknown as DraftEditorCore
  const startState = { canStart: true, preflight: { data: facts, isError: false } } as DraftStartState
  let data: GraphEditReadResultV3 = { intent: null, current: [], canStop: false, affectedSetChanged: false }
  const stopAndSave = vi.fn(async () => data)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const hook = renderHook(() => useDraftStartMutation({ draftKey: key,
    edit: useGraphDraftStore.getState().nextDrafts[key]!,
    core, startState, stopAndSave,
    editIntent: { locked: false, query: { data } } as ReturnType<typeof useGraphEditIntent>,
  }), { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
  const returnedRun = { ...currentWorkflowFixture().run, workspaceId: 'workspace', workflowId: 'workflow',
    workflowVersionId: displayed.baseWorkflowVersionId! }
  const start = vi.spyOn(boardStartClient, 'start').mockResolvedValue({ accepted: true, replayed: false, run: returnedRun })
  return { ...hook, core, client, selectRun, start, facts, stopAndSave, returnedRun,
    selectAnotherRun: () => { selection++ },
    saved: () => {
      const current = useGraphDraftStore.getState().nextDrafts[key]!
      const intent = savedJournal(journalIntent(journalRequest(current, 'save-and-run'), current.context))
      const draft = { ...current.context.draft, revision: intent.result!.revision, publishedRevision: intent.result!.revision,
        baseWorkflowVersionId: intent.result!.currentVersionId, graph: intent.result!.version.definition }
      useGraphDraftStore.getState().updateNextDraft(key, edit => ({ ...edit, graph: draft.graph,
        context: { ...edit.context, draft, savedDraft: draft } }))
      facts.workflow = { ...facts.workflow, revision: draft.revision, currentVersionId: draft.baseWorkflowVersionId,
        workflow: draft.graph }
      facts.version = intent.result!.version
      data = { ...data, intent }
      return intent
    },
    waitForSave: () => {
      const current = useGraphDraftStore.getState().nextDrafts[key]!
      data = { ...data, intent: { ...journalIntent(journalRequest(current, 'save-and-run'), current.context), state: 'waiting' } }
    },
  }
}

async function showRuns(h: ReturnType<typeof setup>) {
  let admitted = false
  const reads: string[] = []
  server.use(http.get('*/api/management/workspaces/workspace/runs', ({ request }) => {
    const workflowId = new URL(request.url).searchParams.get('workflowId')!
    reads.push(workflowId)
    return HttpResponse.json({ items: admitted && workflowId === 'workflow' ? [h.returnedRun] : [],
      pageInfo: { nextCursor: null } })
  }))
  render(<QueryClientProvider client={h.client}>
    {['workflow', 'unrelated-workflow'].map(workflowId => <section key={workflowId} aria-label={workflowId}>
      <WorkflowBoardContext.Provider value={{ workspaceId: 'workspace', workflowId, inspection: {}, activeRuns: 0,
        selectRun: h.selectRun, selectInspection: vi.fn(), openLocation: vi.fn(), openRuns: vi.fn() }}>
        <RunActivityPanel summaries={[]} />
      </WorkflowBoardContext.Provider>
    </section>)}
  </QueryClientProvider>)
  await waitFor(() => {
    expect(reads).toContain('workflow')
    expect(reads).toContain('unrelated-workflow')
    for (const workflowId of ['workflow', 'unrelated-workflow']) {
      expect(h.client.getQueryState(boardRunListKey('workspace', workflowId))?.fetchStatus).toBe('idle')
    }
  })
  const before = [...reads]
  return {
    admit: () => { admitted = true },
    assertRefreshed: async () => {
      const list = within(screen.getByRole('region', { name: 'workflow' }))
      expect(await list.findByRole('button', { name: `Open Run ${h.returnedRun.id} · queued · pending` })).toBeVisible()
      expect(reads.filter(id => id === 'workflow')).toHaveLength(before.filter(id => id === 'workflow').length + 1)
      expect(reads.filter(id => id === 'unrelated-workflow')).toHaveLength(before.filter(id => id === 'unrelated-workflow').length)
    },
  }
}

it('continues an explicit Save and run once the same waiting intent is authoritatively saved', async () => {
  const h = setup()
  h.waitForSave()
  await act(async () => { await h.result.current.startMutation.mutateAsync({ saveFirst: true, allowStop: true }) })
  expect(h.start).not.toHaveBeenCalled()
  act(() => { h.saved(); h.rerender() })
  await waitFor(() => expect(h.start).toHaveBeenCalledOnce())
  expect(h.start.mock.calls[0]![0].workflowVersionId).toBe('version-2')
  await waitFor(() => expect(readBoardStart(key)).toBeUndefined())
  act(() => h.rerender())
  expect(h.start).toHaveBeenCalledOnce()
})

it.each(['selection', 'permission', 'session'] as const)('cancels a waiting Save and run when %s changes', async reason => {
  const h = setup()
  h.waitForSave()
  await act(async () => { await h.result.current.startMutation.mutateAsync({ saveFirst: true, allowStop: true }) })
  if (reason === 'selection') h.selectAnotherRun()
  else if (reason === 'permission') access(false)
  else { beginSessionChange(); finishSessionChange() }
  await act(async () => { h.saved(); h.rerender() })
  await waitFor(() => expect(h.core.runAfterSave.current).toBe(false))
  expect(h.start).not.toHaveBeenCalled()
})

it('acknowledges a delayed Start and refreshes Runs without replacing a newer Activities selection', async () => {
  const h = setup()
  const reply = deferred<Awaited<ReturnType<typeof boardStartClient.start>>>()
  h.start.mockReturnValue(reply.promise)
  const runs = await showRuns(h)
  let pending!: Promise<unknown>
  act(() => { pending = h.result.current.start() })
  await waitFor(() => expect(h.start).toHaveBeenCalledOnce())
  h.selectAnotherRun()
  runs.admit()
  await act(async () => {
    reply.resolve({ accepted: true, replayed: false, run: h.returnedRun })
    await pending
  })
  expect(h.selectRun).not.toHaveBeenCalled()
  expect(readBoardStart(key)).toBeUndefined()
  await runs.assertRefreshed()
})

it('still selects the admitted Run when selection is unchanged', async () => {
  const h = setup()
  await act(async () => { await h.result.current.start() })
  expect(h.selectRun).toHaveBeenCalledOnce()
  expect(readBoardStart(key)).toBeUndefined()
})

it('rechecks revoked Start permission before reserving or sending a command', async () => {
  const h = setup()
  access(false)
  await act(async () => {
    await expect(h.result.current.start()).rejects.toThrow('Start permission is unavailable')
  })
  expect(h.start).not.toHaveBeenCalled()
  expect(h.selectRun).not.toHaveBeenCalled()
  expect(readBoardStart(key)).toBeUndefined()
})

it('keeps plain Save-only publication from implicitly starting a Run', () => {
  const h = setup()
  h.waitForSave()
  act(() => { h.saved(); h.rerender() })
  expect(h.start).not.toHaveBeenCalled()
})


it('acknowledges delayed Start recovery without replacing a later Activities selection', async () => {
  const h = setup()
  h.start.mockRejectedValueOnce(new Error('Start reply was lost'))
  await act(async () => { await expect(h.result.current.start()).rejects.toThrow('Start reply was lost') })
  expect(readBoardStart(key)).toBeDefined()
  const reply = deferred<Awaited<ReturnType<typeof boardStartClient.resolve>>>()
  const resolve = vi.spyOn(boardStartClient, 'resolve').mockReturnValue(reply.promise)
  const runs = await showRuns(h)
  let pending!: Promise<unknown>
  act(() => { pending = h.result.current.recoverStart() })
  await waitFor(() => expect(resolve).toHaveBeenCalledOnce())
  h.selectAnotherRun()
  runs.admit()
  await act(async () => {
    reply.resolve({ status: 'accepted', run: h.returnedRun })
    await pending
  })
  expect(h.selectRun).not.toHaveBeenCalled()
  expect(readBoardStart(key)).toBeUndefined()
  await runs.assertRefreshed()
  expect(h.start).toHaveBeenCalledOnce()
})
