// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { useGraphDraftStore } from '../graph/store'
import { fixture } from '../graph/nextDraft/core.cases'
import { newNextDraft, nextDraftKey } from '../graph/nextDraft/state'
import { editorAgents } from '../graph/nextDraft/agentEdits'
import { BoardAgentSettings } from '../workflow-board/AgentControls'
import { queryKeys } from '../../shared/api/query'
import { NodeConnections, NodeWorkflowFields } from '../graph/nextDraft/AuthoringFields'
import { storeEditSnapshot, readEditSnapshot, retainConflictRecovery, readConflictRecoveries } from '../graph/nextDraft/editIntentStorage'
import { ConflictRecoveryPanel } from '../graph/nextDraft/ConflictRecoveryPanel'
import { HierarchyEditor } from './HierarchyEditor'
import { applyMasterHierarchy } from './authoring'
import { RemoveHierarchyNodeDialog } from './RemoveHierarchyNodeDialog'

vi.mock('../node-placement/usePlacementChoices', () => ({ usePlacementChoices: () => ({ options: [], current: false }) }))

const draftKey = nextDraftKey('workspace', 'workflow')
const report = vi.fn()
const clients: QueryClient[] = []
function context() {
  const value = fixture(['orchestrator', 'orchestrator', 'coder'])
  value.agents = value.agents.map(record => ({ ...record, agent: { ...record.agent,
    harness: 'codex', harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex } }))
  return value
}
function Surface() {
  const edit = useGraphDraftStore(state => state.nextDrafts[draftKey]!)
  return <><HierarchyEditor draftKey={draftKey} edit={edit} report={report} />
    <ConflictRecoveryPanel draftKey={draftKey} edit={edit} pending={false} report={report} inspectLatest={async () => {}} /></>
}
beforeEach(() => {
  report.mockClear(); localStorage.clear(); sessionStorage.clear()
  useGraphDraftStore.setState({ nextDrafts: {} })
  useGraphDraftStore.getState().installNextDraft(draftKey, context())
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); useGraphDraftStore.setState({ nextDrafts: {} }); localStorage.clear(); sessionStorage.clear() })

it('retains unapplied hierarchy selections across remount and in a separate read-only conflict copy', async () => {
  const view = render(<Surface />)
  await userEvent.selectOptions(screen.getByLabelText('Master'), 'node-1')
  await userEvent.selectOptions(screen.getByLabelText('Node 2 reports to'), 'node-0')
  const original = useGraphDraftStore.getState().nextDrafts[draftKey]!
  expect(original.graph.hierarchy).toBeUndefined()
  expect(original.agentEdits).toBeUndefined()
  storeEditSnapshot(draftKey, original)
  view.unmount()
  useGraphDraftStore.setState({ nextDrafts: {} })
  const reopened = readEditSnapshot(draftKey)!
  useGraphDraftStore.getState().installNextDraft(draftKey, reopened.context)
  useGraphDraftStore.getState().updateNextDraft(draftKey, edit => ({ ...edit, ...reopened }))
  const nextView = render(<Surface />)
  expect(screen.getByLabelText('Master')).toHaveValue('node-1')
  expect(screen.getByLabelText('Node 2 reports to')).toHaveValue('node-0')
  nextView.unmount()
  retainConflictRecovery(draftKey, useGraphDraftStore.getState().nextDrafts[draftKey]!)
  useGraphDraftStore.getState().updateNextDraft(draftKey, edit => ({ ...edit, conflictRecovery: readConflictRecoveries(draftKey) }))
  useGraphDraftStore.getState().installNextDraft(draftKey, context(), true)
  render(<Surface />)
  expect(screen.getByLabelText('Master')).toHaveValue('')
  await userEvent.click(screen.getByRole('button', { name: 'View unsaved draft' }))
  const comparison = screen.getByRole('region', { name: 'Read-only recovered draft' })
  await userEvent.click(within(comparison).getByText('All recovered fields'))
  expect(within(comparison).getByText(/"unsavedWorkflowForms"/).textContent).toContain('"masterNodeId": "node-1"')
  expect(within(comparison).getByText(/"unsavedWorkflowForms"/).textContent).toContain('"node-2": "node-0"')
  expect(report).not.toHaveBeenCalled()
})

