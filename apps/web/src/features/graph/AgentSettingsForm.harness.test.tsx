import { DEFAULT_HARNESS_DEFAULTS, type HarnessDefaults } from '@foreman-code/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { queryKeys } from '../../shared/api/query'
import { defaultAgentForHarness } from '../agents/agentSettings'
import { savedClaudeConfiguration } from '../settings/claudeSettings.fixtures'
import { AgentSettingsForm } from './AgentSettingsForm'

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

function setup(defaults: HarnessDefaults, discoveryError: { code: string; message: string } | null = null,
  harness: 'claude' | 'codex' = 'claude', saved: NonNullable<HarnessDefaults['claude']> = savedClaudeConfiguration) {
  const catalog = Object.values(defaults).map(configuration => ({
    harness: configuration.harness, defaults: configuration, defaultsRevision: 1, capability: null,
    discoveryError: configuration.harness === 'claude' ? discoveryError : null,
  }))
  server.use(http.get('/api/management/harnesses', () => HttpResponse.json(catalog)))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  client.setQueryData(queryKeys.managedHarnessCatalog, catalog)
  const configuration = harness === 'claude' ? saved : defaults.codex
  const agent = defaultAgentForHarness(harness, 'saved-agent', 'Main coordinator', configuration)
  const onSave = vi.fn()
  const view = render(<QueryClientProvider client={client}>
    <AgentSettingsForm agent={agent} onClose={() => undefined} onSave={onSave} />
  </QueryClientProvider>)
  return { client, onSave, agent, user: userEvent.setup(), view }
}

it('shows the saved native tools policy and retains it on a metadata save', async () => {
  const { client, agent, onSave, user, view } = setup(DEFAULT_HARNESS_DEFAULTS, null, 'codex')
  const saved = { ...agent, nativeTools: { mcpServers: ['linear'], apps: false } }
  view.rerender(<QueryClientProvider client={client}>
    <AgentSettingsForm agent={saved} onClose={() => undefined} onSave={onSave} />
  </QueryClientProvider>)
  expect(screen.getByText('Native tools: Foreman Code, linear; apps off')).toBeVisible()
  await user.type(screen.getByRole('textbox', { name: 'Name' }), ' renamed')
  await user.click(screen.getByRole('button', { name: 'Save agent settings' }))
  expect(onSave.mock.calls[0]![0].nativeTools).toEqual(saved.nativeTools)
})

it.each(['missing', 'incomplete', 'unavailable'] as const)(
  'shows saved Claude when its preset is %s and preserves it on a name-only save', async availability => {
    const defaults = structuredClone(DEFAULT_HARNESS_DEFAULTS)
    let error = null
    if (availability !== 'missing') {
      defaults.claude = { ...savedClaudeConfiguration,
        sandbox: availability === 'incomplete' ? 'read-only' : 'danger-full-access' }
      error = { code: 'HARNESS_MODEL_DEFAULT_UNAVAILABLE', message: 'Choose a native model in Settings.' }
      if (availability === 'incomplete') {
        error = { code: 'CLAUDE_FULL_ACCESS_REQUIRED', message: 'Claude requires Full access.' }
      }
    }
    const { onSave, agent, user } = setup(defaults, error)
    const selector = screen.getByRole('combobox', { name: 'Harness' })
    expect(selector).toHaveValue('claude')
    expect(screen.getByRole('option', { name: /^Claude/ })).toBeDisabled()
    expect(selector).toHaveAccessibleDescription(expect.stringContaining('Saved agent settings are kept.'))
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Renamed coordinator')
    await user.click(screen.getByRole('button', { name: 'Save agent settings' }))
    expect(onSave).toHaveBeenCalledOnce()
    expect(onSave.mock.calls[0]![0]).toMatchObject({ name: 'Renamed coordinator', harness: 'claude',
      harnessConfiguration: savedClaudeConfiguration })
    expect(agent.harnessConfiguration).toEqual(savedClaudeConfiguration)
  },
)

