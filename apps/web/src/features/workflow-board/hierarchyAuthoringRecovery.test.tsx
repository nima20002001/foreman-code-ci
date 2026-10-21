// @vitest-environment jsdom
import { QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { WorkflowHierarchyReadResultSchema } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { useGraphDraftStore } from '../graph/store'
import { fixture } from '../graph/nextDraft/core.cases'
import { MasterOverview } from '../workflow-hierarchy/MasterOverview'
import { installBoardTestLifecycle } from './eng05D.testSupport'
import { agentList, authoring, findDialog, hierarchyForm, labelled, mount, queryDialog, rail, recovery, recoveryFixture,
  settings, toolbar, type Fixture } from './hierarchyRecovery.testSupport'

installBoardTestLifecycle()

async function applyHierarchy(parent: string) {
  await settings()
  await userEvent.selectOptions(hierarchyForm().getByLabelText('Master'), 'node-0')
  await userEvent.selectOptions(hierarchyForm().getByLabelText('Node 3 reports to'), parent)
  await userEvent.click(hierarchyForm().getByRole('button', { name: 'Apply hierarchy to draft' }))
}
async function openAgent(name: string) {
  await userEvent.click(agentList().getByRole('button', { name }))
  await rail().findByRole('textbox', { name: 'Name' })
}
/** The plus adds a Worker from its Settings profile; its team, name and task are then edited in its settings. */
async function createWorker(parent: string, name: string, prompt: string, { apply = true } = {}) {
  await userEvent.click(authoring().getByRole('button', { name: 'Add agent' }))
  const worker = within(screen.getByRole('menu', { name: 'Add agent' })).getByRole('menuitem', { name: 'Worker' })
  await waitFor(() => expect(worker).not.toHaveAttribute('aria-disabled'))
  await userEvent.click(worker)
  await openAgent('Worker 2')
  await userEvent.selectOptions(rail().getByLabelText('Reports to'), parent)
  fireEvent.change(rail().getByRole('textbox', { name: 'Name' }), { target: { value: name } })
  await userEvent.click(rail().getByRole('button', { name: 'Advanced settings' }))
  fireEvent.change(rail().getByRole('textbox', { name: 'Initial prompt' }), { target: { value: prompt } })
  if (apply) await userEvent.click(rail().getByRole('button', { name: 'Apply agent settings to draft' }))
  await userEvent.click(rail().getByRole('button', { name: 'Details' }))
}
async function refresh(f: Fixture, view: Awaited<ReturnType<typeof mount>>) {
  const href = view.router.history.location.href
  view.unmount()
  // A page reload drops in-memory state, keeping the browser's recovery records.
  act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
  return mount({ ...f, href })
}
async function removal() {
  await openAgent('Node 1')
  await userEvent.click(rail().getByRole('button', { name: 'Remove Agent 1 from workflow' }))
  return within(await findDialog('Remove Node 1 from workflow?'))
}
async function compare() {
  await settings()
  await userEvent.click(recovery().getAllByRole('button', { name: 'View unsaved draft' })[0]!)
  const comparison = labelled('Read-only recovered draft')
  await userEvent.click(within(comparison).getByText('All recovered fields'))
  return comparison
}

async function conflictedBoard({ create = true } = {}) {
  const f = await recoveryFixture(fixture(['orchestrator', 'orchestrator', 'orchestrator', 'coder']))
  const view = await mount(f)
  await applyHierarchy('node-1')
  if (create) await createWorker('node-1', 'Created Worker', 'Applied creation task')
  f.externalEdit('Saved on another computer')
  await userEvent.click(toolbar('Draft actions').getByRole('button', { name: 'Save workflow' }))
  await screen.findByText('The saved workflow changed. Inspect latest to compare your draft.')
  const rejected = f.requests.at(-1)!
  const originalCreated = rejected.stagedAgents?.find(item => item.agent.name === 'Created Worker')
  if (create) expect(originalCreated!.baseRevision).toBeNull()
  return { f, view, rejected, originalCreated }
}

async function inspectLatestFromSettings(recoveries: number) {
  await settings()
  await userEvent.click(recovery().getByRole('button', { name: 'Inspect latest' }))
  await waitFor(() => expect(recovery().getAllByRole('button', { name: 'View unsaved draft' })).toHaveLength(recoveries))
}

it('recovers an applied creation after the saved workflow changed', async () => {
  await conflictedBoard()
  await inspectLatestFromSettings(1)
  const comparison = await compare()
  for (const text of ['Created Worker', 'Applied creation task']) expect(comparison).toHaveTextContent(text)
  expect(authoring().getByTitle('Rename workflow')).toHaveTextContent('Saved on another computer')
  expect(agentList().queryByRole('button', { name: 'Created Worker' })).not.toBeInTheDocument()
}, 30000)

it('retains unapplied Worker, creation and Master forms through refreshes', async () => {
  const { f, view: mounted } = await conflictedBoard({ create: false })
  await openAgent('Node 3')
  await userEvent.selectOptions(rail().getByLabelText('Reports to'), 'node-2')
  await userEvent.click(rail().getByRole('button', { name: 'Advanced settings' }))
  fireEvent.change(rail().getByRole('textbox', { name: 'Initial prompt' }), { target: { value: 'Unapplied Worker direction' } })
  await userEvent.click(rail().getByRole('button', { name: 'Details' }))
  await createWorker('node-2', 'Unapplied Worker', 'Creation in progress', { apply: false })
  const view = await refresh(f, mounted)
  await settings()
  await userEvent.selectOptions(hierarchyForm().getByLabelText('Master'), 'node-2')
  await userEvent.selectOptions(hierarchyForm().getByLabelText('Previous Master'), 'keep')
  await refresh(f, view)
  await inspectLatestFromSettings(1)
  const comparison = await compare()
  for (const text of ['Unapplied Worker direction', 'Unapplied Worker', 'Creation in progress',
    '"workerParents"', '"previousMaster": "keep"']) {
    expect(comparison).toHaveTextContent(text)
  }
}, 30000)

it('retains a planned Agent removal through refresh until the latest workflow is inspected', async () => {
  const { f, view: mounted } = await conflictedBoard()
  const remove = await removal()
  await userEvent.selectOptions(remove.getByLabelText('Move 2 Workers to'), 'node-2')
  await refresh(f, mounted)
  const resumedRemoval = within(await findDialog('Remove Node 1 from workflow?'))
  expect(resumedRemoval.getByLabelText('Move 2 Workers to')).toHaveValue('node-2')
  await userEvent.click(resumedRemoval.getByRole('button', { name: 'Inspect latest' }))
  await waitFor(() => expect(queryDialog('Remove Node 1 from workflow?')).not.toBeInTheDocument())
  const comparison = await compare()
  for (const text of ['"removeNode"', '"destinationParentId": "node-2"']) expect(comparison).toHaveTextContent(text)
}, 30000)

it('keeps an unapplied creation form through a second conflict recovery', async () => {
  const { f, view: mounted } = await conflictedBoard({ create: false })
  await createWorker('node-2', 'Unapplied Worker', 'Creation in progress', { apply: false })
  const view = await refresh(f, mounted)
  await inspectLatestFromSettings(1)
  await applyHierarchy('node-2')
  f.externalEdit('Second concurrent save')
  await userEvent.click(toolbar('Draft actions').getByRole('button', { name: 'Save workflow' }))
  await screen.findByText('The saved workflow changed. Inspect latest to compare your draft.')
  await userEvent.click(recovery().getByRole('button', { name: 'Inspect latest' }))
  await waitFor(() => expect(recovery().getAllByRole('button', { name: 'View unsaved draft' })).toHaveLength(2))
  await refresh(f, view)
  expect(await compare()).toHaveTextContent('Creation in progress')
}, 30000)

it('saves a reapplied creation and removal after conflict recovery', async () => {
  const { f, rejected, originalCreated } = await conflictedBoard()
  await inspectLatestFromSettings(1)
  await applyHierarchy('node-2')
  await createWorker('node-2', 'Created Worker', 'Applied creation task')
  const reappliedRemoval = await removal()
  expect(queryDialog('Remove Node 1 from workflow?'))
    .toHaveTextContent('named outcomes will need explicit connection editing')
  await userEvent.click(reappliedRemoval.getByRole('button', { name: 'Apply removal to draft' }))
  await openAgent('Entry · Node 0')
  expect(rail().getByRole('combobox', { name: 'Target for outcome 1' })).toHaveDisplayValue('Removed handoff')
  await userEvent.click(rail().getByRole('button', { name: 'Remove outcome 1' }))
  await userEvent.click(toolbar('Draft actions').getByRole('button', { name: 'Save workflow' }))
  await waitFor(() => expect(f.saved().version.definition.nodes.some(node => node.id === 'node-1')).toBe(false))
  expect(f.saved().version.definition.nodes).toHaveLength(4)
  const accepted = f.requests.at(-1)!
  expect(accepted.commandId).not.toBe(rejected.commandId)
  expect(accepted.draftId).not.toBe(rejected.draftId)
  expect(accepted.expectedWorkflowVersionId).not.toBe(rejected.expectedWorkflowVersionId)
  expect(f.saved().version.definition.nodes.some(node => node.kind !== 'job' && node.agentId === originalCreated!.agent.id)).toBe(false)
  expect(accepted.stagedAgents).toContainEqual(expect.objectContaining({ baseRevision: null,
    agent: expect.objectContaining({ name: 'Created Worker' }) }))
  await settings()
  expect(recovery().getAllByRole('button', { name: 'View unsaved draft' })).toHaveLength(1)
  expect(f.wire.writes().every(request => request.path.endsWith('/definition/edits'))).toBe(true)
}, 30000)

it('keeps both recovered drafts after saving following repeated conflicts', async () => {
  const { f, view } = await conflictedBoard({ create: false })
  await inspectLatestFromSettings(1)
  await applyHierarchy('node-2')
  f.externalEdit('Second concurrent save')
  await userEvent.click(toolbar('Draft actions').getByRole('button', { name: 'Save workflow' }))
  await screen.findByText('The saved workflow changed. Inspect latest to compare your draft.')
  await userEvent.click(recovery().getByRole('button', { name: 'Inspect latest' }))
  await waitFor(() => expect(recovery().getAllByRole('button', { name: 'View unsaved draft' })).toHaveLength(2))
  await refresh(f, view)
  await applyHierarchy('node-2')
  await userEvent.click(toolbar('Draft actions').getByRole('button', { name: 'Save workflow' }))
  await waitFor(() => expect(f.saved().version.definition.hierarchy?.masterNodeId).toBe('node-0'))
  await settings()
  expect(recovery().getAllByRole('button', { name: 'View unsaved draft' })).toHaveLength(2)
  expect(f.wire.writes().every(request => request.path.endsWith('/definition/edits'))).toBe(true)
}, 30000)

it('refreshes an already visible saved Overview when the Board publishes a hierarchy', async () => {
  const f = await recoveryFixture(fixture(['orchestrator', 'orchestrator', 'orchestrator', 'coder']))
  const view = await mount(f)
  server.use(http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/hierarchy', () => {
    const saved = f.saved()
    const graph = saved.version.definition
    return HttpResponse.json(WorkflowHierarchyReadResultSchema.parse({ workspaceId: f.workspaceId,
      workflowId: f.workflowId, workflowVersionId: saved.currentVersionId, revision: saved.revision,
      hierarchy: graph.hierarchy ?? null, agents: graph.nodes.map(node => ({ workspaceId: f.workspaceId,
        workflowId: f.workflowId, workflowNodeId: node.id, agentId: node.kind === 'job' ? '' : node.agentId,
        displayName: node.name, productRole: node.id === graph.hierarchy?.masterNodeId ? 'master'
          : node.id === 'node-3' ? 'coder' : 'orchestrator',
        configurationVersionId: node.kind === 'job' ? '' : saved.version.agentConfigurationVersionIds[node.agentId],
      })) }))
  }))
  const overview = render(<QueryClientProvider client={view.cache}><MasterOverview workspaceId={f.workspaceId} workflowId={f.workflowId}
    onChat={vi.fn()} onSettings={vi.fn()} onReport={vi.fn()} onExecution={vi.fn()} /></QueryClientProvider>)
  await within(overview.container).findByRole('heading', { name: 'No Master in this workflow' })
  await applyHierarchy('node-1')
  await userEvent.click(toolbar('Draft actions').getByRole('button', { name: 'Save workflow' }))
  await within(overview.container).findByRole('heading', { name: 'Node 0 Master' })
  expect(f.saved().version.definition.hierarchy?.masterNodeId).toBe('node-0')
}, 30000)
