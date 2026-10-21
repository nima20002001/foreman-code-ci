import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
import { HarnessConfigurationSchema } from '@foreman-code/contracts'
import { journalIntent, savedJournal } from './nim2644Journal.fixture'
import { boardStartClient } from '../../workflow-board/startClient'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createStore } from 'zustand/vanilla'
import { ManagedWorkspaceSchema, type ManagedWorkspace } from '@foreman-code/contracts/management'
import { CURRENT_WORKFLOW_CAPABILITIES, GraphEditReadResultV3Schema, sameExecutableWorkflow,
  type GraphEditReadResultV3, type GraphEditStageInputV3 } from '@foreman-code/contracts/wave25'
import { ApiError } from '../../../shared/api/client'
import { queryKeys } from '../../../shared/api/query'
import { useGraphDraftStore } from '../store'
import { NextDraftEditor } from './NextDraftEditor'
import { nextDraftApi } from './transport'
import { nextDraftDirty, nextDraftKey } from './state'
import { changeDraftAgent, editorAgents } from './agentEdits'
import { defaultAgentForHarness } from '../../agents/agentSettings'
import { attachAgent, removeNode } from './model'
import { acknowledgeEditOutbox, readEditOutbox, readEditSnapshot, storeEditSnapshot } from './editIntentStorage'
import { acknowledgeEditIntentSnapshot } from './useGraphEditIntent'
import { inFollowupTab } from './nim2644Followup.cases'
import { repairFixture } from './nim2644State.cases'
import { bindMockInstallation } from '../../../shared/mocks/handlers'

async function confirmDiscard(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /^Discard changes$/ }))
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }))
}
async function reloadSavedDraft(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Reload saved draft' }))
  const dialog = screen.queryByRole('alertdialog')
  if (dialog) await user.click(within(dialog).getByRole('button', { name: 'Reload saved draft' }))
}

// Mounted Query/Zustand/form regressions with the existing transport boundary
// mocked. Not authenticated HTTP/MCP, a real browser/canvas, or native Stop evidence.
vi.mock('../../workflow-board/context', () => ({ useWorkflowBoard: () => ({ activeRuns: 1 }) }))
vi.mock('../../../shared/api/settingsExperience', () => ({ useLocalHumanAccessQuery: () => ({ data: {
  principal: { expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['runs:start'], scope: {} }] },
} }) }))
vi.mock('../../workflow-board/startPreflight', async (original) => ({
  ...await original<typeof import('../../workflow-board/startPreflight')>(),
  useBoardStartPreflight: (draft: ReturnType<typeof repairFixture>['draft']) => ({ data: {
    workflow: { workflow: draft.graph, revision: draft.revision, currentVersionId: draft.baseWorkflowVersionId },
    workspace: startWorkspace,
    capabilities: { ...CURRENT_WORKFLOW_CAPABILITIES, runtimeAdmission: true, persistedReadback: true },
    version: { id: draft.baseWorkflowVersionId, definition: draft.graph,
      agentConfigurationVersionIds: Object.fromEntries(draft.graph.nodes.map(nativeNode).map(({ agentId }) => [agentId, `configuration-${agentId}`])) },
  } }),
}))
vi.mock('./DraftCanvas', () => ({ DraftCanvas: ({ open, panels }: { open?: { nodeId: string; panel: 'chat' | 'settings' | 'info' }; panels?: (nodeId: string) => Record<string, unknown> }) => <div>Canvas fixture{open && panels
  ? <section role="dialog" aria-label={`${open.nodeId} ${open.panel}`}>{panels(open.nodeId)[open.panel] as never}</section> : null}</div> }))
vi.mock('../../../shared/api/query', async (original) => {
  const { DEFAULT_HARNESS_DEFAULTS } = await import('@foreman-code/contracts')
  return { ...await original<typeof import('../../../shared/api/query')>(),
    useInteractionsQuery: () => ({ data: { items: [] } }),
    useAgentDefaultsQuery: () => ({ isError: false, data: { value: {
      coder: { harness: DEFAULT_HARNESS_DEFAULTS.codex }, orchestrator: { harness: DEFAULT_HARNESS_DEFAULTS.codex },
    } } }),
  }
})
const key = nextDraftKey('workspace', 'workflow'), clients: QueryClient[] = []
const empty: GraphEditReadResultV3 = { intent: null, current: [], canStop: false, affectedSetChanged: false }
const now = '2026-09-24T00:00:00Z'
let startWorkspace: ManagedWorkspace
const edit = () => useGraphDraftStore.getState().nextDrafts[key]!
const saveButton = () => screen.getByRole('button', { name: /^Save workflow$/ })
const recoveryName = /^(?:Stop affected Runs and save|Reconcile Save)$/
async function retainedSaveReady() {
  await waitFor(() => {
    // A pending journal is reconciled; ordinary Save is not offered and cannot create a new command.
    expect(screen.queryByRole('button', { name: /^Save workflow$/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: recoveryName })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^Discard changes$/ })).toBeEnabled()
  })
}
async function requestSave(user: ReturnType<typeof userEvent.setup>) {
  const button = screen.queryByRole('button', { name: recoveryName }) ?? saveButton()
  await waitFor(() => expect(button).toBeEnabled())
  await user.click(button)
}
async function saveWithStop(user: ReturnType<typeof userEvent.setup>) {
  const stage = vi.mocked(nextDraftApi.editStage), advance = vi.mocked(nextDraftApi.editAdvance)
  const beforeStage = stage.mock.calls.length, beforeAdvance = advance.mock.calls.length
  await requestSave(user)
  // Stage/readback discovers blockers BEFORE the destructive choice. Neither
  // a rejected Stage nor a terminal saved receipt should open this dialog.
  const dialog = await screen.findByRole('alertdialog', { name: 'Stop running work and save?' })
  expect(stage).toHaveBeenCalledTimes(beforeStage + 1)
  expect(advance).toHaveBeenCalledTimes(beforeAdvance)
  expect(dialog).toHaveTextContent('1 affected Run requires Stop or cleanup across 1 workflow.')
  expect(startButton()).toBeDisabled()
  expect(nextDraftDirty(edit())).toBe(true)
  const request = readEditOutbox(key)!.request
  expect(stage.mock.calls.at(-1)![0]).toEqual(request)
  await user.click(within(dialog).getByRole('button', { name: 'Stop runs and save' }))
  // Confirmation replays the SAME Stage to recheck affected-set/permission
  // fences. An extra transport read is not another edit intent or Stop.
  await waitFor(() => expect(stage).toHaveBeenCalledTimes(beforeStage + 2))
  expect(stage.mock.calls.at(-1)![0]).toEqual(request)
}

