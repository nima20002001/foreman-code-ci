import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, expect, it, vi } from 'vitest'
import { GraphEditIntentV3Schema, type GraphEditReadResultV3 } from '@foreman-code/contracts/wave25'
import { useGraphDraftStore } from '../store'
import { fixture } from './core.cases'
import { nextDraftDirty, nextDraftKey } from './state'
import { nextDraftApi } from './transport'
import { readEditOutbox, readEditSnapshot, readEditSubmission } from './editIntentStorage'
import { useGraphEditIntent } from './useGraphEditIntent'

const key = nextDraftKey('workspace', 'workflow')
const clients: QueryClient[] = []
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear())
  useGraphDraftStore.getState().clearAllDrafts(); localStorage.clear(); sessionStorage.clear(); vi.restoreAllMocks()
})
function remote() {
  const context = fixture(), graph = context.draft.graph
  const agent = { ...context.agents[0]!.agent, name: 'Renamed through MCP' }
  const stagedAgents = [{ agent, baseRevision: 3 }]
  const originalPins = { 'agent-0': 'configuration-0', 'agent-1': 'configuration-1' }
  const resultantPins = { ...originalPins, 'agent-0': 'configuration-saved' }
  const hash = 'sha256:' + '1'.repeat(64), now = '2026-09-26T00:00:00.000Z'
  const saveInput = { workspaceId: 'workspace', workflowId: 'workflow', commandId: 'save-remote', executionSemanticsVersion: 3,
    expectedRevision: 7, expectedWorkflowVersionId: 'workflow-version-1', expectedAgentConfigurationVersionIds: originalPins,
    resultantAgentConfigurationVersionIds: resultantPins, graph, stagedAgents }
  // Exact private readback of an intent submitted elsewhere (e.g. authenticated
  // MCP by this principal). Transport is mocked; this is Board reconciliation,
  // not a second backend authentication or atomic-publication test.
  const staged = GraphEditIntentV3Schema.parse({ kind: 'current', id: 'remote-intent', ownerPrincipalId: 'same-principal',
    workspaceId: 'workspace', workflowId: 'workflow', draftId: 'draft', expectedRevision: 7,
    expectedWorkflowVersionId: 'workflow-version-1', savedWorkflowRevision: 7,
    stageCommandId: 'stage-remote', stageInputHash: hash, advanceCommandId: 'advance-remote', advanceInputHash: hash,
    discardCommandId: 'discard-remote', discardInputHash: hash, saveInput, saveInputHash: hash,
    stagedDraft: { id: 'draft', workspaceId: 'workspace', workflowId: 'workflow', revision: 7,
      baseWorkflowVersionId: 'workflow-version-1', graph, agentConfigurationVersionIds: originalPins,
      resultantAgentConfigurationVersionIds: resultantPins, saveCommandId: 'save-remote', stagedAgents,
    },
    agentPins: context.agents.map((item) => ({ agentId: item.agent.id, metadataRevision: item.metadataRevision,
      configurationVersionId: item.agent.configurationVersionId })),
    affected: [], stops: [], state: 'staged', saveAttempted: false, createdAt: now, updatedAt: now })
  const persisted = { agent: { ...agent, configurationVersionId: 'configuration-saved' }, metadataRevision: 4 }
  const saved = GraphEditIntentV3Schema.parse({ ...staged, state: 'saved', saveAttempted: true,
    result: { workspaceId: 'workspace', workflowId: 'workflow', revision: 8, currentVersionId: 'workflow-version-2', agents: [persisted],
      version: { id: 'workflow-version-2', workspaceId: 'workspace', workflowId: 'workflow', version: 2,
        executionSemanticsVersion: 3, entryNodeId: graph.entryNodeId, definition: { ...graph, version: 2 },
        approval: graph.approval, agentConfigurationVersionIds: resultantPins, contentHash: hash, createdAt: now } } })
  const data = (intent: typeof staged): GraphEditReadResultV3 => ({ intent, current: [], canStop: false, affectedSetChanged: false })
  useGraphDraftStore.getState().installNextDraft(key, context)
  const read = vi.spyOn(nextDraftApi, 'editRead').mockResolvedValue(data(staged))
  const advance = vi.spyOn(nextDraftApi, 'editAdvance')
  return { staged, saved, data, read, advance, persisted, agent }
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  return renderHook(() => {
    const edit = useGraphDraftStore((state) => state.nextDrafts[key]!)
    return useGraphEditIntent(key, edit)
  }, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> })
}
const current = () => useGraphDraftStore.getState().nextDrafts[key]!
async function hydrated() { await waitFor(() => expect(current().remoteEditIntent?.id).toBe('remote-intent')) }

