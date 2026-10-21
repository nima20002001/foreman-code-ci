import { screen, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { ComputerSyncUpdateInput } from '@foreman-code/contracts/computer-accounts'
import { GeneralSettings } from './GeneralSettings'
import { computersFixture, mainTarget, deviceTarget, deviceName } from '../computers/computersTestFixture'

it('shows each computer’s workspace files and saves its own sync preference on Main', async () => {
  const writes: ComputerSyncUpdateInput[] = []
  let workerEnabled = true
  const status = (target: typeof mainTarget | typeof deviceTarget) => {
    const main = target.hostRef.kind === 'main'
    return { target, installed: main ? true : null, running: main ? true : null,
      message: main ? null : 'This computer is offline.',
      folders: [{ workspaceId: 'workspace', name: 'Website', participating: true,
        enabled: main || workerEnabled, revision: main ? 2 : 7,
        status: main ? { workspaceId: 'workspace', path: '/main/shared/workspace',
          state: 'idle', connected: true, conflicts: [], message: null } : null }] }
  }
  computersFixture(<GeneralSettings />, [
    http.get('*/api/management/file-retention', () => HttpResponse.json({
      preference: { ownerPrincipalId: 'retention-owner', durationSeconds: 604_800, revision: 0 },
    })),
    http.get('*/api/management/settings/general', () => HttpResponse.json({
      value: { theme: 'light' }, revision: 1, versionId: 'general-1',
    })),
    http.post('*/api/management/computers/sync/status', async ({ request }) => {
      const { target } = await request.json() as { target: typeof mainTarget | typeof deviceTarget }
      return HttpResponse.json(status(target))
    }),
    http.post('*/api/management/computers/sync/update', async ({ request }) => {
      const input = await request.json() as ComputerSyncUpdateInput
      writes.push(input)
      workerEnabled = input.enabled
      return HttpResponse.json(status(deviceTarget))
    }),
  ])
  const main = within(await screen.findByRole('region', { name: 'Sync on Main PC' }))
  const worker = within(await screen.findByRole('region', { name: `Sync on ${deviceName}` }))
  expect(await main.findByText('Connected · idle')).toBeVisible()
  expect(await worker.findByText('This computer is offline.')).toBeVisible()
  expect(screen.getByRole('combobox', { name: 'Theme' })).toHaveValue('light')
  await userEvent.click(await worker.findByRole('switch', { name: 'Sync Website' }))
  await waitFor(() => expect(worker.getByRole('switch', { name: 'Sync Website' })).not.toBeChecked())
  expect(main.getByRole('switch', { name: 'Sync Website' })).toBeChecked()
  expect(writes).toEqual([expect.objectContaining({ target: deviceTarget, workspaceId: 'workspace',
    enabled: false, expectedRevision: 7 })])
  expect(screen.getByRole('heading', { name: 'File sync by computer' })).toBeVisible()
})
