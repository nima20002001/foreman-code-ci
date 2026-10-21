import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { AvailableAgentList, ChoiceFields, RelationshipFields } from './AuthoringFields'
import { WorkConnectionLimitEditor } from './WorkConnectionLimitEditor'
import { fixture } from './core.cases'

it('lists each available Agent with one Add action and explains nothing else', async () => {
  const context = fixture()
  const change = vi.fn()
  render(<AvailableAgentList context={context} change={change} report={vi.fn()} />)
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^About / })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Add Agent 1' }))
  expect(change).toHaveBeenCalledOnce()
  const added = change.mock.calls[0]![0](context.draft.graph)
  expect(added.nodes.at(-1)).toMatchObject({ agentId: 'agent-1', name: 'Agent 1' })
})

it('says there is nothing to add when no Agent is available', () => {
  const context = fixture()
  context.agents = context.agents.map((record) => ({ ...record, archivedAt: '2026-09-22T00:00:00Z' }))
  render(<AvailableAgentList context={context} change={vi.fn()} report={vi.fn()} />)
  expect(screen.getByText(/No existing Agents are available/)).toBeVisible()
  expect(screen.queryByRole('button', { name: /^Add / })).not.toBeInTheDocument()
})

it('keeps routing format instructions visible and moves the routing explanation into a hint', async () => {
  const graph = fixture().draft.graph
  const node = { ...graph.nodes[0]!, choice: { outcomes: [] } }
  render(<ChoiceFields graph={graph} node={node} change={vi.fn()} />)
  expect(screen.getByText('Return exactly this JSON, with no other text:')).toBeInTheDocument()
  expect(screen.queryByText('The agent ends with an outcome name, and only the matching handoff runs.')).not.toBeInTheDocument()
  await userEvent.hover(screen.getByRole('button', { name: 'About Routing mode' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('The agent ends with an outcome name, and only the matching handoff runs.')
})

it('explains connection behavior and one-pass dependencies in the connection hint', async () => {
  const graph = fixture().draft.graph
  render(<RelationshipFields graph={graph} relationship={graph.edges[0]!} change={vi.fn()} report={vi.fn()} />)
  expect(screen.getByRole('textbox', { name: 'Label' })).toBeVisible()
  expect(screen.queryByText('When the first agent finishes, its result goes to the second one.')).not.toBeInTheDocument()
  await userEvent.hover(screen.getByRole('button', { name: 'About Connection settings' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('When the first agent finishes, its result goes to the second one.')
  expect(screen.getByRole('tooltip')).toHaveTextContent('One-pass dependencies activate each selected node once.')
})

it('keeps handoff input and validation visible while explaining the limit on demand', async () => {
  render(<WorkConnectionLimitEditor value={3} onApply={vi.fn()} />)
  expect(screen.getByRole('textbox', { name: 'Maximum work handoffs per Run' })).toHaveValue('3')
  expect(screen.queryByText(/Includes the first work submission/)).not.toBeInTheDocument()
  await userEvent.hover(screen.getByRole('button', { name: 'About Maximum work handoffs per Run' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Leave blank for no connection cap.')
})
