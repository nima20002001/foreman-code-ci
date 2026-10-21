import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { HarnessSettingsSection } from '@foreman-code/contracts/management'
import { HarnessConfigurationFields } from './HarnessConfigurationFields'
import { createHarnessEditor } from './harnessEditor'
import { savedClaudeConfiguration } from './claudeSettings.fixtures'

const state = vi.hoisted(() => ({ current: true, fetching: false, success: false, error: false }))
const profileError = 'Check the saved Claude host profile before using this configuration.'
vi.mock('../../shared/api/harnessSettings', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api/harnessSettings')>(),
  useRefreshNativeHarness: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
  useAutomaticHarnessCheck: () => ({ current: state.current, result: {
    isFetching: state.fetching, isSuccess: state.success, isError: state.error, error: { message: profileError },
  } }),
}))
vi.mock('../provider-accounts/useProviderHarnessModels', () => ({
  useProviderHarnessModels: () => ({
    data: { models: [{ id: 'claude-saved-model', name: 'Saved Claude model', reasoningEfforts: ['medium'] }] },
    isSuccess: true, isPending: false, isError: false, error: null,
  }),
}))
const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
  Object.assign(state, { current: true, fetching: false, success: false, error: false })
})
function show(section: HarnessSettingsSection = 'model', sandbox = savedClaudeConfiguration.sandbox) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><HarnessConfigurationFields allowHarnessChange={false}
    editor={createHarnessEditor({ ...savedClaudeConfiguration, sandbox })} onChange={vi.fn()} section={section} /></QueryClientProvider>)
}

it.each(['model', 'permissions', 'session'] as const)('shows one actionable profile error in the Claude %s section', section => {
  state.error = true
  show(section)
  expect(screen.getAllByText(profileError)).toHaveLength(1)
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  expect(screen.queryByText('Claude profile is not verified')).not.toBeInTheDocument()
  expect(screen.queryByText('Tool approvals use app routing. Native settings, hooks, plugins and agents are excluded from the accepted configuration.')).not.toBeInTheDocument()
})

it('shows current verified readiness without an instruction to check the profile again', () => {
  state.success = true
  show()
  expect(screen.getByText('Ready')).toBeVisible()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  expect(screen.queryByText(profileError)).not.toBeInTheDocument()
  expect(screen.queryByText('Check the saved profile in computer settings.')).not.toBeInTheDocument()
})

it('keeps pending readiness and does not show a premature profile warning', () => {
  state.fetching = true
  show()
  expect(screen.getByText('Checking the selected Claude configuration…')).toBeVisible()
  expect(screen.queryByText('Ready')).not.toBeInTheDocument()
  expect(screen.queryByRole('alert')).not.toBeInTheDocument()
})

it('does not reuse an earlier successful check for a changed configuration', () => {
  state.current = false
  state.success = true
  show()
  expect(screen.getByText('Claude profile is not verified')).toBeVisible()
  expect(screen.getAllByText('Check the saved profile in computer settings.')).toHaveLength(1)
  expect(screen.queryByText('Ready')).not.toBeInTheDocument()
})

it.each([['read-only', 'Read only · unsupported'], ['workspace-write', 'Workspace write · unsupported'], ['danger-full-access', 'Full access']] as const)(
  'preserves the selected %s sandbox while showing qualification guidance', (sandbox, label) => {
    show('model', sandbox)
    expect(screen.getByRole('combobox', { name: 'Sandbox' })).toHaveValue(sandbox)
    expect(screen.getByRole('combobox', { name: 'Sandbox' })).toHaveDisplayValue(label)
    expect(screen.queryByText('Ready')).not.toBeInTheDocument()
  },
)
