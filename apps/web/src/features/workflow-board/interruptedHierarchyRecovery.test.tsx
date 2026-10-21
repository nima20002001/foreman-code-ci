// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftDirty } from '../graph/nextDraft/state'
import { readConflictRecoveries, storeEditSnapshot } from '../graph/nextDraft/editIntentStorage'
import { fixture as authoringFixture } from '../graph/nextDraft/core.cases'
import { stageHierarchyAgent } from '../workflow-hierarchy/authoring'
import { installBoardTestLifecycle } from './eng05D.testSupport'
import { authoring, draft, mount, recoveryFixture, settings } from './hierarchyRecovery.testSupport'

installBoardTestLifecycle()

/** Rejects a saved hierarchy, then refreshes into an interrupted local document
 * holding a staged Agent and, when asked, unapplied Worker, creation and removal forms. */
async function interruptedConflict({ unappliedForms }: { unappliedForms: boolean }) {
  const f = await recoveryFixture(authoringFixture(['orchestrator', 'orchestrator', 'orchestrator', 'coder']))
  const first = await mount(f)
  await userEvent.click(authoring().getByRole('button', { name: 'Workflow settings' }))
  await userEvent.selectOptions(screen.getByLabelText('Master'), 'node-0')
  await userEvent.selectOptions(screen.getByLabelText('Node 3 reports to'), 'node-1')
  await userEvent.click(screen.getByRole('button', { name: 'Apply hierarchy to draft' }))
  f.externalEdit('Concurrent saved workflow')
  await userEvent.click(authoring().getByRole('button', { name: 'Save workflow' }))
  await screen.findByText('The saved workflow changed. Inspect latest to compare your draft.')
  const rejected = f.requests.at(-1)!
  if (unappliedForms) {
    await userEvent.click(within(screen.getByRole('navigation', { name: 'Agents and connections' })).getByRole('button', { name: 'Node 3' }))
    await userEvent.selectOptions(await screen.findByLabelText('Reports to'), 'node-2')
    await userEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
    await userEvent.click(screen.getByRole('textbox', { name: 'Initial prompt' }))
    await userEvent.paste('Unapplied Worker direction')
  }

  // A recovered local document can contain forms from earlier panel visits.
  // Seed that interrupted document; all recovery, comparison and publication
  // below run through the mounted Board and its real HTTP journal client.
  const before = draft(f)
  const worker = before.context.agents.find(item => item.agent.id === 'agent-3')!.agent
  const newWorker = { ...worker }
  delete newWorker.configurationVersionId
  const staged = stageHierarchyAgent(before, { ...newWorker, id: 'private-worker', name: 'Staged Worker' },
    'private-worker-node', 'node-1')
  const hierarchy = { masterNodeId: 'node-2', previousMaster: 'keep' as const,
    parents: { 'node-1': 'node-2', 'node-0': 'node-2', 'node-3': 'node-1', 'private-worker-node': 'node-1' } }
  const rawWorker = before.agentForms?.['node-3']
  const forms = unappliedForms && rawWorker ? {
    removeNode: { nodeId: 'node-1', destinationParentId: 'node-2' },
  } : {}
  if (unappliedForms) expect(rawWorker).toBeDefined()
  storeEditSnapshot(f.key, { ...staged, workflowForms: { ...staged.workflowForms, hierarchy, ...forms } })
  first.unmount()
  act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
  const refreshed = await mount(f)
  return { f, rejected, refreshed }
}

it('recovers an interrupted combined hierarchy, staged Agent and raw forms into a read-only comparison', async () => {
  const { f } = await interruptedConflict({ unappliedForms: true })
  const removal = await screen.findByRole('dialog', { name: 'Remove Node 1 from workflow?' })
  expect(within(removal).getByLabelText('Move 2 Workers to')).toHaveValue('node-2')
  await userEvent.click(within(removal).getByRole('button', { name: 'Inspect latest' }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove Node 1 from workflow?' })).not.toBeInTheDocument())
  await settings()
  await userEvent.click(screen.getByRole('button', { name: 'View unsaved draft' }))
  const comparison = screen.getByRole('region', { name: 'Read-only recovered draft' })
  await userEvent.click(within(comparison).getByText('All recovered fields'))
  for (const text of ['private-worker', 'Staged Worker', 'Unapplied Worker direction', '"workerParents"', '"removeNode"', '"destinationParentId": "node-2"', '"previousMaster": "keep"']) {
    expect(comparison).toHaveTextContent(text)
  }
  expect(draft(f).graph.hierarchy).toBeUndefined()
  expect(draft(f).graph.nodes).toHaveLength(4)
  expect(draft(f).agentEdits ?? {}).toEqual({})
  expect(draft(f).workflowForms ?? {}).toEqual({})
}, 30000)

it('saves only an explicitly reapplied hierarchy after repeated conflicts on an interrupted staged Agent', async () => {
  const { f, rejected, refreshed } = await interruptedConflict({ unappliedForms: false })
  await settings()
  await userEvent.click(screen.getByRole('button', { name: 'Inspect latest' }))
  await screen.findByRole('button', { name: 'View unsaved draft' })
  expect(draft(f).graph.nodes).toHaveLength(4)

  await userEvent.selectOptions(screen.getByLabelText('Master'), 'node-0')
  await userEvent.selectOptions(screen.getByLabelText('Node 3 reports to'), 'node-2')
  await userEvent.click(screen.getByRole('button', { name: 'Apply hierarchy to draft' }))
  f.externalEdit('Second concurrent workflow')
  await userEvent.click(authoring().getByRole('button', { name: 'Save workflow' }))
  await screen.findByText('The saved workflow changed. Inspect latest to compare your draft.')
  await userEvent.click(screen.getByRole('button', { name: 'Inspect latest' }))
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'View unsaved draft' })).toHaveLength(2))
  refreshed.unmount()
  act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
  await mount(f)
  await settings()
  expect(screen.getAllByRole('button', { name: 'View unsaved draft' })).toHaveLength(2)
  await userEvent.selectOptions(screen.getByLabelText('Master'), 'node-0')
  await userEvent.selectOptions(screen.getByLabelText('Node 3 reports to'), 'node-2')
  await userEvent.click(screen.getByRole('button', { name: 'Apply hierarchy to draft' }))
  await userEvent.click(authoring().getByRole('button', { name: 'Save workflow' }))
  await waitFor(() => expect(nextDraftDirty(draft(f))).toBe(false))
  const accepted = f.requests.at(-1)!
  expect(accepted.commandId).not.toBe(rejected.commandId)
  expect(accepted.draftId).not.toBe(rejected.draftId)
  expect(accepted.expectedWorkflowVersionId).not.toBe(rejected.expectedWorkflowVersionId)
  expect(f.saved().version.definition.hierarchy).toMatchObject({ masterNodeId: 'node-0', parents: expect.arrayContaining([
    { workflowNodeId: 'node-3', parentNodeId: 'node-2' },
  ]) })
  expect(f.saved().version.definition.nodes).toHaveLength(4)
  expect(accepted.stagedAgents?.some(item => item.agent.id === 'private-worker')).toBe(false)
  expect(readConflictRecoveries(f.key)).toHaveLength(2)
}, 30000)
