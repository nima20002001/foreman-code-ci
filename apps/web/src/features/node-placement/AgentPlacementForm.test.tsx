import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { vi } from 'vitest'
import { AgentSettingsForm } from '../graph/AgentSettingsForm'
import { AgentFormSchema } from '../graph/nextDraft/agentForm'
import { savedPlacementFixture as placement } from './fixtures'

it('keeps selection local until Apply and includes only this node placement in its callback', async () => {
  const save = vi.fn()
  const pc = { ...placement, hostRef: { kind: 'main' as const, mainId: placement.hostRef.mainId } }
  render(<QueryClientProvider client={new QueryClient()}><AgentSettingsForm embedded agent={{ id: 'shared-agent', name: 'Worker', harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex }}
    creationDefaults={DEFAULT_HARNESS_DEFAULTS} nodePlacement={placement} placementOptions={[{ label: 'Laptop', placement }, { label: 'PC', placement: pc }]}
    onClose={() => undefined} onSave={save} /></QueryClientProvider>)
  const apply = screen.getByRole('button', { name: 'Apply agent settings to draft' })
  expect(apply).toBeDisabled()
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), '1')
  expect(save).not.toHaveBeenCalled()
  expect(apply).toBeEnabled()
  await userEvent.click(apply)
  expect(save).toHaveBeenCalledOnce()
  expect(save.mock.calls[0]?.[4]).toEqual(pc)
  expect(save.mock.calls[0]?.[0]).not.toHaveProperty('placement')
})
it('preserves the exact placement revisions in retained form storage', () => {
  const form = AgentFormSchema.parse({ base: '{}', name: 'Worker', prompt: '', editor: { configuration: DEFAULT_HARNESS_DEFAULTS.codex, shellEnvironmentText: '{}', mcpText: '{}' }, placement })
  expect(AgentFormSchema.parse(JSON.parse(JSON.stringify(form))).placement).toEqual(placement)
})
