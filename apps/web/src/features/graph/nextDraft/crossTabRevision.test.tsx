import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
import { journalRequest, journalIntent, savedJournal } from './nim2644Journal.fixture'
import { boardStartClient } from '../../workflow-board/startClient'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createStore } from 'zustand/vanilla'
import { CURRENT_WORKFLOW_CAPABILITIES, GraphEditReadResultV3Schema,
  type GraphEditReadResultV3, type GraphEditStageInputV3 } from '@foreman-code/contracts/wave25'
import { ApiError } from '../../../shared/api/client'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { queryKeys } from '../../../shared/api/query'
import { useGraphDraftStore } from '../store'
import { NextDraftEditor } from './NextDraftEditor'
import { acknowledgeEditIntentSnapshot } from './useGraphEditIntent'
import { acknowledgeEditOutbox, readEditOutbox, reserveEditOutbox, storeEditSnapshot, type EditIntentOutbox } from './editIntentStorage'
import { newNextDraft, nextDraftKey, type NextDraftEdit } from './state'
import { nextDraftApi } from './transport'
import { repairFixture } from './nim2644State.cases'

// Mounted Query/Zustand transport regression. It models two browser tabs with
// separate Zustand stores/session snapshot IDs and shared protected localStorage.
// It is not authenticated HTTP, PostgreSQL, native Run, or browser-provider evidence.
vi.mock('../../workflow-board/context', () => ({ useWorkflowBoard: () => ({ activeRuns: 1 }) }))
vi.mock('../../../shared/api/settingsExperience', () => ({ useLocalHumanAccessQuery: () => ({ data: {
  principal: { expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['runs:start'], scope: {} }] },
} }) }))
vi.mock('../../workflow-board/startPreflight', async (original) => ({
  ...await original<typeof import('../../workflow-board/startPreflight')>(),
  useBoardStartPreflight: (draft: ReturnType<typeof repairFixture>['draft']) => ({ data: {
    workflow: { workflow: draft.graph, revision: draft.revision, currentVersionId: draft.baseWorkflowVersionId },
    workspace: { locationRevision: 1, locationValidation: { status: 'ready' } },
    capabilities: { ...CURRENT_WORKFLOW_CAPABILITIES, runtimeAdmission: true, persistedReadback: true },
    version: { id: draft.baseWorkflowVersionId, definition: draft.graph,
      agentConfigurationVersionIds: Object.fromEntries(draft.graph.nodes.map(nativeNode).map(({ agentId }) => [agentId, `configuration-${agentId}`])) },
  } }),
}))
vi.mock('./DraftCanvas', () => ({ DraftCanvas: () => <div>Canvas fixture</div> }))
vi.mock('../../../shared/api/query', async (original) => {
  const { DEFAULT_HARNESS_DEFAULTS } = await import('@foreman-code/contracts')
  return { ...await original<typeof import('../../../shared/api/query')>(),
    useInteractionsQuery: () => ({ data: { items: [] } }),
    useAgentDefaultsQuery: () => ({ isError: false, data: { value: {
      coder: { harness: DEFAULT_HARNESS_DEFAULTS.codex }, orchestrator: { harness: DEFAULT_HARNESS_DEFAULTS.codex },
    } } }),
  }
})

const key = nextDraftKey('workspace', 'workflow')
const tabKey = protectedKey('ui', 'graph-edit-intent:tab')
const now = '2026-09-24T00:00:00Z'
const clients: QueryClient[] = []
const edit = () => useGraphDraftStore.getState().nextDrafts[key]!
const saveButton = () => screen.getByRole('button', { name: /^Save workflow$/ })
async function saveWithStop(user: ReturnType<typeof userEvent.setup>) {
  await user.click(saveButton())
  const dialog = await screen.findByRole('alertdialog', { name: 'Stop running work and save?' })
  expect(nextDraftApi.editAdvance).not.toHaveBeenCalled()
  expect(dialog).toHaveTextContent('1 affected Run requires Stop or cleanup across 1 workflow.')
  expect(readEditOutbox(key)?.request).toEqual(vi.mocked(nextDraftApi.editStage).mock.calls.at(-1)![0])
  await user.click(within(dialog).getByRole('button', { name: 'Stop runs and save' }))
}


