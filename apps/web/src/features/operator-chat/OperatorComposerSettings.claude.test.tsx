import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, operatorChatSettings, type HarnessDefaults, type HarnessConfiguration } from '@foreman-code/contracts'
import { queryKeys } from '../../shared/api/query'
import { savedClaudeConfiguration } from '../settings/claudeSettings.fixtures'
import { OperatorComposerSettings } from './OperatorComposerSettings'

vi.mock('../provider-accounts/useProviderHarnessModels', () => ({
  useProviderHarnessModels: () => ({
  data: { models: [{ id: savedClaudeConfiguration.model, name: 'Saved Claude', variants: [], reasoningEfforts: [], serviceTiers: [] },
    { id: 'verified-claude-model', name: 'Verified Claude', variants: [], reasoningEfforts: [], serviceTiers: [] },
    { id: 'medium-claude-model', name: 'Medium Claude', variants: [], reasoningEfforts: ['low', 'medium', 'high'], serviceTiers: [] }] },
  isSuccess: true, isPending: false, isError: false,
}) }))
const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear() })
function mount(defaults: HarnessDefaults, selected: HarnessConfiguration = savedClaudeConfiguration) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  client.setQueryData(queryKeys.managedHarnessCatalog, Object.entries(defaults).map(([harness, defaults]) =>
    ({ harness, defaults, defaultsRevision: 1, capability: null, discoveryError: null })))
  clients.push(client)
  const onChange = vi.fn()
  render(<QueryClientProvider client={client}><OperatorComposerSettings value={operatorChatSettings(selected)} onChange={onChange} disabled={false} /></QueryClientProvider>)
  return onChange
}
it('changes the Claude model while keeping unavailable Fast mode disabled', async () => {
  const onChange = mount({ ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration })
  const user = userEvent.setup()
  const trigger = screen.getByRole('button', { name: 'Agent settings: Saved Claude' })
  expect(trigger).not.toHaveTextContent('default')
  await user.click(trigger)
  expect(screen.queryByRole('slider', { name: 'Effort' })).not.toBeInTheDocument()
  expect(screen.getByRole('switch', { name: 'Fast mode' })).toBeDisabled()
  expect(screen.getByRole('radio', { name: 'Claude' })).toBeChecked()
  await user.click(screen.getByRole('button', { name: /Saved Claude\s*Choose model/ }))
  await user.click(screen.getByRole('button', { name: /Verified Claude\s*verified-claude-model/ }))
  expect(onChange).toHaveBeenCalledWith({ harness: 'claude', model: 'verified-claude-model', showThinking: false })
})
it('uses supported medium Claude effort on model selection and exposes its editable effort', async () => {
  const defaults = { ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration }
  const onChange = mount(defaults)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /Agent settings:/ }))
  await user.click(screen.getByRole('button', { name: /Saved Claude\s*Choose model/ }))
  await user.click(screen.getByRole('button', { name: /Medium Claude\s*medium-claude-model/ }))
  expect(onChange).toHaveBeenCalledWith({ harness: 'claude', model: 'medium-claude-model', effort: 'medium', showThinking: false })
  cleanup()
  const change = mount(defaults, { ...savedClaudeConfiguration, model: 'medium-claude-model', effort: 'medium' })
  await user.click(screen.getByRole('button', { name: 'Agent settings: Medium Claude, medium' }))
  fireEvent.change(screen.getByRole('slider', { name: 'Effort' }), { target: { value: '2' } })
  expect(change).toHaveBeenCalledWith({ harness: 'claude', model: 'medium-claude-model', effort: 'high', showThinking: false })
})
it('omits the previous effort when switching a reasoning model to a native-default-only model', async () => {
  const defaults = { ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration }
  const onChange = mount(defaults, { ...savedClaudeConfiguration, model: 'medium-claude-model', effort: 'medium' })
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Agent settings: Medium Claude, medium' }))
  await user.click(screen.getByRole('button', { name: /Medium Claude\s*Choose model/ }))
  await user.click(screen.getByRole('button', { name: /Verified Claude\s*verified-claude-model/ }))
  expect(onChange).toHaveBeenCalledWith({ harness: 'claude', model: 'verified-claude-model', showThinking: false })
})
it('disables choosing Claude when no actual provider preset exists', async () => {
  mount(DEFAULT_HARNESS_DEFAULTS)
  await userEvent.setup().click(screen.getByRole('button', { name: /Agent settings:/ }))
  expect(screen.getByRole('radio', { name: 'Claude' })).toBeDisabled()
  expect(screen.queryByText('Configure a Claude profile in Harness settings before switching to Claude.')).not.toBeInTheDocument()
})

it('switches to Claude only through its actual saved provider preset', async () => {
  const onChange = mount({ ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration }, DEFAULT_HARNESS_DEFAULTS.codex)
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /Agent settings:/ }))
  await user.click(screen.getByRole('radio', { name: 'Claude' }))
  expect(onChange).toHaveBeenCalledWith(operatorChatSettings(savedClaudeConfiguration))
})

it('keeps the model chooser accessible without a repeated caption', async () => {
  mount({ ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration })
  await userEvent.click(screen.getByRole('button', { name: 'Agent settings: Saved Claude' }))
  expect(screen.getByRole('button', { name: /Saved Claude\s*Choose model/ })).toBeEnabled()
  expect(screen.queryByText('Choose model')).not.toBeInTheDocument()
})
