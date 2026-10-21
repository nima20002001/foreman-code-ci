import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { ClaudeConfigurationFields } from './ClaudeConfigurationFields'
import { HarnessMcpPolicies } from './HarnessMcpPolicies'
import { HarnessDirectoryPicker } from './HarnessDirectoryPicker'
import { SettingsFormFeedback } from './SettingsFormActions'
import { savedClaudeConfiguration } from './claudeSettings.fixtures'
import { createHarnessEditor } from './harnessEditor'

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})
function mount(children: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}>{children}</QueryClientProvider>)
}

it('shows model and profile help on demand while keeping qualification and field errors visible', () => {
  mount(<ClaudeConfigurationFields value={savedClaudeConfiguration} onChange={vi.fn()} models={[]}
    qualified={false} issues={[{ path: ['model'], message: 'Choose an available model.' }]} />)
  expect(screen.getByRole('textbox', { name: 'Model' })).toHaveValue(savedClaudeConfiguration.model)
  expect(screen.getByText('Choose an available model.')).toBeVisible()
  expect(screen.getByText('Claude profile is not verified')).toBeVisible()
  expect(screen.getByText('Check the saved profile in computer settings.')).toBeVisible()
  expect(screen.queryByText('An explicit model choice; saving it does not prove native model availability.'))
    .not.toBeInTheDocument()
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'About Model' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('saving it does not prove native model availability')
  fireEvent.focus(screen.getByRole('button', { name: 'About Local Claude profile directory' }))
  expect(screen.getByRole('button', { name: 'About Local Claude profile directory' }))
    .toHaveAccessibleDescription('Sign in on the selected computer using this profile.')
})

it('moves tool explanations to hints without hiding saved tool names or changing permissions', () => {
  mount(<HarnessMcpPolicies editor={createHarnessEditor(savedClaudeConfiguration)} onChange={vi.fn()} />)
  expect(screen.queryByText(/Enable exact tool names deliberately/)).not.toBeInTheDocument()
  expect(screen.getByRole('combobox', { name: 'Bash approval' })).toHaveValue('ask')
  expect(screen.getByRole('combobox', { name: 'Read approval' })).toHaveValue('allow')
  fireEvent.mouseEnter(screen.getByRole('button', { name: 'About Enabled Claude tools' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('MCP tools use mcp__server__tool')
  fireEvent.focus(screen.getByRole('button', { name: 'About Tool permissions' }))
  expect(screen.getByRole('button', { name: 'About Tool permissions' }))
    .toHaveAccessibleDescription('These permissions belong to the saved configuration. App grants and the selected sandbox are checked separately.')
})

it('keeps folder validation visible and explains the workspace default beside Additional folders', () => {
  mount(<HarnessDirectoryPicker value={[]} onChange={vi.fn()} error="Choose a writable folder." />)
  expect(screen.getByRole('alert')).toHaveTextContent('Choose a writable folder.')
  expect(screen.queryByText('Only the current workspace is added.')).not.toBeInTheDocument()
  fireEvent.focus(screen.getByRole('button', { name: 'About Additional folders' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Only the current workspace is added.')
  expect(screen.getByRole('button', { name: 'Browse folders' })).toBeEnabled()
})

it('uses one saved confirmation and preserves the warning for newer unsaved edits', () => {
  const form = { isDirty: false, isSaving: false, uncertain: false, conflicted: false,
    savedRevision: 2, serverChanges: [], localChanges: [], reset: vi.fn(), reapply: vi.fn() }
  const view = render(<SettingsFormFeedback form={form} />)
  expect(screen.getByText('Changes saved to the server')).toBeVisible()
  expect(screen.queryByText('Changes are saved to the server.')).not.toBeInTheDocument()
  view.rerender(<SettingsFormFeedback form={{ ...form, isDirty: true }} />)
  expect(screen.getByText('Earlier changes saved')).toBeVisible()
  expect(screen.getByText('Newer edits are still unsaved.')).toBeVisible()
})