it('requires Worker reassignment before Apply and stages required routes while preserving every existing connection', async () => {
  render(<Surface />)
  expect(within(screen.getByLabelText('Master')).queryByRole('option', { name: 'Node 2' })).not.toBeInTheDocument()
  await userEvent.selectOptions(screen.getByLabelText('Master'), 'node-0')
  expect(screen.getByRole('button', { name: 'Apply hierarchy to draft' })).toBeDisabled()
  await userEvent.selectOptions(screen.getByLabelText('Node 2 reports to'), 'node-1')
  const original = useGraphDraftStore.getState().nextDrafts[draftKey]!
  await userEvent.click(screen.getByRole('button', { name: 'Apply hierarchy to draft' }))
  const changed = useGraphDraftStore.getState().nextDrafts[draftKey]!
  expect(changed.graph.edges).toEqual(expect.arrayContaining(original.graph.edges))
  expect(changed.graph.edges).toContainEqual(expect.objectContaining({ source: 'node-1', target: 'node-2', kind: 'execution' }))
  expect(screen.getByRole('region', { name: 'Changed connections' })).toHaveTextContent('Added: Node 1 → Node 2')
  expect(changed.workflowForms?.hierarchy).toBeUndefined()
  expect(report).not.toHaveBeenCalled()
})

function teamContext() {
  const value = fixture(['orchestrator', 'orchestrator', 'orchestrator', 'coder'])
  value.agents = value.agents.map(record => ({ ...record, agent: { ...record.agent, harness: 'codex',
    harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex, prompt: {}, assignedSkills: [] } }))
  const initial = applyMasterHierarchy(newNextDraft(value, 'reparent-editor'), 'node-0', { 'node-3': 'node-1' })
  return { ...value, draft: { ...value.draft, graph: initial.graph },
    agents: editorAgents(initial).map(agent => ({ agent, metadataRevision: 3 })) }
}
function TeamSettings({ pending = false }: { pending?: boolean }) {
  const edit = useGraphDraftStore(state => state.nextDrafts[draftKey]!)
  const [open, setOpen] = useState(true)
  const node = edit.graph.nodes.find(item => item.id === 'node-3')!
  return <><button onClick={() => setOpen(true)}>Open Worker settings</button>
    {open ? <BoardAgentSettings draftKey={draftKey} edit={edit} nodeId="node-3" close={() => setOpen(false)} /> : null}
    <NodeWorkflowFields graph={edit.graph} node={node} context={edit.context} agentEdits={edit.agentEdits}
      change={change => useGraphDraftStore.getState().changeNextDraft(draftKey, change)} />
    <NodeConnections graph={edit.graph} nodeId={node.id}
      change={change => useGraphDraftStore.getState().changeNextDraft(draftKey, change)} report={report} />
    <button onClick={() => useGraphDraftStore.getState().updateNextDraft(draftKey, current => ({ ...current,
      workflowForms: { ...current.workflowForms, removeNode: { nodeId: 'node-1', destinationParentId: '' } } }))}>Remove team</button>
    <button disabled={!edit.history.length} onClick={() => useGraphDraftStore.getState().undoNextDraft(draftKey)}>Undo</button>
    <RemoveHierarchyNodeDialog draftKey={draftKey} edit={edit} pending={pending} report={report} /></>
}
function mountTeam({ pending = false } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  clients.push(client)
  client.setQueryData(queryKeys.managedHarnessCatalog, [{ harness: 'codex', defaults: DEFAULT_HARNESS_DEFAULTS.codex,
    defaultsRevision: 1, capability: null, discoveryError: null }])
  return render(<QueryClientProvider client={client}><TeamSettings pending={pending} /></QueryClientProvider>)
}

