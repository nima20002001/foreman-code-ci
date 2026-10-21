import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { CODEX_UNSUPPORTED_INTERACTION_ERRORS, type OperatorActivity } from '@foreman-code/contracts'
import { OperatorActivityList } from './OperatorActivityList'
import { mergeOperatorActivity } from '../../shared/api/operatorActivity'

const activity = (kind: OperatorActivity['kind'], sequence = '9007199254740993'): OperatorActivity => ({
  id: `native-${kind}`, requestId: 'request', sequence, revision: 1, kind,
  title: `${kind} operation`, status: 'running', input: 'Exact native input', output: 'Initial output',
})

describe('Operator activity disclosures', () => {
  it.each(Object.values(CODEX_UNSUPPORTED_INTERACTION_ERRORS))('keeps unsupported-request errors visible: %s', (message) => {
    render(<OperatorActivityList entries={[{ ...activity('tool'), status: 'failed', title: message, output: message }]}
      onBrowse={vi.fn()} />)
    expect(screen.getByText(`Tool · ${message}`)).toBeVisible()
    expect(screen.getByText('Failed')).toBeVisible()
  })
  it('does not invent a thinking summary when the provider supplies none', () => {
    render(<OperatorActivityList entries={[{ ...activity('thinking'), output: '' }]} onBrowse={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'Thinking' })).not.toBeInTheDocument()
    expect(screen.queryByText(/Waiting for the reasoning/)).not.toBeInTheDocument()
  })
  it('describes omitted tool details without attributing the omission to the harness', async () => {
    const entry: OperatorActivity = {
      id: 'native-tool', requestId: 'request', sequence: '1', revision: 1,
      kind: 'tool', title: 'Read', status: 'completed',
    }
    render(<OperatorActivityList entries={[entry]} onBrowse={vi.fn()} />)
    await userEvent.setup().click(screen.getByText('Tool · Read'))
    expect(screen.getByText('Details are not included in this view.')).toBeVisible()
    expect(screen.queryByText('Input')).not.toBeInTheDocument()
    expect(screen.queryByText('Output')).not.toBeInTheDocument()
  })
  it.each(['tool', 'web_search', 'file_read', 'file_write', 'subagent'] as const)('expands %s independently and stays open through a final update', async (kind) => {
    const onBrowse = vi.fn()
    const value = activity(kind)
    const view = render(<OperatorActivityList entries={[value]} onBrowse={onBrowse} />)
    const summary = screen.getByText(new RegExp(`${kind} operation`)).closest('summary')!
    const details = summary.closest('details')!
    expect(details).not.toHaveAttribute('open')
    await userEvent.setup().click(summary)
    expect(details).toHaveAttribute('open')
    expect(screen.getByText('Exact native input')).toBeVisible()
    expect(onBrowse).toHaveBeenCalledOnce()
    view.rerender(<OperatorActivityList entries={[{ ...value, revision: 2, status: 'completed', output: 'Final native result' }]} onBrowse={onBrowse} />)
    expect(details).toHaveAttribute('open')
    expect(screen.getByText('Final native result')).toBeVisible()
    expect(screen.queryByText('Done')).not.toBeInTheDocument()
  })

  it('shows only a generic MCP call while it is active and hides it after completion', () => {
    const value = { ...activity('mcp'), title: 'cua_repl · js', input: 'Private tool arguments', output: 'Private tool output' }
    const view = render(<OperatorActivityList entries={[value]} onBrowse={vi.fn()} />)
    expect(screen.getByRole('status')).toHaveTextContent('MCP tool call · Running')
    expect(screen.queryByText(/cua_repl|Private tool/)).not.toBeInTheDocument()
    expect(screen.queryByRole('group')).not.toBeInTheDocument()
    view.rerender(<OperatorActivityList entries={[{ ...value, status: 'completed' }]} onBrowse={vi.fn()} />)
    expect(screen.queryByText(/MCP tool call/)).not.toBeInTheDocument()
  })

  it('keeps thinking separate from tools and preserves the toggle through persistence', async () => {
    const value = { ...activity('thinking'), id: 'reasoning', output: '' }
    const view = render(<OperatorActivityList entries={[value, activity('mcp', '9007199254740994')]} activeRequestId="request"
      parts={{ 'thinking:reasoning': 'Native live summary' }} onBrowse={vi.fn()} />)
    await userEvent.setup().click(screen.getByRole('button', { name: 'Thinking' }))
    expect(screen.getByRole('region', { name: 'Thinking summary' })).toHaveTextContent('Native live summary')
    view.rerender(<OperatorActivityList entries={[{ ...value, revision: 2, status: 'completed', output: 'Saved reasoning summary' }, activity('mcp', '9007199254740994')]} onBrowse={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Thinking' })).toHaveAttribute('aria-expanded', 'true')
    expect(screen.getByRole('region', { name: 'Thinking summary' })).toHaveTextContent('Saved reasoning summary')
    expect(screen.getByText('MCP tool call · Running')).toBeVisible()
  })

  it('keeps the newest accepted item revision and sorts opaque sequences without rounding', () => {
    const older = activity('tool')
    const newer = { ...older, revision: 2, status: 'completed' as const }
    expect(mergeOperatorActivity([newer], [older, activity('mcp', '9007199254740994')])).toEqual([newer, activity('mcp', '9007199254740994')])
  })
})