// Unsaved edits relabel the one Run control "Save and run".
const startButton = () => screen.getByRole('button', { name: /^(Start saved version|Save and run)$/ })
/** Only a clean board offers the saved version itself; waiting on it proves reconciliation finished. */
const savedStartButton = () => screen.getByRole('button', { name: 'Start saved version' })
/** Retained edits never start the stale saved version: Run first saves them. */
function expectNoSavedStart() {
  expect(screen.queryByRole('button', { name: 'Start saved version' })).not.toBeInTheDocument()
  expect(startButton()).toHaveAccessibleName('Save and run')
}
function mount(initialContext?: ReturnType<typeof repairFixture>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  client.setQueryData(queryKeys.managedWorkspace('workspace'), startWorkspace)
  return render(<QueryClientProvider client={client}><NextDraftEditor workspaceId="workspace" workflowId="workflow"
    initialContext={initialContext} /></QueryClientProvider>)
}
function typeMeaning(value = 'submitted instruction') {
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node, index) => index ? node : { ...node, initialPrompt: value }),
  })))
}
function moveSurvivor() {
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node) => node.id !== 'node-0' ? node : { ...node, position: { x: 934, y: -28 } }),
  })))
}
function reopen(first: ReturnType<typeof mount>) {
  first.unmount()
  // Lose form memory, not the principal's durable protected storage.
  act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
  return mount()
}
function stageValue(request: GraphEditStageInputV3): GraphEditReadResultV3 {
  const retained = readEditOutbox(key)!, context = edit().context
  expect(retained.request).toEqual(request)
  const pin = { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run-fixture',
    workflowVersionId: 'version-1', executionSemanticsVersion: 3 as const,
    agentConfigurationVersionIds: { 'agent-0': 'configuration-agent-0' } }
  const intent = journalIntent(request, context, [pin])
  return GraphEditReadResultV3Schema.parse({ intent, canStop: true, affectedSetChanged: false,
    current: [{ pin, terminal: false, settled: false, outcome: 'pending', cleanupPending: false,
      nativePending: true, interactionPending: false, reviewPending: false }] })
}
function published(value: GraphEditReadResultV3): GraphEditReadResultV3 {
  return GraphEditReadResultV3Schema.parse({ ...value,
    current: value.current.map((item) => ({ ...item, terminal: true, settled: true, outcome: 'canceled', nativePending: false })),
    intent: savedJournal(value.intent!) })
}