it('keeps the saved harness visible when preset loading fails', async () => {
  const { client, user, onSave } = setup(DEFAULT_HARNESS_DEFAULTS)
  server.use(http.get('/api/management/harnesses', () => HttpResponse.json(
    { error: { code: 'ACCESS_DENIED', message: 'Provider presets could not be loaded.' } }, { status: 403 },
  )))
  await client.invalidateQueries({ queryKey: queryKeys.managedHarnessCatalog })
  const selector = screen.getByRole('combobox', { name: 'Harness' })
  expect(selector).toHaveValue('claude')
  await waitFor(() => expect(selector).toHaveAccessibleDescription(
    expect.stringContaining('Provider presets could not be loaded.'),
  ))
  await user.type(screen.getByRole('textbox', { name: 'Name' }), ' updated')
  await user.click(screen.getByRole('button', { name: 'Save agent settings' }))
  expect(onSave.mock.calls[0]![0]).toMatchObject({ harness: 'claude', harnessConfiguration: savedClaudeConfiguration })
})

it('requires unsupported saved Claude access to be corrected without substituting another harness', async () => {
  const unsupported = { ...savedClaudeConfiguration, sandbox: 'read-only' as const }
  const { user, onSave } = setup(DEFAULT_HARNESS_DEFAULTS, null, 'claude', unsupported)
  const selector = screen.getByRole('combobox', { name: 'Harness' })
  expect(selector).toHaveValue('claude')
  await user.type(screen.getByRole('textbox', { name: 'Name' }), ' updated')
  await user.click(screen.getByRole('button', { name: 'Save agent settings' }))
  expect(onSave).not.toHaveBeenCalled()
  expect(screen.getByRole('combobox', { name: 'Sandbox' })).toHaveAttribute('aria-invalid', 'true')
  expect(selector).toHaveValue('claude')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Sandbox' }), 'danger-full-access')
  await user.click(screen.getByRole('button', { name: 'Save agent settings' }))
  expect(onSave.mock.calls[0]![0]).toMatchObject({ harness: 'claude', harnessConfiguration: savedClaudeConfiguration })
})

it('offers configured Claude before native qualification and switches only after an explicit selection', async () => {
  const { user, onSave } = setup({ ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration },
    { code: 'CLAUDE_PROFILE_SELECTION_REQUIRED', message: 'Check the saved Claude host profile.' }, 'codex')
  const selector = screen.getByRole('combobox', { name: 'Harness' })
  expect(selector).toHaveValue('codex')
  expect(screen.getByRole('option', { name: 'Claude' })).toBeEnabled()
  await user.selectOptions(selector, 'claude')
  expect(selector).toHaveValue('claude')
  await user.click(screen.getByRole('button', { name: 'Save agent settings' }))
  expect(onSave.mock.calls[0]![0]).toMatchObject({ harness: 'claude', harnessConfiguration: savedClaudeConfiguration })
})

it('restores the saved Claude draft after switching away even without a global Claude preset', async () => {
  const { user, onSave } = setup(DEFAULT_HARNESS_DEFAULTS)
  await user.clear(screen.getByRole('textbox', { name: 'Local Claude profile directory' }))
  await user.type(screen.getByRole('textbox', { name: 'Local Claude profile directory' }), '/edited/profile')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Harness' }), 'codex')
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Harness' })).toHaveValue('codex'))
  expect(screen.getByRole('option', { name: 'Claude' })).toBeEnabled()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Harness' }), 'claude')
  expect(screen.getByRole('textbox', { name: 'Local Claude profile directory' })).toHaveValue('/edited/profile')
  await user.click(screen.getByRole('button', { name: 'Save agent settings' }))
  expect(onSave.mock.calls[0]![0]).toMatchObject({ harness: 'claude',
    harnessConfiguration: { ...savedClaudeConfiguration, configDirectory: '/edited/profile' } })
})
