import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { BrowserProfilesSettings } from './BrowserProfilesSettings'
import type { BrowserProfileCatalog, BrowserProfilesPort, BrowserProfileSyncJob } from './types'
import { browserFilesFake, browserPortFake, browserRead, deferred } from '../agent-browser/testFixtures'

function profileFixture() {
  const data: BrowserProfileCatalog = { profiles: [{ id: 'profile', name: 'Work', sourceComputerId: 'main',
    distribution: 'shared', revision: 1, publishedRevision: 0 }], replicas: [
    { profileId: 'profile', computerId: 'main', desiredSnapshot: null, receivedSnapshot: null, appliedSnapshot: null,
      transfer: 'missing', loginEvidence: [], localOverride: false, lastSeenAt: '2026-10-20T00:00:00.000Z', reason: null },
    { profileId: 'profile', computerId: 'worker', desiredSnapshot: null, receivedSnapshot: null, appliedSnapshot: null,
      transfer: 'local_only', loginEvidence: [], localOverride: true, lastSeenAt: '2026-10-20T00:00:00.000Z', reason: null },
  ], presentReplicas: [{ profileId: 'profile', computerId: 'main' }, { profileId: 'profile', computerId: 'worker' }], pendingReplicas: [] }
  const job: BrowserProfileSyncJob = { id: 'sync', commandId: 'sync-command', state: 'completed', profiles: [], targets: [], revision: 1,
    createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z' }
  const port: BrowserProfilesPort = {
    readCatalog: vi.fn(async () => structuredClone(data)), create: vi.fn(async () => data.profiles[0]!),
    addExisting: vi.fn(async () => ({ state: 'first_snapshot_pending' as const, replica: data.replicas[1]! })),
    update: vi.fn(async () => data.profiles[0]!), setLocalOverride: vi.fn(async (_profile, computerId, localOverride) => {
      const replica = data.replicas.find(value => value.computerId === computerId)!
      replica.localOverride = localOverride
      return structuredClone(replica)
    }), confirmLogin: vi.fn(async () => data.replicas[0]!), remove: vi.fn(async () => 'removed' as const),
    openSetup: vi.fn(async () => ({ ...browserRead().session, subject: undefined, setupForProfileId: 'profile' })),
    closeSetup: vi.fn(async () => 'closed' as const),
    sync: vi.fn(async () => structuredClone(job)), readSync: vi.fn(async () => structuredClone(job)),
  }
  return { port, data, job }
}

function mount(port: BrowserProfilesPort, onOpenSetup = vi.fn(), onSetupCleanupPending = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><BrowserProfilesSettings visible authBoundary="login" currentComputerId="main"
    computers={[{ id: 'main', name: 'Main', online: true, runtimeReady: true, lastSeenAt: null },
      { id: 'worker', name: 'Worker', online: true, runtimeReady: true, lastSeenAt: null }]}
    port={port} sessionPort={browserPortFake().port} files={browserFilesFake()}
    onOpenSetup={onOpenSetup} onSetupCleanupPending={onSetupCleanupPending} /></QueryClientProvider>)
}

it('saves clearing local override without admitting sync, then only a separate sync click creates a job', async () => {
  const { port, data } = profileFixture()
  const view = mount(port)
  const worker = within(await screen.findByRole('region', { name: 'Browser profiles on Worker' }))
  await userEvent.click(worker.getByRole('button', { name: 'Use source updates' }))
  await waitFor(() => expect(port.setLocalOverride).toHaveBeenCalledWith('profile', 'worker', false, expect.any(String)))
  expect(port.sync).not.toHaveBeenCalled()
  expect(data.replicas[1]!.transfer).toBe('local_only')
  expect((await screen.findAllByText('Source updates enabled — sync to apply')).length).toBeGreaterThan(0)
  view.unmount(); mount(port)
  const revisited = within(await screen.findByRole('region', { name: 'Browser profiles on Worker' }))
  expect(revisited.getByText('Source updates enabled — sync to apply')).toBeVisible()
  await userEvent.click(revisited.getByRole('button', { name: 'Sync profile' }))
  await waitFor(() => expect(port.sync).toHaveBeenCalledWith(['profile'], expect.any(String)))
})

