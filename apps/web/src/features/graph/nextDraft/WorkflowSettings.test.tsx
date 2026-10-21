import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { fixture } from './core.cases'
import { newNextDraft } from './state'
import { WorkflowSettings } from './WorkflowSettings'

const explanations = [
  ['Starts the workflow', 'The first node to run. It can’t receive a dependency.'],
  ['Approval handler', 'Agents ask you before sensitive actions. Requests appear in the approval inbox.'],
  ['Maximum parallelism', 'Agents running at once'],
  ['Maximum node executions', 'Agent turns per run'],
  ['Agent active-time budget (seconds)', /Per Agent execution; approval waits are excluded/],
  ['Execution folder', 'Runs work in this workspace’s folder.'],
] as const

it.each(explanations)('keeps settings visible and shows the %s explanation on hover', async (label, explanation) => {
  render(<WorkflowSettings draftKey="settings-test" edit={newNextDraft(fixture(), 'settings-test')} change={vi.fn()} report={vi.fn()}
    defaultMs={600_000} locationReady locationMessage="" onChangeFolder={vi.fn()} onReload={vi.fn()} />)
  const user = userEvent.setup()
  const settings = screen
  expect(settings.getByRole('combobox', { name: 'Starts the workflow' })).toHaveValue('node-0')
  expect(settings.getByRole('combobox', { name: 'Approval handler' })).toHaveValue('user')
  expect(settings.getByRole('spinbutton', { name: 'Maximum parallelism' })).toHaveValue(4)
  expect(settings.getByRole('spinbutton', { name: 'Maximum node executions' })).toHaveValue(1000)
  expect(settings.getByText(/Based on saved version/)).toBeVisible()

  expect(settings.queryByText(explanation)).not.toBeInTheDocument()
  const hint = settings.getByRole('button', { name: `About ${label}` })
  await user.hover(hint)
  expect(screen.getByRole('tooltip')).toHaveTextContent(explanation)
  expect(hint).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id)
  await user.unhover(hint)
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
})

it('keeps required actions, unsaved state, and configured values visible beside optional guidance', async () => {
  const context = fixture()
  context.draft.baseWorkflowVersionId = null
  const edit = newNextDraft(context, 'settings-test')
  edit.graph = { ...edit.graph, entryNodeId: 'removed-node', requiredAgentCount: 2,
    handoffs: { contractVersion: 1 } }
  const changeFolder = vi.fn()
  const reload = vi.fn()
  render(<WorkflowSettings draftKey="settings-test" edit={edit} change={vi.fn()} report={vi.fn()} defaultMs={undefined}
    locationReady={false} locationMessage="Choose an execution folder to run this workflow."
    onChangeFolder={changeFolder} onReload={reload} />)
  expect(screen.getByRole('alert')).toHaveTextContent('The starting node was removed. Choose another one.')
  expect(screen.getByText('Choose an execution folder to run this workflow.')).toBeVisible()
  expect(screen.getByText('This workflow hasn’t been saved yet.')).toBeVisible()
  expect(screen.getByRole('spinbutton', { name: 'Required Agent count' })).toHaveValue(2)
  expect(screen.queryByText(/Set each work connection’s Run-wide handoff limit/)).not.toBeInTheDocument()
  const user = userEvent.setup()
  await user.hover(screen.getByRole('button', { name: 'About Limits' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Set each work connection’s Run-wide handoff limit on its line.')
  await user.click(screen.getByRole('button', { name: 'Change folder' }))
  expect(changeFolder).toHaveBeenCalledOnce()
  await user.click(screen.getByRole('button', { name: 'Reload saved draft' }))
  expect(reload).toHaveBeenCalledOnce()
})