function inTab<T>(id: string, work: () => T): T {
  const previous = sessionStorage.getItem(tabKey)
  sessionStorage.setItem(tabKey, id)
  try { return work() }
  finally { if (previous === null) sessionStorage.removeItem(tabKey); else sessionStorage.setItem(tabKey, previous) }
}
function baseContext() {
  const context = repairFixture(1)
  context.draft.revision = 10
  context.draft.publishedRevision = 10
  context.draft.baseWorkflowVersionId = 'version-5'
  context.draft.graph.version = 5
  return context
}
function mark(current: NextDraftEdit, value: string): NextDraftEdit {
  return { ...current, graph: { ...current.graph, nodes: current.graph.nodes.map((node, index) => index ? node : { ...node, initialPrompt: value }) } }
}
function outbox(current: NextDraftEdit, commandId: string): EditIntentOutbox {
  return { request: journalRequest(current, commandId), target: current.graph,
    ...(current.agentEdits ? { agentTarget: current.agentEdits } : {}) }
}
function savedRead(current: NextDraftEdit, submitted: EditIntentOutbox): GraphEditReadResultV3 {
  return GraphEditReadResultV3Schema.parse({ intent: savedJournal(journalIntent(submitted.request, current.context), 6),
    current: [], canStop: false, affectedSetChanged: false })
}

function stagedRead(request: GraphEditStageInputV3): GraphEditReadResultV3 {
  const retained = readEditOutbox(key)!
  const context = edit().context
  expect(retained.request).toEqual(request)
  const pin = { workspaceId: request.workspaceId, workflowId: request.workflowId, runId: 'run-correction',
    workflowVersionId: context.draft.baseWorkflowVersionId!, executionSemanticsVersion: 3 as const,
    agentConfigurationVersionIds: { 'agent-0': 'configuration-agent-0' } }
  const intent = journalIntent(request, context, [pin])
  return GraphEditReadResultV3Schema.parse({ intent, canStop: true, affectedSetChanged: false,
    current: [{ pin, terminal: false, settled: false, outcome: 'pending', cleanupPending: false,
      nativePending: true, interactionPending: false, reviewPending: false }] })
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  client.setQueryData(queryKeys.managedWorkspace('workspace'), { workspace: { id: 'workspace', name: 'Fixture' },
    locationRevision: 1, locationValidation: { status: 'ready', checkedAt: now } })
  return render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
}

beforeEach(() => {
  useGraphDraftStore.getState().clearAllDrafts(); localStorage.clear(); sessionStorage.clear()
  sessionStorage.setItem(tabKey, 'B')
  vi.stubGlobal('navigator', { ...navigator, locks: { request: async (_name: string, work: (() => Promise<unknown>) | LockOptions, claim?: (lock: { name: string }) => unknown) => typeof work === 'function' ? work() : claim!({ name: _name }) } })
  vi.spyOn(nextDraftApi, 'pins').mockImplementation(async (_workspaceId, graph, _stagedAgents, agents) => ({
    expectedAgentConfigurationVersionIds: Object.fromEntries(graph.nodes.map(nativeNode).flatMap(({ agentId }) => {
      const pin = agents?.find((item) => item.agent.id === agentId)?.agent.configurationVersionId
      return pin ? [[agentId, pin]] : []
    })), agents: agents ?? [],
  }))
  vi.spyOn(boardStartClient, 'start').mockRejectedValue(new Error('This regression must not Start a Run'))
})
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear())
  useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})

