import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import { vi } from 'vitest'
import * as client from './client'
import { usePlacementChoices } from './usePlacementChoices'
import { savedPlacementFixture as placement } from './fixtures'

const scope = { workspaceId: 'workspace-a', workflowId: 'workflow-a', nodeId: 'node-a', agentConfigurationVersionId: 'configuration-old' }
function Probe() {
  const query = usePlacementChoices(scope, 'visit-a')
  return <>{query.options.map((option) => <p key={option.label}>{option.label}: {option.unavailableReason ?? 'Ready'}</p>)}</>
}
it('keeps server unavailable reasons and never promotes discovery to a ready choice', async () => {
  const read = vi.spyOn(client, 'readPlacementChoices').mockResolvedValue({ ...scope, pending: false, choices: [
    { id: 'choice-a', label: 'Offline laptop', placement, availability: 'offline', reason: 'Worker disconnected' },
    { id: 'choice-b', label: 'Unavailable harness', placement, availability: 'unavailable', reason: 'Harness incompatible' },
    { id: 'choice-c', label: 'Ready PC', placement, availability: 'ready', reason: null },
  ] })
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={query}><Probe /></QueryClientProvider>)
  await screen.findByText('Offline laptop: Worker disconnected')
  expect(screen.getByText('Unavailable harness: Harness incompatible')).toBeInTheDocument()
  expect(screen.getByText('Ready PC: Ready')).toBeInTheDocument()
  expect(read.mock.calls[0]?.[0]).toEqual(scope)
  read.mockRestore()
  query.clear()
})
