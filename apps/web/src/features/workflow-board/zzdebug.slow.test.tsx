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
import { authoring, mount, recoveryFixture, settings, type Fixture } from './hierarchyRecovery.testSupport'

installBoardTestLifecycle()
const rail = () => within(screen.getByRole('complementary', { name: 'Workflow side panel' }))

async function applyHierarchy(parent: string) {
  await settings()
  await userEvent.selectOptions(screen.getByLabelText('Master'), 'node-0')
  await userEvent.selectOptions(screen.getByLabelText('Node 3 reports to'), parent)
  await userEvent.click(screen.getByRole('button', { name: 'Apply hierarchy to draft' }))
}
async function openAgent(name: string) {
  await userEvent.click(within(screen.getByRole('navigation', { name: 'Agents and connections' }))
    .getByRole('button', { name }))
  await rail().findByRole('textbox', { name: 'Name' })
}
async function createWorker(parent: string, name: string, prompt: string, { apply = true } = {}) {
  await userEvent.click(authoring().getByRole('button', { name: 'Add agent or job to graph' }))
  const form = within(await screen.findByRole('region', { name: 'Create Agent in workflow' }))
  await form.findByRole('textbox', { name: 'Name' })
  await userEvent.selectOptions(form.getByLabelText('Reports to'), parent)
  fireEvent.change(form.getByRole('textbox', { name: 'Name' }), { target: { value: name } })
  fireEvent.change(form.getByRole('textbox', { name: 'Initial prompt' }), { target: { value: prompt } })
  if (apply) {
    await userEvent.click(form.getByRole('button', { name: 'Add Worker to draft' }))
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Create Agent in workflow' })).not.toBeInTheDocument())
    expect(rail().getByRole('textbox', { name: 'Name' })).toHaveValue(name)
    await userEvent.click(rail().getByRole('button', { name: 'Details' }))
  }
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
  return within(await screen.findByRole('dialog', { name: 'Remove Node 1 from workflow?' }))
}
async function compare() {
  await settings()
  await userEvent.click(screen.getAllByRole('button', { name: 'View unsaved draft' })[0]!)
  const comparison = screen.getByRole('region', { name: 'Read-only recovered draft' })
  await userEvent.click(within(comparison).getByText('All recovered fields'))
  return comparison
}