function waiting(value: GraphEditReadResultV3): GraphEditReadResultV3 {
  return { ...value, intent: { ...value.intent!, state: 'waiting' } }
}
/** A Worker created locally and not yet saved, the way the editor stages one: the Board panel only adds saved Agents. */
function createWorker() {
  const agent = defaultAgentForHarness('codex', `agent-${crypto.randomUUID()}`, 'Worker 2', undefined, 'coder')
  act(() => useGraphDraftStore.getState().updateNextDraft(key, (current) => {
    const agentForms = { ...current.agentForms }
    return changeDraftAgent({ ...current, agentForms }, agent, { ...current.graph,
      nodes: [...current.graph.nodes, { id: `node-${crypto.randomUUID()}`, agentId: agent.id, name: agent.name }] })
  }))
  const node = edit().graph.nodes.map(nativeNode).find((item) => nativeNode(item).agentId !== 'agent-0')!
  expect(edit().agentEdits?.[nativeNode(node).agentId]?.configurationVersionId).toBeUndefined()
  expect(edit().agentEdits?.[nativeNode(node).agentId]?.prompt).toBeUndefined()
  expect(edit().agentEdits?.[nativeNode(node).agentId]?.assignedSkills).toBeUndefined()
  return node
}
beforeEach(() => {
  startWorkspace = ManagedWorkspaceSchema.parse({
    workspace: { id: 'workspace', name: 'Fixture' },
    revision: 1,
    archivedAt: null,
    executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' },
    locationRevision: 1,
    locationValidation: { status: 'ready', checkedAt: now },
  })
  useGraphDraftStore.getState().clearAllDrafts(); localStorage.clear(); bindMockInstallation(); sessionStorage.clear()
  useGraphDraftStore.getState().installNextDraft(key, repairFixture(1))
  vi.stubGlobal('navigator', { ...navigator, locks: { request: async (_name: string, work: (() => Promise<unknown>) | LockOptions, claim?: (lock: { name: string }) => unknown) => typeof work === 'function' ? work() : claim!({ name: _name }) } })
  vi.spyOn(nextDraftApi, 'context').mockResolvedValue(repairFixture(1))
  vi.spyOn(nextDraftApi, 'editRead').mockResolvedValue(empty)
  vi.spyOn(nextDraftApi, 'pins').mockImplementation(async (_workspaceId, graph, _stagedAgents, agents) => ({
    expectedAgentConfigurationVersionIds: Object.fromEntries(graph.nodes.map(nativeNode).flatMap(({ agentId }) => {
      const pin = agents?.find((item) => item.agent.id === agentId)?.agent.configurationVersionId
      return pin ? [[agentId, pin]] : []
    })), agents: agents ?? [],
  }))
  vi.spyOn(boardStartClient, 'start').mockRejectedValue(new Error('These regressions must not start a Run'))
})
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear())
  useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('NIM-2644 mounted frontend recovery through the real edit-intent hook', () => {
  it('unlocks a rejected Agent branch prefix and restores the saved draft on Discard and reload', async () => {
    // Freeze the clock and polling; query notifications settle through the UI.
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
    const startedAt = Date.now()
    const openSettings = async () => {
      const navigation = await screen.findByLabelText('Agents and connections')
      fireEvent.click(within(navigation).getByRole('button', { name: 'Entry · Node 0' }))
      return within(await screen.findByLabelText('node-0 settings'))
    }
    const actions = () => within(screen.getByLabelText('Draft actions'))
    const save = () => actions().getByRole('button', { name: 'Save workflow' })
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockRejectedValue(new ApiError({
      code: 'WORKTREE_BINDING_REQUIRED', message: 'Select an approved root for this Agent branch prefix.',
    }, 409))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance')
    const discard = vi.spyOn(nextDraftApi, 'editDiscard')
    let view = mount()
    const saved = structuredClone(edit().graph)
    const settings = await openSettings()
    const branchPrefix = await settings.findByLabelText('Agent branch prefix')
    expect(branchPrefix).toHaveRole('textbox')
    fireEvent.change(branchPrefix, { target: { value: 'foreman/journey-worker' } })
    const apply = settings.getByLabelText('Apply agent settings to draft')
    expect(apply).toHaveRole('button')
    fireEvent.click(apply)
    await waitFor(() => expect(save()).toBeEnabled())
    fireEvent.click(save())
    expect(await screen.findAllByText('Select an approved root for this Agent branch prefix.')).not.toHaveLength(0)
    await waitFor(() => {
      expect(save()).toBeEnabled()
      expect(actions().getByRole('button', { name: 'Discard changes' })).toBeEnabled()
      expect(readEditOutbox(key)).toBeUndefined()
    })
    expect(nativeNode(edit().graph.nodes[0]).worktree?.branchPrefix).toBe('foreman/journey-worker')
    expect(screen.queryByRole('button', { name: 'Reconcile Save' })).not.toBeInTheDocument()

    view = reopen(view)
    expect(await screen.findByLabelText('Workflow authoring')).toHaveRole('region')
    const retainedSettings = await openSettings()
    const retainedPrefix = await retainedSettings.findByLabelText('Agent branch prefix')
    expect(retainedPrefix).toHaveValue('foreman/journey-worker')
    expect(retainedPrefix).toBeEnabled()
    expect(retainedSettings.getByRole('button', { name: 'Use workflow default' })).toBeEnabled()
    fireEvent.click(actions().getByRole('button', { name: 'Discard changes' }))
    const confirmation = await screen.findByRole('alertdialog', { name: 'Discard your changes?' })
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Discard changes' }))
    await waitFor(() => expect(within(screen.getByLabelText('Workflow controls'))
      .getByRole('button', { name: 'Start saved version' })).toBeEnabled())
    expect(nextDraftDirty(edit())).toBe(false)
    expect(edit().graph).toEqual(saved)
    expect(readEditSnapshot(key)?.graph).toEqual(saved)

    reopen(view)
    expect(await screen.findByLabelText('Workflow authoring')).toHaveRole('region')
    const restoredSettings = await openSettings()
    const restoredPrefix = await restoredSettings.findByLabelText('Agent branch prefix')
    expect(restoredPrefix).toHaveValue('')
    expect(restoredPrefix).toBeEnabled()
    expect(edit().graph).toEqual(saved)
    expect(stage).toHaveBeenCalledOnce()
    expect(advance).not.toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()
    expect(boardStartClient.start).not.toHaveBeenCalled()
    expect(Date.now()).toBe(startedAt)
  })

  it('keeps Start blocked for a saved workflow with a retired Agent while preserving its facts', async () => {
    const context = repairFixture(1)
    const agent = context.agents[0]!.agent
    agent.harness = 'opencode'
    agent.harnessConfiguration = HarnessConfigurationSchema.parse({
      harness: 'opencode', model: 'provider/historical-model', variant: 'saved-variant',
      nativeAgent: 'saved-agent', thinking: true, autoApprove: false,
    })
    const original = structuredClone(context)
    useGraphDraftStore.getState().installNextDraft(key, context, true)
    mount()
    await screen.findByRole('region', { name: 'Workflow authoring' })
    expect(savedStartButton()).toBeDisabled()
    expect(savedStartButton()).toHaveAttribute('title', 'Retired harness (OpenCode): read-only')
    await userEvent.click(savedStartButton())
    expect(boardStartClient.start).not.toHaveBeenCalled()
    expect(edit().context).toEqual(original)
  })

  it('keeps Start blocked when a ready workspace has no execution location', async () => {
    startWorkspace.executionLocation = null
    mount()
    await screen.findByRole('region', { name: 'Workflow authoring' })
    expect(nextDraftDirty(edit())).toBe(false)
    expect(savedStartButton()).toBeDisabled()
    expect(savedStartButton()).toHaveAttribute('title', 'The workspace, workflow or execution folder is unavailable.')
    expect(boardStartClient.start).not.toHaveBeenCalled()
  })

  it('reloads a clean retained form with remote node names without a new executable version', async () => {
    const first = mount()
    const original = structuredClone(edit().context)
    await waitFor(() => expect(readEditSnapshot(key)?.graph).toEqual(original.draft.graph))
    first.unmount()
    act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
    const fresh = { ...original, draft: { ...original.draft, graph: { ...original.draft.graph,
      nodes: original.draft.graph.nodes.map((node) => ({ ...node, name: 'Remote saved name' })) } } }
    vi.mocked(nextDraftApi.context).mockResolvedValue(fresh)
    mount()
    await screen.findByRole('region', { name: 'Workflow authoring' })
    expect(edit().graph.nodes[0]?.name).toBe('Remote saved name')
    expect(edit().context.draft.baseWorkflowVersionId).toBe(original.draft.baseWorkflowVersionId)
    expect(nextDraftDirty(edit())).toBe(false)
  })

  it('keeps an unsaved node name after reopening against a newly published Agent configuration', async () => {
    const stage = vi.spyOn(nextDraftApi, 'editStage')
    const first = mount()
    const original = structuredClone(edit().context)
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, name: 'Unsaved node name' })) })))
    await waitFor(() => expect(readEditSnapshot(key)?.graph.nodes[0]?.name).toBe('Unsaved node name'))
    first.unmount()
    act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
    const fresh = { ...original, draft: { ...original.draft, revision: 8, publishedRevision: 8,
      baseWorkflowVersionId: 'version-agent-change', graph: { ...original.draft.graph, version: 2 } },
    agents: original.agents.map((item) => ({ ...item, metadataRevision: item.metadataRevision + 1,
      agent: { ...item.agent, configurationVersionId: 'configuration-agent-change' } })) }
    mount(fresh)
    await screen.findByRole('region', { name: 'Workflow authoring' })
    expect(edit().graph.nodes[0]?.name).toBe('Unsaved node name')
    expect(edit().context.draft.baseWorkflowVersionId).toBe(original.draft.baseWorkflowVersionId)
    expect(nextDraftDirty(edit())).toBe(true)
    expect(stage).not.toHaveBeenCalled()
  })

  it('acknowledges a presentation-only Save without a Stop dialog or a new version', async () => {
    const user = userEvent.setup()
    mount()
    const original = structuredClone(edit().context)
    let staged = empty
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (request) => {
      const intent = journalIntent(request, original)
      staged = GraphEditReadResultV3Schema.parse({ ...empty, intent: { ...intent,
        stagedDraft: { ...intent.stagedDraft, presentationOnly: true } } })
      return staged
    })
    vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => {
      const graph = original.draft.graph
      return GraphEditReadResultV3Schema.parse({ ...staged, intent: { ...staged.intent!, state: 'saved',
        saveAttempted: true, result: { workspaceId: graph.workspaceId, workflowId: graph.id,
          revision: original.draft.revision, currentVersionId: original.draft.baseWorkflowVersionId,
          presentation: staged.intent!.stagedDraft.graph,
          version: { id: original.draft.baseWorkflowVersionId, workspaceId: graph.workspaceId,
            workflowId: graph.id, version: graph.version, executionSemanticsVersion: 3,
            definition: graph, entryNodeId: graph.entryNodeId, approval: graph.approval,
            agentConfigurationVersionIds: staged.intent!.stagedDraft.agentConfigurationVersionIds,
            contentHash: `sha256:${'1'.repeat(64)}`, createdAt: now } } } })
    })
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, name: 'Saved node name' })) })))
    await requestSave(user)
    await waitFor(() => expect(nextDraftDirty(edit())).toBe(false))
    expect(stage).toHaveBeenCalledOnce()
    expect(stage.mock.calls[0]?.[0].graph.nodes[0]?.name).toBe('Saved node name')
    expect(edit().graph.nodes[0]?.name).toBe('Saved node name')
    expect(edit().context.draft.baseWorkflowVersionId).toBe(original.draft.baseWorkflowVersionId)
    expect(edit().context.draft.publishedRevision).toBe(original.draft.publishedRevision)
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  })

  it('FE-001 retains a rejected form, unlocks it, and lets the next Discard finish without Stage replay or Stop', async () => {
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockRejectedValue(new ApiError({ code: 'REVISION_CONFLICT', message: 'Rejected before insert' }, 409))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance'), user = userEvent.setup()
    mount(); typeMeaning(); await requestSave(user)
    await waitFor(() => expect(stage).toHaveBeenCalledOnce())
    await waitFor(() => expect(screen.getByText(/The workflow changed/)).toBeInTheDocument())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(advance).not.toHaveBeenCalled()
    expect(readEditOutbox(key)).toBeUndefined(); expect(nativeNode(edit().graph.nodes[0])?.initialPrompt).toBe('submitted instruction')
    expect(nativeNode(readEditSnapshot(key)?.graph.nodes[0])?.initialPrompt).toBe('submitted instruction')
    expectNoSavedStart()
    await confirmDiscard(user)
    expect(nativeNode(edit().graph.nodes[0])?.initialPrompt).toBeUndefined()
    expect(stage).toHaveBeenCalledOnce(); expect(advance).not.toHaveBeenCalled(); expect(boardStartClient.start).not.toHaveBeenCalled()
    await waitFor(() => expect(savedStartButton()).toBeEnabled())
  })
  it('FE-001 reopens a safely rejected form and permits explicit reload/correction with a new Stage identity', async () => {
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockRejectedValueOnce(new ApiError({ code: 'REVISION_CONFLICT', message: 'Rejected before insert' }, 409))
      .mockImplementation(async (input) => stageValue(input))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => waiting(stageValue(stage.mock.calls.at(-1)![0])))
    const user = userEvent.setup(), first = mount(); typeMeaning(); await requestSave(user)
    await waitFor(() => expect(stage).toHaveBeenCalledOnce())
    await waitFor(() => expect(readEditOutbox(key)).toBeUndefined())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(advance).not.toHaveBeenCalled()
    reopen(first)
    await screen.findByRole('region', { name: 'Workflow authoring' })
    expect(nativeNode(edit().graph.nodes[0])?.initialPrompt).toBe('submitted instruction')
    const fresh = repairFixture(1); fresh.draft.revision = 8; fresh.draft.publishedRevision = 8
    vi.mocked(nextDraftApi.context).mockResolvedValue(fresh); vi.spyOn(window, 'confirm').mockReturnValue(true)
    await user.click(screen.getByRole('button', { name: 'Workflow settings' }))
    await reloadSavedDraft(user)
    await waitFor(() => expect(edit().context.draft.revision).toBe(8))
    typeMeaning('corrected'); await saveWithStop(user)
    await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    // Rejected attempt, corrected Stage, then exact Stage replay on confirmation.
    expect(stage).toHaveBeenCalledTimes(3)
    expect(stage.mock.calls[2]![0]).toEqual(stage.mock.calls[1]![0])
    expect(stage.mock.calls[1]![0].commandId).not.toBe(stage.mock.calls[0]![0].commandId)
    expect(stage.mock.calls[1]![0].expectedRevision).toBe(8)
    expect(boardStartClient.start).not.toHaveBeenCalled()
  })
  it.each([new Error('reply lost'), new ApiError({ code: 'INVALID_RESPONSE', message: 'bad reply' }),
    new ApiError({ code: 'FORBIDDEN', message: 'readback denied' }, 403), new ApiError({ code: 'INTERNAL_ERROR', message: 'post-commit failure' }, 500)])(
    'FE-001 preserves exact Stage identity across ambiguous response/reopen %#', async (error) => {
      let persisted = empty
      vi.mocked(nextDraftApi.editRead).mockImplementation(async () => persisted)
      const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => {
        if (!persisted.intent) { persisted = stageValue(input); throw error }
        return persisted
      })
      const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => (persisted = waiting(persisted)))
      const user = userEvent.setup(), first = mount(); typeMeaning(); await requestSave(user)
      await waitFor(() => expect(stage).toHaveBeenCalledOnce())
      await retainedSaveReady()
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
      expect(advance).not.toHaveBeenCalled()
      const request = stage.mock.calls[0]![0]
      expect(readEditOutbox(key)?.request).toEqual(request)
      reopen(first); await screen.findByRole('region', { name: 'Workflow authoring' })
      await saveWithStop(user); await waitFor(() => expect(advance).toHaveBeenCalledOnce())
      expect(stage.mock.calls.map(([input]) => input)).toEqual([request, request, request])
      expect(readEditOutbox(key)?.request).toEqual(request); expect(boardStartClient.start).not.toHaveBeenCalled()
    })
  it.each(['REVISION_CONFLICT', 'WORKTREE_BINDING_REQUIRED'])(
    'retains the staged reservation when Advance rejects with %s', async (code) => {
    let persisted = empty
    vi.mocked(nextDraftApi.editRead).mockImplementation(async () => persisted)
    vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => (persisted = stageValue(input)))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockRejectedValue(new ApiError({ code, message: 'After Stage' }, 409))
    const user = userEvent.setup(); mount(); typeMeaning(); await saveWithStop(user)
    await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    await retainedSaveReady()
    expect(readEditOutbox(key)?.request.commandId).toBe(persisted.intent?.stageCommandId)
    expect(startButton()).toBeDisabled(); expect(nativeNode(edit().graph.nodes[0])?.initialPrompt).toBe('submitted instruction')
  })
  it('FE-002/004 creates a Worker, replaces the sole entry, selects it explicitly, and acknowledges normalized Stop/save publication', async () => {
    let persisted = empty
    vi.mocked(nextDraftApi.editRead).mockImplementation(async () => persisted)
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => (persisted = stageValue(input)))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => (persisted = published(persisted)))
    const user = userEvent.setup(), first = mount(), node = createWorker()
    const rawWorker = structuredClone(edit().agentEdits![nativeNode(node).agentId]!)
    await user.click(screen.getByRole('button', { name: 'Entry · Node 0' }))
    await user.click(screen.getByRole('button', { name: /from workflow$/ }))
    expect(edit().graph.entryNodeId).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Workflow settings' }))
    const option = screen.getByRole('option', { name: /^Worker \d$/ })
    expect(option).toBeEnabled()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Starts the workflow' }), node.id)
    expect(edit().graph.entryNodeId).toBe(node.id); expectNoSavedStart()
    await saveWithStop(user); await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    await waitFor(() => expect(savedStartButton()).toBeEnabled())
    const request = stage.mock.calls[0]![0]
    expect(request.graph.entryNodeId).toBe(node.id)
    expect(request.graph.nodes.map((item) => item.id)).toEqual([node.id])
    // Stage carries the exact local Agent. Defaults appear only in saved readback.
    expect(rawWorker).toMatchObject({ id: nativeNode(node).agentId, productRole: 'coder' })
    expect(rawWorker.prompt).toBeUndefined(); expect(rawWorker.assignedSkills).toBeUndefined()
    expect(request.stagedAgents).toEqual([{ baseRevision: null, agent: rawWorker }])
    expect(persisted.intent!.stagedDraft.stagedAgents).toEqual(request.stagedAgents)
    expect(persisted.intent!.saveInput.stagedAgents).toEqual(request.stagedAgents)
    expect(request.expectedAgentConfigurationVersionIds).toEqual({})
    expect(advance.mock.calls[0]![0]).toMatchObject({ action: 'stop_and_save', commandId: persisted.intent!.advanceCommandId })
    expect(nextDraftDirty(edit())).toBe(false); expect(edit().agentEdits?.[nativeNode(node).agentId]).toBeUndefined()
    expect(editorAgents(edit()).find((agent) => agent.id === nativeNode(node).agentId)).toMatchObject({
      configurationVersionId: `saved-${nativeNode(node).agentId}`, prompt: {}, assignedSkills: [],
    })
    expect(readEditOutbox(key)).toBeUndefined(); expect(boardStartClient.start).not.toHaveBeenCalled()
    reopen(first); await screen.findByRole('region', { name: 'Workflow authoring' })
    await waitFor(() => expect(savedStartButton()).toBeEnabled())
    expect(nextDraftDirty(edit())).toBe(false); expect(edit().context.draft.baseWorkflowVersionId).toBe('version-2')
  })
  it('FE-002 a lost publication reply is acknowledged from readback using the retained raw new-Agent snapshot', async () => {
    let persisted = empty, visible = empty
    vi.mocked(nextDraftApi.editRead).mockImplementation(async () => visible)
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => (visible = persisted = stageValue(input)))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => { persisted = published(persisted); throw new Error('publication reply lost') })
    const user = userEvent.setup(), first = mount(), node = createWorker()
    await saveWithStop(user); await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    await retainedSaveReady()
    expect(readEditOutbox(key)?.agentTarget?.[nativeNode(node).agentId]?.prompt).toBeUndefined()
    expect(readEditOutbox(key)).toBeDefined()
    visible = persisted; reopen(first); await screen.findByRole('region', { name: 'Workflow authoring' })
    await waitFor(() => expect(readEditOutbox(key)).toBeUndefined())
    await waitFor(() => expect(savedStartButton()).toBeEnabled())
    expect(nextDraftDirty(edit())).toBe(false); expect(edit().agentEdits?.[nativeNode(node).agentId]).toBeUndefined()
    expect(edit().context.agents.find((item) => item.agent.id === nativeNode(node).agentId)?.metadataRevision).toBe(1)
    // Initial Stage plus confirmation replay; readback adds no new Stage.
    const request = stage.mock.calls[0]![0]
    expect(stage.mock.calls.map(([input]) => input)).toEqual([request, request])
    expect(advance).toHaveBeenCalledOnce(); expect(boardStartClient.start).not.toHaveBeenCalled()
  })
  it('FE-002 publication retains independent newer Agent typing and installs saved metadata without enabling Start', async () => {
    let persisted = empty, release!: (value: GraphEditReadResultV3) => void
    vi.mocked(nextDraftApi.editRead).mockImplementation(async () => persisted)
    vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => (persisted = stageValue(input)))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => new Promise((resolve) => { release = resolve }))
    const user = userEvent.setup(); mount(); const node = createWorker()
    await saveWithStop(user); await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    // Simulate an independently newer retained form, not typing into a locked fieldset.
    act(() => useGraphDraftStore.getState().updateNextDraft(key, (state) => changeDraftAgent(state,
      { ...state.agentEdits![nativeNode(node).agentId]!, name: 'Independently newer Worker' }, state.graph)))
    await act(async () => { persisted = published(persisted); release(persisted) })
    await waitFor(() => expect(readEditOutbox(key)).toBeUndefined())
    expect(edit().agentEdits?.[nativeNode(node).agentId]).toMatchObject({ name: 'Independently newer Worker',
      configurationVersionId: `saved-${nativeNode(node).agentId}`, createdAt: now, updatedAt: now })
    expect(edit().context.agents.find((item) => item.agent.id === nativeNode(node).agentId)?.agent.name).toBe('Worker 2')
    expect(nextDraftDirty(edit())).toBe(true); expectNoSavedStart(); expect(boardStartClient.start).not.toHaveBeenCalled()
  })
  it.each([[true, false], [true, true], [false, false], [false, true]])('FE-003 topology Discard: dropped reply=%s, newer edits=%s', async (dropped, newer) => {
    const context = repairFixture()
    vi.mocked(nextDraftApi.context).mockResolvedValue(context)
    useGraphDraftStore.getState().installNextDraft(key, context, true)
    let persisted = empty, visible = empty
    vi.mocked(nextDraftApi.editRead).mockImplementation(async () => visible)
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => {
      if (!persisted.intent) visible = persisted = stageValue(input)
      return persisted
    })
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => (visible = persisted = waiting(persisted)))
    const discard = vi.spyOn(nextDraftApi, 'editDiscard').mockImplementation(async () => {
      persisted = { ...persisted, intent: { ...persisted.intent!, state: 'discarded' } }
      if (dropped) throw new Error('discard reply lost')
      return (visible = persisted)
    })
    const user = userEvent.setup(), first = mount()
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => removeNode(graph, 'node-1')))
    await saveWithStop(user); await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    await retainedSaveReady(); moveSurvivor()
    if (newer) {
      typeMeaning('independently newer')
      act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => removeNode(graph, 'node-2')))
    }
    await confirmDiscard(user)
    await waitFor(() => expect(discard).toHaveBeenCalledOnce())
    // Only a confirmed Discard unlocks ordinary Save. A dropped reply remains reserved.
    if (dropped) await retainedSaveReady()
    else await waitFor(() => {
      expect(readEditOutbox(key)).toBeUndefined()
      const button = screen.queryByRole('button', { name: /^Save workflow$/ })
      if (newer) expect(button).toBeEnabled(); else expect(button).not.toBeInTheDocument()
    })
    if (dropped) {
      expect(readEditOutbox(key)).toBeDefined(); expect(edit().graph.nodes.some((node) => node.id === 'node-1')).toBe(false)
    } else await waitFor(() => expect(readEditOutbox(key)).toBeUndefined())
    visible = persisted; reopen(first); await screen.findByRole('region', { name: 'Workflow authoring' })
    await waitFor(() => expect(readEditOutbox(key)).toBeUndefined())
    expect(edit().graph.nodes.map((node) => node.id)).toEqual(newer ? ['node-0', 'node-1'] : ['node-0', 'node-1', 'node-2'])
    expect(edit().graph.edges.map((edge) => edge.id)).toEqual(newer ? ['edge-1'] : ['edge-1', 'edge-2'])
    expect(nativeNode(edit().graph.nodes[0])?.position).toEqual({ x: 934, y: -28 })
    expect(nativeNode(edit().graph.nodes[0])?.initialPrompt).toBe(newer ? 'independently newer' : undefined)
    expect(sameExecutableWorkflow(edit().graph, context.draft.graph)).toBe(!newer)
    expect(readEditSnapshot(key)?.graph).toEqual(edit().graph)
    // Stage, confirmation replay, Discard reconciliation; reopen is read-only.
    const request = stage.mock.calls[0]![0]
    expect(stage.mock.calls.map(([input]) => input)).toEqual([request, request, request])
    expect(advance).toHaveBeenCalledOnce(); expect(discard).toHaveBeenCalledOnce(); expect(boardStartClient.start).not.toHaveBeenCalled()
  })
})


