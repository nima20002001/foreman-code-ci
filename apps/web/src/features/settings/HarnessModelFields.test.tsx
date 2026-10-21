import { useState, type ReactElement } from 'react'
import { cleanup, render as renderComponent, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, type HarnessConfiguration } from '@foreman-code/contracts'
import { HarnessBasicFields } from './HarnessBasicFields'
import { savedClaudeConfiguration } from './claudeSettings.fixtures'

vi.mock('../provider-accounts/useProviderHarnessModels', () => ({
  useProviderHarnessModels: (harness: 'codex' | 'claude') => ({ data: { models: [
    { id: { codex: DEFAULT_HARNESS_DEFAULTS.codex.model, claude: savedClaudeConfiguration.model }[harness], name: 'Current native model', reasoningEfforts: ['medium', 'high'], variants: [''], serviceTiers: ['standard', 'priority'] },
    { id: 'long-model', name: 'A long native model label that remains searchable and selectable', reasoningEfforts: ['medium'], variants: ['balanced'], serviceTiers: ['standard'] },
  ], nativeAgents: ['build', 'plan'] }, isSuccess: true, isPending: false, isError: false, error: null }),
}))
vi.mock('../../shared/api/harnessSettings', async importOriginal => ({
  ...await importOriginal<typeof import('../../shared/api/harnessSettings')>(),
  useRefreshNativeHarness: () => ({ mutate: vi.fn(), isPending: false, isError: false, error: null }),
}))

beforeEach(() => { HTMLElement.prototype.scrollIntoView = vi.fn() })
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })
function render(component: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return renderComponent(<QueryClientProvider client={client}>{component}</QueryClientProvider>)
}
function BasicFields({ initial }: { initial: HarnessConfiguration }) {
  const [value, onChange] = useState(initial)
  return <HarnessBasicFields value={value} onChange={onChange} includeSandbox={false} />
}

it('shows an unset default and clears its warning after an explicit native model selection', async () => {
  const user = userEvent.setup()
  render(<BasicFields initial={{ ...DEFAULT_HARNESS_DEFAULTS.codex, model: '' }} />)
  expect(screen.getByText('Default model unavailable')).toBeVisible()
  const model = screen.getByRole('combobox', { name: 'Model' })
  await user.click(model)
  await user.type(model, 'long native model')
  await user.keyboard('{Enter}')
  expect(model).toHaveValue('A long native model label that remains searchable and selectable')
  expect(screen.queryByText('Default model unavailable')).not.toBeInTheDocument()
})

it('keeps long model labels searchable by keyboard and retains supported effort choices', async () => {
  const user = userEvent.setup()
  render(<BasicFields initial={DEFAULT_HARNESS_DEFAULTS.codex} />)
  await user.selectOptions(screen.getByRole('combobox', { name: 'Effort' }), 'high')
  const model = screen.getByRole('combobox', { name: 'Model' })
  await user.click(model)
  await user.type(model, 'long native model')
  await user.keyboard('{Enter}')
  expect(model).toHaveValue('A long native model label that remains searchable and selectable')
  expect(screen.getByRole('combobox', { name: 'Effort' })).toHaveValue('medium')
  expect(screen.getByRole('switch', { name: 'Fast mode' })).toBeDisabled()
})

it('allows an unavailable saved priority setting to be corrected through the compact switch', async () => {
  const user = userEvent.setup()
  render(<BasicFields initial={{ ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'long-model', serviceTier: 'priority' }} />)
  const fast = screen.getByRole('switch', { name: 'Fast mode' })
  expect(fast).toBeChecked()
  expect(fast).toHaveAccessibleDescription('Not offered by this model. Turn Fast mode off.')
  await user.click(fast)
  expect(fast).not.toBeChecked()
  expect(fast).toBeDisabled()
  expect(screen.queryByText('Not offered by this model. Turn Fast mode off.')).not.toBeInTheDocument()
})