it('retains a saved override policy when sync admission fails and retries the identical command', async () => {
  const { port, job } = profileFixture()
  vi.mocked(port.sync).mockRejectedValueOnce(new Error('connection lost')).mockResolvedValue(job)
  mount(port)
  const worker = within(await screen.findByRole('region', { name: 'Browser profiles on Worker' }))
  await userEvent.click(worker.getByRole('button', { name: 'Use source updates' }))
  await waitFor(() => expect(worker.getByRole('button', { name: 'Sync profile' })).toBeEnabled())
  await userEvent.click(worker.getByRole('button', { name: 'Sync profile' }))
  await screen.findByText(/No new operation is confirmed/)
  expect(screen.queryByText('Sync queued')).not.toBeInTheDocument()
  expect((await screen.findAllByText('Source updates enabled — sync to apply')).length).toBeGreaterThan(0)
  await userEvent.click(screen.getByRole('button', { name: 'Check original request' }))
  await waitFor(() => expect(port.sync).toHaveBeenCalledTimes(2))
  expect(vi.mocked(port.sync).mock.calls[1]).toEqual(vi.mocked(port.sync).mock.calls[0])
})

it('opens a newly created source profile before its first snapshot publication and never changes override merely by opening', async () => {
  const { port } = profileFixture(), opened = vi.fn()
  mount(port, opened)
  const main = within(await screen.findByRole('region', { name: 'Browser profiles on Main' }))
  await userEvent.click(main.getByRole('button', { name: 'Open browser' }))
  await waitFor(() => expect(opened).toHaveBeenCalled())
  expect(port.setLocalOverride).not.toHaveBeenCalled()
  expect(port.sync).not.toHaveBeenCalled()
  expect(main.getByRole('button', { name: 'Remove from this computer' })).toBeEnabled()
})

it('does not open a late setup session after the settings page retires', async () => {
  const { port } = profileFixture(), pending = deferred<Awaited<ReturnType<BrowserProfilesPort['openSetup']>>>(), opened = vi.fn()
  vi.mocked(port.openSetup).mockReturnValue(pending.promise)
  const view = mount(port, opened)
  const main = within(await screen.findByRole('region', { name: 'Browser profiles on Main' }))
  await userEvent.click(main.getByRole('button', { name: 'Open browser' }))
  view.unmount(); pending.resolve({ ...browserRead().session, subject: undefined, setupForProfileId: 'profile' })
  await pending.promise
  expect(opened).not.toHaveBeenCalled()
  await waitFor(() => expect(port.closeSetup).toHaveBeenCalledWith(expect.objectContaining({ setupForProfileId: 'profile' }), expect.any(String)))
})

it('does not reopen a removed source merely because its source identity and snapshot metadata remain', async () => {
  const { port, data } = profileFixture()
  data.presentReplicas = data.presentReplicas.filter(copy => copy.computerId !== 'main')
  mount(port)
  const main = within(await screen.findByRole('region', { name: 'Browser profiles on Main' }))
  expect(main.getByRole('button', { name: 'Open browser' })).toBeDisabled()
  expect(main.queryByRole('button', { name: 'Remove from this computer' })).not.toBeInTheDocument()
})

it('adds an existing profile only to the chosen computer and reports first snapshot waiting without syncing all computers', async () => {
  const { port } = profileFixture()
  mount(port)
  const worker = within(await screen.findByRole('region', { name: 'Browser profiles on Worker' }))
  await userEvent.click(worker.getByRole('button', { name: 'Add profile here' }))
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Profile choice' }), 'existing')
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Existing profile' }), 'profile')
  await userEvent.click(screen.getByRole('button', { name: 'Add existing profile' }))
  await waitFor(() => expect(port.addExisting).toHaveBeenCalledWith('profile', 'worker', expect.any(String)))
  expect(await screen.findByText(/Waiting for the first source snapshot/)).toBeVisible()
  expect(port.create).not.toHaveBeenCalled(); expect(port.sync).not.toHaveBeenCalled()
})

it('preserves confirmed native presence while removal waits, and blocks opening until the host settles it', async () => {
  const { port, data } = profileFixture()
  data.pendingReplicas.push({ profileId: 'profile', computerId: 'main', operation: 'remove', state: 'queued', reason: null })
  mount(port)
  const main = within(await screen.findByRole('region', { name: 'Browser profiles on Main' }))
  expect(main.getByText('Removal queued — waiting for browser/computer')).toBeVisible()
  expect(main.getByRole('button', { name: 'Open browser' })).toBeDisabled()
  expect(main.getByRole('button', { name: 'Remove from this computer' })).toBeDisabled()
})