describe('NIM-2644 follow-up stale existing-Agent attach', () => {
  it.each(['discard', 'reload-and-retry'] as const)('FE-001 releases AGENT_SOURCE_CONFLICT for explicit %s', async (action) => {
    const context = repairFixture(1), source = repairFixture(2).agents[1]!
    context.agents.push(source)
    useGraphDraftStore.getState().installNextDraft(key, context, true)
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockRejectedValueOnce(
      new ApiError({ code: 'AGENT_SOURCE_CONFLICT', message: 'The source Agent changed since it was selected.' }, 409))
      .mockImplementation(async (input) => stageValue(input))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => waiting(stageValue(stage.mock.calls.at(-1)![0])))
    const user = userEvent.setup(), first = mount()
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => attachAgent(graph, source, 'attached-worker')))
    await requestSave(user)
    await waitFor(() => expect(stage).toHaveBeenCalledOnce())
    await waitFor(() => expect(readEditOutbox(key)).toBeUndefined())
    expect(stage.mock.calls[0]![0].expectedAgentConfigurationVersionIds[source.agent.id]).toBe(source.agent.configurationVersionId)
    expect(edit().context.draft.revision).toBe(7)
    expect(edit().graph.nodes.some((node) => node.id === 'attached-worker')).toBe(true)
    expect(readEditSnapshot(key)?.graph).toEqual(edit().graph)
    await waitFor(() => expect(saveButton()).toBeEnabled())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Discard changes$/ })).toBeEnabled()
    expect(advance).not.toHaveBeenCalled()
    if (action === 'discard') {
      await confirmDiscard(user)
      expect(edit().graph.nodes.some((node) => node.id === 'attached-worker')).toBe(false)
      expect(stage).toHaveBeenCalledOnce()
      await waitFor(() => expect(savedStartButton()).toBeEnabled())
    } else {
      reopen(first); await screen.findByRole('region', { name: 'Workflow authoring' })
      const fresh = structuredClone(context)
      fresh.agents[1] = { metadataRevision: source.metadataRevision + 1,
        agent: { ...source.agent, configurationVersionId: 'configuration-updated-in-other-session' } }
      // Only Agent metadata/configuration changes. The draft revision stays 7.
      vi.mocked(nextDraftApi.context).mockResolvedValue(fresh)
      vi.spyOn(window, 'confirm').mockReturnValue(true)
      await user.click(screen.getByRole('button', { name: 'Workflow settings' }))
      await reloadSavedDraft(user)
      await waitFor(() => expect(edit().context.agents[1]?.metadataRevision).toBe(source.metadataRevision + 1))
      act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => attachAgent(graph, fresh.agents[1]!, 'attached-worker')))
      await saveWithStop(user); await waitFor(() => expect(advance).toHaveBeenCalledOnce())
      expect(stage).toHaveBeenCalledTimes(3)
      expect(stage.mock.calls[2]![0]).toEqual(stage.mock.calls[1]![0])
      expect(stage.mock.calls[1]![0].commandId).not.toBe(stage.mock.calls[0]![0].commandId)
      expect(stage.mock.calls[1]![0].expectedRevision).toBe(7)
      expect(stage.mock.calls[1]![0].expectedAgentConfigurationVersionIds[source.agent.id]).toBe('configuration-updated-in-other-session')
    }
    expect(boardStartClient.start).not.toHaveBeenCalled()
  })
})