it.each([false, true])('acknowledges exact remote Agent publication without a local submission (reopen=%s)', async (reopen) => {
  const t = remote()
  let hook = mount(); await hydrated()
  expect(current().agentEdits?.['agent-0']).toEqual(t.agent)
  expect(readEditSubmission(key, t.staged)).toBeUndefined()
  expect(readEditOutbox(key)).toBeUndefined()
  if (reopen) {
    const snapshot = readEditSnapshot(key)!
    hook.unmount(); useGraphDraftStore.getState().clearAllDrafts()
    useGraphDraftStore.getState().installNextDraft(key, snapshot.context)
    useGraphDraftStore.getState().updateNextDraft(key, (edit) => ({ ...edit, ...snapshot }))
    t.read.mockResolvedValue(t.data(t.saved)); hook = mount()
  } else {
    t.read.mockResolvedValue(t.data(t.saved))
    await act(async () => { await hook.result.current.query.refetch() })
  }
  await waitFor(() => expect(current().context.draft.revision).toBe(8))
  expect(current().context.draft.baseWorkflowVersionId).toBe('workflow-version-2')
  expect(current().context.agents[0]).toEqual(t.persisted)
  expect(current().agentEdits).toEqual({}); expect(current().remoteEditIntent).toBeUndefined()
  expect(nextDraftDirty(current())).toBe(false)
  expect(readEditSubmission(key, t.saved)).toBeUndefined(); expect(readEditOutbox(key)).toBeUndefined()
  expect(t.advance).not.toHaveBeenCalled()
})
it.each(['before', 'after'] as const)('does not acknowledge a dirty local Agent form edited %s remote hydration', async (when) => {
  const t = remote()
  if (when === 'before') useGraphDraftStore.getState().updateNextDraft(key, (edit) => ({ ...edit, agentEdits: { 'agent-0': t.agent } }))
  const hook = mount()
  if (when === 'after') {
    await hydrated()
    act(() => useGraphDraftStore.getState().updateNextDraft(key, (edit) => ({ ...edit,
      agentEdits: { 'agent-0': { ...t.agent, name: 'Independent newer edit' } } })))
  } else await waitFor(() => expect(hook.result.current.query.isSuccess).toBe(true))
  const before = current()
  t.read.mockResolvedValue(t.data(t.saved))
  await act(async () => { await hook.result.current.query.refetch() })
  expect(current()).toBe(before)
  expect(current().context.draft.revision).toBe(7)
})
it.each(['ownerPrincipalId', 'id', 'stageCommandId', 'stageInputHash'] as const)('rejects a different remote lineage %s', async (field) => {
  const t = remote(), hook = mount(); await hydrated()
  const before = current()
  const other = GraphEditIntentV3Schema.parse({ ...t.saved, [field]: field === 'stageInputHash' ? 'sha256:' + '2'.repeat(64) : 'other-identity' })
  t.read.mockResolvedValue(t.data(other))
  await act(async () => { await hook.result.current.query.refetch() })
  expect(current()).toBe(before)
})
it('does not broaden Discard acknowledgement without local submission evidence', async () => {
  const t = remote(), hook = mount(); await hydrated()
  const before = current()
  t.read.mockResolvedValue(t.data(GraphEditIntentV3Schema.parse({ ...t.staged, state: 'discarded' })))
  await act(async () => { await hook.result.current.query.refetch() })
  expect(current()).toBe(before); expect(t.advance).not.toHaveBeenCalled()
})
it.each(['version', 'configuration'] as const)('does not hydrate over a different displayed %s pin', async (pin) => {
  const t = remote()
  useGraphDraftStore.getState().updateNextDraft(key, (edit) => ({ ...edit, context: { ...edit.context,
    ...(pin === 'version' ? { draft: { ...edit.context.draft, baseWorkflowVersionId: 'other-version' } }
      : { agents: edit.context.agents.map((item, index) => index ? item : { ...item, agent: { ...item.agent, configurationVersionId: 'other-config' } }) }) } }))
  const before = current(), hook = mount()
  await waitFor(() => expect(hook.result.current.query.isSuccess).toBe(true))
  expect(current()).toBe(before); expect(current().remoteEditIntent).toBeUndefined()
  expect(readEditSubmission(key, t.staged)).toBeUndefined()
})
it('retains independent workflow edits made after remote Agent hydration', async () => {
  const t = remote(), hook = mount(); await hydrated()
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node, index) => index ? node : { ...node, initialPrompt: 'Independent instruction' }) })))
  const before = current()
  t.read.mockResolvedValue(t.data(t.saved))
  await act(async () => { await hook.result.current.query.refetch() })
  expect(current()).toBe(before); expect(current().context.draft.revision).toBe(7)
})