it('keeps an open removal form locked while its operation is pending', async () => {
  useGraphDraftStore.getState().installNextDraft(draftKey, teamContext(), true)
  const original = structuredClone(useGraphDraftStore.getState().nextDrafts[draftKey]!.graph)
  mountTeam({ pending: true })
  await userEvent.click(screen.getByRole('button', { name: 'Remove team' }))
  const dialog = screen.getByRole('dialog', { name: 'Remove Node 1 from workflow?' })
  expect(within(dialog).getByRole('button', { name: 'Apply removal to draft' })).toBeDisabled()
  expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled()
  expect(within(dialog).getByLabelText('Move 1 Workers to')).toBeDisabled()
  fireEvent.keyDown(dialog, { key: 'Escape' })
  fireEvent.pointerDown(dialog)
  fireEvent.click(dialog)
  expect(dialog).toBeVisible()
  expect(useGraphDraftStore.getState().nextDrafts[draftKey]!.graph).toEqual(original)
  expect(useGraphDraftStore.getState().nextDrafts[draftKey]!.workflowForms?.removeNode).toEqual({
    nodeId: 'node-1', destinationParentId: '',
  })
})
it('retains a Worker parent until Apply; Cancel leaves graph intact, Apply changes membership and routes in one Undo', async () => {
  useGraphDraftStore.getState().installNextDraft(draftKey, teamContext(), true)
  const original = structuredClone(useGraphDraftStore.getState().nextDrafts[draftKey]!.graph)
  const view = mountTeam()
  expect(screen.getByLabelText('Reports to')).toHaveValue('node-1')
  expect(screen.getByRole('region', { name: 'Connections' })).toHaveTextContent('Reports to Node 1')
  await userEvent.selectOptions(screen.getByLabelText('Reports to'), 'node-2')
  expect(useGraphDraftStore.getState().nextDrafts[draftKey]!.graph).toEqual(original)
  expect(screen.getByRole('region', { name: 'Connections' })).toHaveTextContent('Reports to Node 1')
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(useGraphDraftStore.getState().nextDrafts[draftKey]!.graph).toEqual(original)
  await userEvent.click(screen.getByRole('button', { name: 'Open Worker settings' }))
  expect(screen.getByLabelText('Reports to')).toHaveValue('node-1')
  await userEvent.selectOptions(screen.getByLabelText('Reports to'), 'node-2')
  storeEditSnapshot(draftKey, useGraphDraftStore.getState().nextDrafts[draftKey]!)
  view.unmount()
  const retained = readEditSnapshot(draftKey)!
  act(() => { useGraphDraftStore.setState({ nextDrafts: {} }); useGraphDraftStore.getState().installNextDraft(draftKey, retained.context)
    useGraphDraftStore.getState().updateNextDraft(draftKey, edit => ({ ...edit, ...retained })) })
  mountTeam()
  expect(screen.getByLabelText('Reports to')).toHaveValue('node-2')
  expect(useGraphDraftStore.getState().nextDrafts[draftKey]!.graph).toEqual(original)
  await userEvent.click(screen.getByRole('button', { name: 'Apply agent settings to draft' }))
  const connections = screen.getByRole('region', { name: 'Connections' })
  expect(connections).toHaveTextContent('Reports to Node 2')
  expect(connections).toHaveTextContent('Receives from Node 1')
  const changed = useGraphDraftStore.getState().nextDrafts[draftKey]!
  expect(changed.graph.edges).toEqual(expect.arrayContaining(original.edges))
  expect(changed.history).toHaveLength(1)
  expect(changed.workflowForms?.workerParents).toBeUndefined()
  await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(useGraphDraftStore.getState().nextDrafts[draftKey]!.graph).toEqual(original)
  expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled()
  expect(report).not.toHaveBeenCalled()
})

