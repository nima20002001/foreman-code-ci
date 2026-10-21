// @vitest-environment jsdom
import userEvent from '@testing-library/user-event'
import { GRAPHQL_AGENT_TOOLS, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import type { GraphqlAgentTool, GraphqlToolOverride } from '@foreman-code/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultAgentForHarness } from '../agents/agentSettings'
import { AgentSettingsForm } from './AgentSettingsForm'

afterEach(cleanup)

function open(role: 'orchestrator' | 'coder', extra: { graphqlTools?: GraphqlAgentTool[] } = {}, nodeGraphqlTools?: GraphqlToolOverride) {
  // Existing Agents with omitted choices keep the legacy role defaults.
  const agent = { ...defaultAgentForHarness('codex', 'agent', 'Agent', DEFAULT_HARNESS_DEFAULTS.codex, role), graphqlTools: undefined, ...extra }
  const onSave = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><AgentSettingsForm agent={agent} nodeGraphqlTools={nodeGraphqlTools}
    creationDefaults={DEFAULT_HARNESS_DEFAULTS} onClose={() => undefined} onSave={onSave} /></QueryClientProvider>)
  fireEvent.click(screen.getByRole('button', { name: 'Advanced settings' }))
  return { onSave, tools: screen.getByRole('group', { name: 'Foreman Code MCP tools' }) }
}

describe('Foreman Code MCP tools in Agent settings', () => {
  it('keeps bug reporting available with no controls to disable it', () => {
    const { tools } = open('coder', { graphqlTools: [] }, { add: [], remove: ['bug_report'] })
    expect(within(tools).getByText('Report a bug')).toBeVisible()
    expect(within(tools).getByText('Always available')).toBeVisible()
    expect(within(tools).queryByLabelText('Report a bug: Agent default')).not.toBeInTheDocument()
    expect(within(tools).queryByRole('group', { name: 'Report a bug: this workflow' })).not.toBeInTheDocument()
    expect(tools).not.toHaveTextContent('Enabled in this workflow:')
    expect(within(tools).getByText('bug_report')).toBeVisible()
  })

  it('lists only the role tools, never Operator tools', () => {
    const coder = open('coder').tools
    expect(within(coder).queryByText('Respond to approvals')).toBeNull()
    expect(within(coder).queryByText(/workflow_create/)).toBeNull()
    cleanup()
    expect(within(open('orchestrator').tools).getByText('Respond to approvals')).toBeInTheDocument()
  })

  it('saves the Agent default and this node change separately', () => {
    const { onSave, tools } = open('coder')
    fireEvent.click(within(tools).getByLabelText('Read an interaction: Agent default'))
    fireEvent.click(within(tools).getByLabelText('Read run context: Agent default'))
    const group = within(tools).getByRole('group', { name: 'Read run context: this workflow' })
    fireEvent.click(within(group).getByLabelText('On'))
    expect(within(tools).getByLabelText('Read an interaction: Agent default')).not.toBeChecked()
    expect(within(tools).getByLabelText('Read run context: Agent default')).not.toBeChecked()
    expect(within(group).getByLabelText('On')).toBeChecked()
    expect(within(tools).getByText('Always available')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Save agent settings' }))
    expect(onSave.mock.calls[0]![0].graphqlTools).toEqual(['bug_report', 'files.references_list', 'files.reference_read', 'interaction_list', 'files.native_output_create',
      'files.native_output_append', 'files.native_output_seal', 'files.native_output_publish', 'ci_run', 'ci_get',
      'ci_computers_list', 'ci_cancel', 'ci_logs_read'])
    expect(onSave.mock.calls[0]![3]).toEqual({ add: ['context_get'], remove: [] })
  })

  it('drops a node change that the new default already matches', () => {
    const { onSave, tools } = open('coder', { graphqlTools: ['context_get'] }, { add: ['interaction_list'], remove: [] })
    expect(within(within(tools).getByRole('group', { name: 'List interactions: this workflow' })).getByLabelText('On')).toBeChecked()
    fireEvent.click(within(tools).getByLabelText('List interactions: Agent default'))
    fireEvent.click(screen.getByRole('button', { name: 'Save agent settings' }))
    expect(onSave.mock.calls[0]![0].graphqlTools).toEqual(['context_get', 'interaction_list'])
    expect(onSave.mock.calls[0]![3]).toBeUndefined()
  })

  it('keeps an inherited Agent default when only this workflow changes', () => {
    const { onSave, tools } = open('coder')
    const group = within(tools).getByRole('group', { name: 'Read an interaction: this workflow' })
    fireEvent.click(within(group).getByLabelText('Off'))
    fireEvent.click(screen.getByRole('button', { name: 'Save agent settings' }))
    expect(onSave.mock.calls[0]![0].graphqlTools).toBeUndefined()
    expect(onSave.mock.calls[0]![3]).toEqual({ add: [], remove: ['interaction_get'] })
  })

  it('preserves explicit collaboration tools when an ordinary tool checkbox changes', () => {
    const { onSave, tools } = open('coder', { graphqlTools: ['context_get', 'memory_board_get', 'memory_board_changes_read'] })
    fireEvent.click(within(tools).getByLabelText('Read run context: Agent default'))
    fireEvent.click(screen.getByRole('button', { name: 'Save agent settings' }))
    expect(onSave.mock.calls[0]![0].graphqlTools).toEqual(['memory_board_get', 'memory_board_changes_read'])
  })
})

it('shows tool explanations on demand while retaining names, codes, and selections', async () => {
  const { tools } = open('coder')
  const explanation = GRAPHQL_AGENT_TOOLS.bug_report.description
  expect(within(tools).queryByText(explanation)).not.toBeInTheDocument()
  await userEvent.hover(within(tools).getByRole('button', { name: 'About Report a bug' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent(explanation)
  expect(within(tools).getByText('bug_report')).toBeVisible()
})
