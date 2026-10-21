import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, vi } from 'vitest'
import { ApiError } from '../../shared/api/client'
import { beginSessionChange, finishSessionChange } from '../../shared/api/sessionBoundary'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { SelectedNodePlacement } from './SelectedNodePlacement'
import * as client from './client'
import { acceptedPlacementFixture as placement, workerObservationFixture as observation } from './fixtures'

const scope = { workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a', nodeId: 'node-a' }
function selection(id: number, current: () => boolean): SelectedRunState {
  return { identity: { workspaceId: scope.workspaceId, workflowId: scope.workflowId, runId: scope.runId }, generation: { id }, active: true,
    invalid: false, isCurrent: current } as unknown as SelectedRunState
}
function result() { return { ...scope, readback: { evidence: 'accepted' as const, placement, observations: [] } } }
const clients: QueryClient[] = []
afterEach(() => { clients.splice(0).forEach((item) => item.clear()); vi.restoreAllMocks() })
function wrap() {
  const query = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(query)
  return ({ children }: { children: React.ReactNode }) => <QueryClientProvider client={query}>{children}</QueryClientProvider>
}
it('fences late A→B→A reads by visit even when transport ignores abort', async () => {
  let visit = 1
  let release!: (value: ReturnType<typeof result>) => void
  const oldRead = new Promise<ReturnType<typeof result>>((resolve) => { release = resolve })
  const read = vi.spyOn(client, 'readNodePlacement').mockImplementationOnce(() => oldRead).mockResolvedValue({ ...scope, readback: { evidence: 'legacy_missing', originalMainInstallationId: null } })
  const view = render(<SelectedNodePlacement selection={selection(1, () => visit === 1)} nodeId="node-a" />, { wrapper: wrap() })
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  visit = 2
  view.rerender(<SelectedNodePlacement selection={selection(2, () => visit === 2)} nodeId="node-a" />)
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2))
  visit = 3
  view.rerender(<SelectedNodePlacement selection={selection(3, () => visit === 3)} nodeId="node-a" />)
  await screen.findByText(/Computer evidence unavailable/)
  await act(async () => { release(result()); await oldRead })
  expect(screen.queryByText('Laptop at acceptance')).not.toBeInTheDocument()
})
it('withdraws private facts after a denied read', async () => {
  const read = vi.spyOn(client, 'readNodePlacement').mockResolvedValue(result())
  const view = render(<SelectedNodePlacement selection={selection(1, () => true)} nodeId="node-a" />, { wrapper: wrap() })
  await screen.findByText('Laptop at acceptance')
  read.mockRejectedValue(new ApiError({ code: 'DENIED', message: 'No access' }, 403))
  view.rerender(<SelectedNodePlacement selection={selection(2, () => true)} nodeId="node-a" />)
  await screen.findByText(/No access/)
  expect(screen.queryByText('Laptop at acceptance')).not.toBeInTheDocument()
})
it('a response from a prior Operator session cannot reveal placement', async () => {
  let release!: (value: ReturnType<typeof result>) => void
  const pending = new Promise<ReturnType<typeof result>>((resolve) => { release = resolve })
  const read = vi.spyOn(client, 'readNodePlacement').mockImplementation(() => pending)
  const view = render(<SelectedNodePlacement selection={selection(1, () => true)} nodeId="node-a" />, { wrapper: wrap() })
  await waitFor(() => expect(read).toHaveBeenCalledTimes(1))
  beginSessionChange()
  await act(async () => { release(result()); await pending })
  view.rerender(<SelectedNodePlacement selection={selection(1, () => true)} nodeId="node-a" />)
  expect(screen.queryByText('Laptop at acceptance')).not.toBeInTheDocument()
  finishSessionChange()
})

it('refreshes open computer evidence as execution starts, finishes and reconnects', async () => {
  const read = vi.spyOn(client, 'readNodePlacement').mockResolvedValue(result())
  render(<SelectedNodePlacement selection={selection(1, () => true)} nodeId="node-a" />, { wrapper: wrap() })
  await screen.findByText(/Awaiting worker acknowledgment/)
  const running = { ...observation, phase: 'running' as const, sequence: '2' }
  read.mockResolvedValue({ ...scope, readback: { evidence: 'accepted', placement, observations: [running] } })
  await screen.findByText('Execution observed on Laptop at acceptance · running', {}, { timeout: 5000 })
  read.mockResolvedValue({ ...scope, readback: { evidence: 'accepted', placement,
    observations: [running, { ...observation, phase: 'terminal', sequence: '3' }] } })
  await screen.findByText('Execution observed on Laptop at acceptance · terminal', {}, { timeout: 5000 })
  read.mockResolvedValue({ ...scope, readback: { evidence: 'accepted', placement,
    observations: [running, { ...observation, phase: 'terminal', sequence: '4',
      connection: { ...observation.connection, connectionGeneration: 2,
        bootId: '70000000-0000-4000-8000-000000000001' },
      native: { processId: 123, exitCode: 0 } }] } })
  await screen.findByText('123', {}, { timeout: 5000 })
  expect(screen.getByText('Execution observed on Laptop at acceptance · terminal')).toBeInTheDocument()
}, 16000)

it('withdraws loaded facts after a delayed permission-loss refresh', async () => {
  let reject!: (error: Error) => void
  const denied = new Promise<ReturnType<typeof result>>((_resolve, fail) => { reject = fail })
  const read = vi.spyOn(client, 'readNodePlacement').mockResolvedValueOnce(result()).mockImplementation(() => denied)
  render(<SelectedNodePlacement selection={selection(1, () => true)} nodeId="node-a" />, { wrapper: wrap() })
  await screen.findByText('Laptop at acceptance')
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2), { timeout: 5000 })
  await act(async () => { reject(new ApiError({ code: 'DENIED', message: 'No access' }, 403)) })
  await screen.findByText(/No access/)
  expect(screen.queryByText('Laptop at acceptance')).toBeNull()
}, 8000)

it('does not attribute a delayed replacement Worker observation to the accepted installation', async () => {
  let release!: (value: ReturnType<typeof result>) => void
  const delayed = new Promise<ReturnType<typeof result>>(resolve => { release = resolve })
  vi.spyOn(client, 'readNodePlacement').mockImplementation(() => delayed)
  render(<SelectedNodePlacement selection={selection(1, () => true)} nodeId="node-a" />, { wrapper: wrap() })
  await act(async () => { release({ ...scope, readback: { evidence: 'accepted', placement, observations: [{
    ...observation, phase: 'running', sequence: '2',
    connection: { ...observation.connection, workerInstallationId: '60000000-0000-4000-8000-000000000001' },
  }] } } as ReturnType<typeof result>) })
  await screen.findByText('Laptop at acceptance')
  expect(screen.queryByText(/Execution observed on/)).toBeNull()
  expect(screen.getByText(/Awaiting worker acknowledgment/)).toBeInTheDocument()
})