// The mounted board retains the real module store; the sibling has a separate
// Zustand store and protected snapshot ID but shares the same localStorage.
function siblingConsumes(value: GraphEditReadResultV3) {
  const sibling = createStore<{ edit: ReturnType<typeof edit> }>(() => ({ edit: structuredClone(edit()) }))
  inFollowupTab('independent-sibling', () => {
    storeEditSnapshot(key, sibling.getState().edit)
    sibling.setState(({ edit: current }) => ({ edit: acknowledgeEditIntentSnapshot(key, current, value.intent!) }))
    acknowledgeEditOutbox(key, value.intent!.stageCommandId)
  })
  return sibling
}
describe('NIM-2644 follow-up mounted stale-tab readback', () => {
  it.each(['refresh', 'explicit-retry'] as const)('FE-002 sibling-consumed saved readback reconciles the mounted raw Worker through %s', async (recovery) => {
    let persisted = empty, visible = empty
    vi.mocked(nextDraftApi.editRead).mockImplementation(async () => visible)
    vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => (persisted = stageValue(input)))
    vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => {
      persisted = published(persisted); throw new Error('Publication reply lost in the stale tab')
    })
    const user = userEvent.setup(), first = mount(), node = createWorker()
    await saveWithStop(user)
    await waitFor(() => expect(persisted.intent?.state).toBe('saved'))
    await retainedSaveReady()
    const raw = structuredClone(edit())
    expect(raw.agentEdits?.[nativeNode(node).agentId]?.prompt).toBeUndefined()
    const sibling = siblingConsumes(persisted)
    expect(nextDraftDirty(sibling.getState().edit)).toBe(false)
    expect(readEditOutbox(key)).toBeUndefined()
    expect(edit()).toEqual(raw) // Consuming the sibling's store did not alter this one.
    visible = persisted
    if (recovery === 'refresh') reopen(first)
    else await requestSave(user)
    await waitFor(() => expect(savedStartButton()).toBeEnabled())
    // The sibling already saved: refresh/retry only reads its terminal receipt,
    // without showing another Stop dialog or sending another Stage or Advance.
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    const requests = vi.mocked(nextDraftApi.editStage).mock.calls.map(([input]) => input)
    expect(requests).toEqual([requests[0], requests[0]])
    expect(nextDraftApi.editAdvance).toHaveBeenCalledOnce()
    expect(nextDraftDirty(edit())).toBe(false); expect(edit().agentEdits).toEqual({})
    expect(editorAgents(edit()).find((agent) => agent.id === nativeNode(node).agentId)?.configurationVersionId).toBe(`saved-${nativeNode(node).agentId}`)
    expect(boardStartClient.start).not.toHaveBeenCalled()
  })
  it.each([false, true])('FE-003 another store consumes lost Discard first; refresh restores topology with newer typing=%s', async (newer) => {
    const context = repairFixture(3)
    useGraphDraftStore.getState().installNextDraft(key, context, true)
    let persisted = empty, visible = empty
    vi.mocked(nextDraftApi.editRead).mockImplementation(async () => visible)
    const stage = vi.spyOn(nextDraftApi, 'editStage').mockImplementation(async (input) => persisted.intent ? persisted : (persisted = stageValue(input)))
    const advance = vi.spyOn(nextDraftApi, 'editAdvance').mockImplementation(async () => (persisted = waiting(persisted)))
    const discard = vi.spyOn(nextDraftApi, 'editDiscard').mockImplementation(async () => {
      persisted = { ...persisted, intent: { ...persisted.intent!, state: 'discarded' } }
      throw new Error('Discard reply lost in original tab A')
    })
    const user = userEvent.setup(), first = mount()
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => removeNode(graph, 'node-2')))
    await saveWithStop(user); await waitFor(() => expect(advance).toHaveBeenCalledOnce())
    moveSurvivor()
    await confirmDiscard(user)
    await waitFor(() => expect(discard).toHaveBeenCalledOnce())
    // The reply was lost: reconcile/Discard remain available, ordinary Save does not.
    await retainedSaveReady()
    if (newer) typeMeaning('independent newer instruction')
    const raw = structuredClone(edit()), sibling = siblingConsumes(persisted)
    expect(sibling.getState().edit.graph.nodes.map((node) => node.id)).toEqual(['node-0', 'node-1', 'node-2'])
    expect(readEditOutbox(key)).toBeUndefined(); expect(edit()).toEqual(raw)
    visible = persisted; reopen(first)
    await waitFor(() => expect(edit().graph.nodes.map((node) => node.id)).toEqual(['node-0', 'node-1', 'node-2']))
    expect(edit().graph.edges).toEqual(context.draft.graph.edges)
    expect(nativeNode(edit().graph.nodes[0])?.position).toEqual({ x: 934, y: -28 })
    expect(nativeNode(edit().graph.nodes[0])?.initialPrompt).toBe(newer ? 'independent newer instruction' : undefined)
    expect(nextDraftDirty(edit())).toBe(newer)
    expect(advance).toHaveBeenCalledOnce(); expect(discard).toHaveBeenCalledOnce()
    const request = stage.mock.calls[0]![0]
    expect(stage.mock.calls.map(([input]) => input)).toEqual([request, request, request])
    expect(boardStartClient.start).not.toHaveBeenCalled()
  })
})