const t0 = { v: 0, last: 0 }
const lap = (n: number) => { const now = Date.now(); console.error('LAP', n, now - t0.last, now - t0.v); t0.last = now }
it('creates, edits and plans removal through Board controls, retaining every raw form through repeated conflict recovery', async () => {
  const f = await recoveryFixture(fixture(['orchestrator', 'orchestrator', 'orchestrator', 'coder']))
  lap(64)
  let view = await mount(f)
  lap(65)
  await applyHierarchy('node-1')
  lap(66)
  await createWorker('node-1', 'Created Worker', 'Applied creation task')
  lap(67)
  f.externalEdit('Saved on another computer')
  lap(68)
  await userEvent.click(authoring().getByRole('button', { name: 'Save workflow' }))
  lap(69)
  await screen.findByText('The saved workflow changed. Inspect latest to compare your draft.')
  lap(70)
  const rejected = f.requests.at(-1)!
  const originalCreated = rejected.stagedAgents!.find(item => item.agent.name === 'Created Worker')!
  expect(originalCreated.baseRevision).toBeNull()
  lap(73)

  await openAgent('Node 3')
  lap(75)
  await userEvent.selectOptions(rail().getByLabelText('Reports to'), 'node-2')
  lap(76)
  await userEvent.click(rail().getByRole('button', { name: 'Advanced settings' }))
  lap(77)
  fireEvent.change(rail().getByRole('textbox', { name: 'Initial prompt' }), { target: { value: 'Unapplied Worker direction' } })
  lap(78)
  await userEvent.click(rail().getByRole('button', { name: 'Details' }))
  lap(79)
  await createWorker('node-2', 'Unapplied Worker', 'Creation in progress', { apply: false })
  lap(80)
  view = await refresh(f, view)
  lap(81)
  await settings()
  lap(82)
  await userEvent.selectOptions(screen.getByLabelText('Master'), 'node-2')
  lap(83)
  await userEvent.selectOptions(screen.getByLabelText('Previous Master'), 'keep')
  lap(84)
  view = await refresh(f, view)
  lap(85)
  const remove = await removal()
  lap(86)
  await userEvent.selectOptions(remove.getByLabelText('Move 2 Workers to'), 'node-2')
  lap(87)
  view = await refresh(f, view)
  lap(88)
  const resumedRemoval = within(await screen.findByRole('dialog', { name: 'Remove Node 1 from workflow?' }))
  lap(89)
  expect(resumedRemoval.getByLabelText('Move 2 Workers to')).toHaveValue('node-2')
  lap(90)
  await userEvent.click(resumedRemoval.getByRole('button', { name: 'Inspect latest' }))
  lap(91)
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Remove Node 1 from workflow?' })).not.toBeInTheDocument())
  lap(92)
  const comparison = await compare()
  lap(93)
  for (const text of ['Created Worker', 'Applied creation task', 'Unapplied Worker direction',
    'Unapplied Worker', 'Creation in progress', '"workerParents"', '"removeNode"',
    '"destinationParentId": "node-2"', '"previousMaster": "keep"']) {
    expect(comparison).toHaveTextContent(text)
  }
  expect(authoring().getByTitle('Rename workflow')).toHaveTextContent('Saved on another computer')
  lap(99)
  expect(within(screen.getByRole('navigation', { name: 'Agents and connections' }))
    .queryByRole('button', { name: 'Created Worker' })).not.toBeInTheDocument()

  await applyHierarchy('node-2')
  lap(103)
  f.externalEdit('Second concurrent save')
  lap(104)
  await userEvent.click(authoring().getByRole('button', { name: 'Save workflow' }))
  lap(105)
  await screen.findByText('The saved workflow changed. Inspect latest to compare your draft.')
  lap(106)
  await userEvent.click(screen.getByRole('button', { name: 'Inspect latest' }))
  lap(107)
  await waitFor(() => expect(screen.getAllByRole('button', { name: 'View unsaved draft' })).toHaveLength(2))
  lap(108)
  await refresh(f, view)
  lap(109)
  expect(await compare()).toHaveTextContent('Creation in progress')
  lap(110)
  await applyHierarchy('node-2')
  lap(111)
  await createWorker('node-2', 'Created Worker', 'Applied creation task')
  lap(112)
  const reappliedRemoval = await removal()
  lap(113)
  expect(screen.getByRole('dialog', { name: 'Remove Node 1 from workflow?' }))
  lap(114)
    .toHaveTextContent('named outcomes will need explicit connection editing')
  await userEvent.click(reappliedRemoval.getByRole('button', { name: 'Apply removal to draft' }))
  lap(116)
  await openAgent('Entry · Node 0')
  lap(117)
  expect(rail().getByRole('combobox', { name: 'Target for outcome 1' })).toHaveDisplayValue('Removed handoff')
  lap(118)
  await userEvent.click(rail().getByRole('button', { name: 'Remove outcome 1' }))
  lap(119)
  await userEvent.click(authoring().getByRole('button', { name: 'Save workflow' }))
  lap(120)
  await waitFor(() => expect(f.saved().version.definition.nodes.some(node => node.id === 'node-1')).toBe(false))
  lap(121)
  expect(f.saved().version.definition.nodes).toHaveLength(4)
  lap(122)
  const accepted = f.requests.at(-1)!
  expect(accepted.commandId).not.toBe(rejected.commandId)
  lap(124)
  expect(accepted.draftId).not.toBe(rejected.draftId)
  lap(125)
  expect(accepted.expectedWorkflowVersionId).not.toBe(rejected.expectedWorkflowVersionId)
  lap(126)
  expect(f.saved().version.definition.nodes.some(node => node.id === 'node-1')).toBe(false)
  lap(127)
  expect(f.saved().version.definition.nodes.some(node => node.kind !== 'job' && node.agentId === originalCreated.agent.id)).toBe(false)
  lap(128)
  expect(accepted.stagedAgents).toContainEqual(expect.objectContaining({ baseRevision: null,
    agent: expect.objectContaining({ name: 'Created Worker' }) }))
  await settings()
  lap(131)
  expect(screen.getAllByRole('button', { name: 'View unsaved draft' })).toHaveLength(2)
  lap(132)
  expect(f.wire.writes().every(request => request.path.endsWith('/definition/edits'))).toBe(true)
  lap(133)
}, 30000)