describe('NIM-2644 typed-board cross-tab stale revision fence', () => {
  it('A save cannot move B unsent meaning to the new revision; B conflicts before Stop until explicit reload', async () => {
    const base = baseContext()
    useGraphDraftStore.getState().installNextDraft(key, structuredClone(base), true)
    act(() => useGraphDraftStore.getState().updateNextDraft(key, (current) => mark(current, 'marker B')))
    inTab('B', () => storeEditSnapshot(key, edit()))

    const aStore = createStore<{ edit: NextDraftEdit }>(() => ({ edit: mark(newNextDraft(structuredClone(base), 'tab-A'), 'marker A') }))
    const a = aStore.getState().edit, aBox = outbox(a, 'stage-A-1')
    inTab('A', () => { storeEditSnapshot(key, a); reserveEditOutbox(key, aBox) })
    const savedA = savedRead(a, aBox)
    inTab('A', () => acknowledgeEditOutbox(key, aBox.request.commandId))

    vi.spyOn(nextDraftApi, 'context').mockResolvedValue({ draft: { ...base.draft, graph: savedA.intent!.result!.version.definition, revision: 11, publishedRevision: 11, baseWorkflowVersionId: 'version-6' }, agents: base.agents })
    vi.spyOn(nextDraftApi, 'editRead').mockResolvedValue(savedA)
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (request) => {
      if (request.expectedRevision === 10) throw new ApiError({ code: 'REVISION_CONFLICT', message: 'Draft is now revision 11' }, 409)
      return stagedRead(request)
    })
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => {
      const value = stagedRead(stage.mock.calls.at(-1)![0])
      return { ...value, intent: { ...value.intent!, state: 'waiting' } }
    })

    const user = userEvent.setup(); mount()
    await screen.findByRole('region', { name: 'Workflow authoring' })
    await waitFor(() => expect(nextDraftApi.editRead).toHaveBeenCalled())
    await waitFor(() => expect(clients[0]!.isFetching()).toBe(0))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(edit().context.draft.revision).toBe(10)
    expect(nativeNode(edit().graph.nodes[0])?.initialPrompt).toBe('marker B')

    // A stale Stage rejects before any affected-set confirmation or Stop.
    await user.click(saveButton())
    await waitFor(() => expect(stage).toHaveBeenCalledOnce())
    await screen.findByText('The workflow changed.')
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(stage.mock.calls[0]![0].expectedRevision).toBe(10)
    expect(advance).not.toHaveBeenCalled()
    expect(readEditOutbox(key)).toBeUndefined()
    expect(edit().context.draft.revision).toBe(10)
    expect(edit().context.draft.baseWorkflowVersionId).toBe('version-5')
    expect(nativeNode(edit().graph.nodes[0])?.initialPrompt).toBe('marker B')
    expect(savedA.intent?.result?.version.id).toBe('version-6')
    expect(boardStartClient.start).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Workflow settings' }))
    await user.click(screen.getByRole('button', { name: 'Reload saved draft' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Reload saved draft' }))
    await waitFor(() => expect(edit().context.draft.revision).toBe(11))
    expect(edit().context.draft.baseWorkflowVersionId).toBe('version-6')
    expect(nativeNode(edit().graph.nodes[0])?.initialPrompt).toBe('marker A')

    act(() => useGraphDraftStore.getState().updateNextDraft(key, (current) => mark(current, 'marker B corrected')))
    await saveWithStop(user)
    // Rejected stale Stage, corrected Stage, exact confirmation replay.
    await waitFor(() => expect(stage).toHaveBeenCalledTimes(3))
    expect(stage.mock.calls[2]![0]).toEqual(stage.mock.calls[1]![0])
    expect(stage.mock.calls[1]![0].commandId).not.toBe(stage.mock.calls[0]![0].commandId)
    expect(stage.mock.calls[1]![0].expectedRevision).toBe(11)
    await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    expect(boardStartClient.start).not.toHaveBeenCalled()
  })

  it('same-form single-tab lineage can acknowledge once, keep newer typing, and replay idempotently', () => {
    const base = baseContext()
    const first = mark(newNextDraft(base, 'single-tab'), 'marker A')
    const box = outbox(first, 'stage-single')
    inTab('single', () => {
      storeEditSnapshot(key, first)
      reserveEditOutbox(key, box)
      const saved = savedRead(first, box)
      const newer = mark(first, 'marker A newer')
      storeEditSnapshot(key, newer)
      const acknowledged = acknowledgeEditIntentSnapshot(key, newer, saved.intent!)
      expect(acknowledged.context.draft.revision).toBe(11)
      expect(acknowledged.context.draft.baseWorkflowVersionId).toBe('version-6')
      expect(nativeNode(acknowledged.graph.nodes[0])?.initialPrompt).toBe('marker A newer')
      const replay = acknowledgeEditIntentSnapshot(key, acknowledged, saved.intent!)
      expect(replay).toBe(acknowledged)
      acknowledgeEditOutbox(key, box.request.commandId)
      expect(readEditOutbox(key)).toBeUndefined()
    })
  })
})
