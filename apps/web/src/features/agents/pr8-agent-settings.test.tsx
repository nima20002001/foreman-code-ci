// @vitest-environment jsdom
import { DEFAULT_HARNESS_DEFAULTS, HarnessConfigurationSchema, type Agent } from '@foreman-code/contracts'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AgentSettingsForm } from '../graph/AgentSettingsForm'
import { configuredHarness, defaultAgentForHarness } from './agentSettings'

afterEach(cleanup)

function renderWithQueryClient(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>)
}

describe('PR8 exact native settings in the actual form', () => {


  it.each(['read-only', 'danger-full-access'] as const)('explains and removes incompatible controls when changing to %s', async (sandbox) => {
    const configuration = structuredClone(DEFAULT_HARNESS_DEFAULTS.codex)
    configuration.sandbox = 'workspace-write'
    configuration.advanced!.additionalWritableDirectories = ['/tmp/project-extra']
    configuration.advanced!.workspaceWrite = { networkAccess: false, excludeTmpdirEnvVar: true, excludeSlashTmp: true }
    const agent = defaultAgentForHarness('codex', 'agent', 'Agent', configuration)
    const original = structuredClone(agent)
    const onSave = vi.fn()
    renderWithQueryClient(<AgentSettingsForm agent={agent} onClose={() => undefined} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText('Sandbox'), { target: { value: sandbox } })
    if (sandbox === 'danger-full-access') {
      await userEvent.setup().type(screen.getByLabelText('Type “full access” to confirm'), 'full access')
      await userEvent.setup().click(screen.getByRole('button', { name: 'Use full access' }))
    }
    fireEvent.click(screen.getByRole('button', { name: /^Advanced settings/ }))
    expect(screen.getByText(/Leaving workspace-write removes additional writable directories/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Save agent settings' }))
    const saved = onSave.mock.calls[0]![0] as Agent
    expect(HarnessConfigurationSchema.safeParse(saved.harnessConfiguration).success).toBe(true)
    expect(saved.harnessConfiguration).toMatchObject({ sandbox, advanced: { additionalWritableDirectories: [] } })
    expect(saved.harnessConfiguration?.harness === 'codex' ? saved.harnessConfiguration.advanced?.workspaceWrite : 'wrong harness').toBeUndefined()
    expect(agent).toEqual(original)
  })

  it('does not inherit later template edits into existing agent settings', () => {
    const template = structuredClone(DEFAULT_HARNESS_DEFAULTS.codex)
    template.model = 'copied-variant'
    const agent = defaultAgentForHarness('codex', 'agent', 'Agent', template)
    template.model = 'later-template-variant'
    expect(configuredHarness(agent, 'codex', agent.model!, 'medium', false, 'read-only'))
      .toMatchObject({ model: 'copied-variant' })
  })
})
