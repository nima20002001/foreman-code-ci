import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { savedClaudeConfiguration } from '../settings/claudeSettings.fixtures'
import { OperatorAccessPicker } from './OperatorAccessPicker'

describe('Operator access in agent settings', () => {
  it.each(['on-request', 'never'] as const)(
    'changes Codex sandbox and clears incompatible writable settings while preserving %s approvals',
    approvalPolicy => {
      const onChange = vi.fn().mockResolvedValue(true)
      const value = { ...DEFAULT_HARNESS_DEFAULTS.codex, sandbox: 'workspace-write' as const,
        advanced: { ...DEFAULT_HARNESS_DEFAULTS.codex.advanced!, additionalWritableDirectories: ['/workspace/project'], approvalPolicy } }
      render(<OperatorAccessPicker value={value} disabled={false} onChange={onChange} />)
      fireEvent.change(screen.getByRole('combobox', { name: 'Sandbox' }), { target: { value: 'danger-full-access' } })
      expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sandbox: 'danger-full-access',
        advanced: expect.objectContaining({ additionalWritableDirectories: [], approvalPolicy }) }))
    },
  )

  it('saves approval routing separately from sandbox access', () => {
    const onChange = vi.fn().mockResolvedValue(true)
    render(<OperatorAccessPicker value={DEFAULT_HARNESS_DEFAULTS.codex} disabled={false} onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Approval requests' }), { target: { value: 'never' } })
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ sandbox: 'read-only', advanced: expect.objectContaining({ approvalPolicy: 'never' }) }))
  })

  it('edits Claude access through its real supported configuration', () => {
    const onChange = vi.fn().mockResolvedValue(true)
    render(<OperatorAccessPicker value={savedClaudeConfiguration} disabled={false} onChange={onChange} />)
    fireEvent.change(screen.getByRole('combobox', { name: 'Sandbox' }), { target: { value: 'danger-full-access' } })
    expect(onChange).toHaveBeenCalledWith({ ...savedClaudeConfiguration, sandbox: 'danger-full-access' })
    expect(screen.queryByRole('button', { name: 'Add rule' })).not.toBeInTheDocument()
  })


  it('locks access controls during an uncertain or pending settings operation', () => {
    render(<OperatorAccessPicker value={DEFAULT_HARNESS_DEFAULTS.codex} disabled saving saveError="Read back this save first" onChange={vi.fn()} />)
    expect(screen.getByRole('combobox', { name: 'Sandbox' })).toBeDisabled()
    expect(screen.getByRole('combobox', { name: 'Approval requests' })).toBeDisabled()
    expect(screen.getByRole('alert')).toHaveTextContent('Read back this save first')
  })
})

it('moves access guidance into a hint while keeping save failures visible', async () => {
  render(<OperatorAccessPicker value={DEFAULT_HARNESS_DEFAULTS.codex} disabled={false}
    saveError="Read back this save first" onChange={vi.fn()} />)
  const guidance = 'Access changes apply to new chats and harness handoffs. Existing chats keep their accepted access policy.'
  expect(screen.queryByText(guidance)).not.toBeInTheDocument()
  fireEvent.focus(screen.getByRole('button', { name: 'About Operator access' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent(guidance)
  expect(screen.getByRole('alert')).toHaveTextContent('Read back this save first')
})