it('retains a Move Workers destination across refresh, cancels without changes and removes the team in one Undo', async () => {
  useGraphDraftStore.getState().installNextDraft(draftKey, teamContext(), true)
  const original = structuredClone(useGraphDraftStore.getState().nextDrafts[draftKey]!.graph)
  const view = mountTeam()
  await userEvent.click(screen.getByRole('button', { name: 'Remove team' }))
  const dialog = screen.getByRole('dialog', { name: 'Remove Node 1 from workflow?' })
  expect(within(dialog).getByRole('button', { name: 'Apply removal to draft' })).toBeDisabled()
  await userEvent.selectOptions(within(dialog).getByLabelText('Move 1 Workers to'), 'node-2')
  expect(useGraphDraftStore.getState().nextDrafts[draftKey]!.graph).toEqual(original)
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(useGraphDraftStore.getState().nextDrafts[draftKey]!.graph).toEqual(original)
  await userEvent.click(screen.getByRole('button', { name: 'Remove team' }))
  await userEvent.selectOptions(screen.getByLabelText('Move 1 Workers to'), 'node-2')
  storeEditSnapshot(draftKey, useGraphDraftStore.getState().nextDrafts[draftKey]!)
  view.unmount()
  const retained = readEditSnapshot(draftKey)!
  act(() => { useGraphDraftStore.setState({ nextDrafts: {} }); useGraphDraftStore.getState().installNextDraft(draftKey, retained.context)
    useGraphDraftStore.getState().updateNextDraft(draftKey, edit => ({ ...edit, ...retained })) })
  mountTeam()
  expect(screen.getByLabelText('Move 1 Workers to')).toHaveValue('node-2')
  await userEvent.click(screen.getByRole('button', { name: 'Apply removal to draft' }))
  const changed = useGraphDraftStore.getState().nextDrafts[draftKey]!
  expect(changed.graph.nodes.some(node => node.id === 'node-1')).toBe(false)
  expect(changed.graph.nodes.find(node => node.id === 'node-3')).toEqual(original.nodes.find(node => node.id === 'node-3'))
  expect(changed.graph.hierarchy?.parents).toContainEqual({ workflowNodeId: 'node-3', parentNodeId: 'node-2' })
  expect(changed.graph.edges).toContainEqual(expect.objectContaining({ source: 'node-2', target: 'node-3', kind: 'execution' }))
  expect(changed.graph.edges.some(edge => edge.source === 'node-1' || edge.target === 'node-1')).toBe(false)
  expect(changed.history).toHaveLength(1)
  await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
  expect(useGraphDraftStore.getState().nextDrafts[draftKey]!.graph).toEqual(original)
  expect(report).not.toHaveBeenCalled()
})

it('requires an explicit previous-Master decision and preserves the replacement’s Workers before applying', async () => {
  useGraphDraftStore.getState().installNextDraft(draftKey, teamContext(), true)
  const original = structuredClone(useGraphDraftStore.getState().nextDrafts[draftKey]!.graph)
  render(<Surface />)
  await userEvent.selectOptions(screen.getByLabelText('Master'), 'node-1')
  expect(screen.getByRole('button', { name: 'Apply hierarchy to draft' })).toBeDisabled()
  await userEvent.selectOptions(screen.getByLabelText('Previous Master'), 'keep')
  await userEvent.selectOptions(screen.getByLabelText('Move 1 Workers to'), 'node-0')
  expect(useGraphDraftStore.getState().nextDrafts[draftKey]!.graph).toEqual(original)
  await userEvent.click(screen.getByRole('button', { name: 'Apply hierarchy to draft' }))
  const changed = useGraphDraftStore.getState().nextDrafts[draftKey]!
  expect(changed.graph.hierarchy).toMatchObject({ masterNodeId: 'node-1', parents: expect.arrayContaining([
    { workflowNodeId: 'node-0', parentNodeId: 'node-1' }, { workflowNodeId: 'node-3', parentNodeId: 'node-0' },
  ]) })
  expect(changed.graph.nodes).toHaveLength(original.nodes.length)
  expect(changed.graph.edges).toEqual(expect.arrayContaining(original.edges))
  expect(changed.history).toHaveLength(1)
})
