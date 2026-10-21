// @vitest-environment jsdom
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { PendingNativeInteraction } from '@foreman-code/contracts'
import { OperatorApprovalCard } from './OperatorApprovalCard'

const option = (optionId: string, semantic: PendingNativeInteraction['responseOptions'][number]['semantic'], label: string, persistence: PendingNativeInteraction['responseOptions'][number]['persistence']) => ({
  optionId, semantic, label, persistence, affectsOtherPendingRequests: false, interruptsCurrentTurn: false, mutatesPersistentPolicy: persistence === 'persistent_config',
})
const interaction: PendingNativeInteraction = {
  session: { harness: 'codex', providerVersion: 'test', nativeSessionId: 'session' },
  turn: { nativeTurnId: 'turn', nativeRequestId: 'request' },
  nativeRequestType: 'mcpServer/elicitation/request',
  request: { mode: 'form', message: 'Allow Browser use to access http://127.0.0.1:5173?', serverName: 'cua_repl',
    _meta: { origin: 'http://127.0.0.1:5173', connector_name: 'Browser use', tool_name: 'access_browser_origin', tool_title: 'Access browser origin',
      tool_params: { origin: 'http://127.0.0.1:5173' }, codex_approval_kind: 'mcp_tool_call' } },
  responseOptions: [option('once', 'approve_once', 'Accept', 'request'), option('always', 'persistent_policy_change', "Allow and don't ask me again", 'persistent_config'),
    option('reject', 'reject', 'Decline', 'request'), option('cancel', 'cancel', 'Cancel request', 'request')],
}

describe('Operator approval card', () => {
  it('shows a compact destination with visible scope and expandable native details', async () => {
    const onSelect = vi.fn()
    render(<OperatorApprovalCard interaction={interaction} disabled={false} onSelect={onSelect} />)
    const card = screen.getByLabelText('Operator approval request')
    expect(within(card).getByText('Access browser origin?')).toBeVisible()
    expect(within(card).getByText('MCP tool · Browser use')).toBeVisible()
    expect(within(card).getByText('http://127.0.0.1:5173', { selector: '.operator-approval-target strong' })).toBeVisible()
    expect(within(card).queryByText('Cancel request')).not.toBeInTheDocument()
    expect(within(card).queryByText(/callId/)).not.toBeInTheDocument()
    expect(within(card).getByText('Request details').closest('details')).not.toHaveAttribute('open')
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Allow once' }))
    expect(onSelect).toHaveBeenCalledWith('once')
    await userEvent.setup().click(within(card).getByRole('button', { name: "Allow and don't ask me again" }))
    expect(onSelect).toHaveBeenCalledWith('always')
    await userEvent.setup().click(within(card).getByRole('button', { name: 'Decline' }))
    expect(onSelect).toHaveBeenCalledWith('reject')
    await userEvent.setup().click(within(card).getByText('Request details'))
    expect(within(card).getByText('MCP tool call through the connected provider')).toBeVisible()
    expect(within(card).getByText(/Scope: Persistent native configuration/)).toBeVisible()
    expect(within(card).getByLabelText('Full approval request')).toBeVisible()
  })
})


describe('PR19: approval scope and reading interaction', () => {
  it.each(['request', 'turn', 'session', 'provider_instance', 'project', 'persistent_config'] as const)(
    'shows %s scope without hover and associates it with the decision button', (persistence) => {
      const choice = { ...option('scope', 'approve_once', 'Approve scope', persistence), scopeSummary: 'Provider-specific restriction.',
        affectsOtherPendingRequests: true, interruptsCurrentTurn: true }
      const { unmount } = render(<OperatorApprovalCard interaction={{ ...interaction, responseOptions: [choice] }} disabled={false} onSelect={vi.fn()} />)
      const button = screen.getByRole('button', { name: 'Allow once' })
      const description = document.getElementById(button.getAttribute('aria-describedby')!)!
      expect(description).toBeVisible()
      expect(description).toHaveTextContent('Provider-specific restriction.')
      expect(description).toHaveTextContent('Scope:')
      expect(description).toHaveTextContent('Also affects other pending requests.')
      expect(description).toHaveTextContent('Interrupts the current turn.')
      if (persistence === 'provider_instance') expect(description).toHaveTextContent('including other sessions')
      unmount()
    },
  )
  it('marks opening details as reading and never promises an unknown sandbox', async () => {
    const onBrowse = vi.fn()
    const request = { command: 'inspect-workspace', cwd: '/workspace', unusualProviderField: { permittedPaths: ['/workspace/src'] } }
    const { unmount } = render(<OperatorApprovalCard interaction={{ ...interaction,
      nativeRequestType: 'item/commandExecution/requestApproval', request }} disabled={false} onSelect={vi.fn()} onBrowse={onBrowse} />)
    await userEvent.setup().click(screen.getByText('Request details'))
    expect(onBrowse).toHaveBeenCalledOnce()
    expect(screen.getByLabelText('Full approval request')).toHaveTextContent('unusualProviderField')
    expect(screen.queryByText(/in the agent sandbox/)).not.toBeInTheDocument()
    unmount()
  })
})


it('keeps a turn-interrupting MCP cancellation visible rather than treating it as a duplicate decline', () => {
  const cancel = { ...option('interrupt', 'cancel', 'Stop current turn', 'turn'), interruptsCurrentTurn: true }
  const view = render(<OperatorApprovalCard interaction={{ ...interaction, responseOptions: [cancel] }} disabled={false} onSelect={vi.fn()} />)
  expect(screen.getByRole('button', { name: 'Stop current turn' })).toBeVisible()
  const describedBy = screen.getByRole('button', { name: 'Stop current turn' }).getAttribute('aria-describedby')!
  expect(document.getElementById(describedBy)?.textContent).toMatch(/interrupt.*turn/i)
  view.unmount()
})
