import { screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { CollaborationUIProvider } from '../../shared/ui/collaborationSlots'
import { ComputerCards } from './ComputerCards'
import { computersFixture, deviceName, deviceTarget, mainTarget, registration } from './computersTestFixture'

it('mounts the feature-owned Browser profile row only for the visible paired computer with its exact identity', async () => {
  computersFixture(<CollaborationUIProvider value={{ computerBrowserProfiles: target =>
    <section aria-label="Browser profiles"><output>{JSON.stringify(target)}</output></section> }}>
    <ComputerCards mainId={mainTarget.hostRef.mainId} devices={[registration]} only={registration.deviceId} />
  </CollaborationUIProvider>)
  const device = await screen.findByRole('article', { name: deviceName })
  expect(within(device).getByRole('region', { name: 'Browser profiles' })).toHaveTextContent(JSON.stringify(deviceTarget))
  expect(screen.getAllByRole('region', { name: 'Browser profiles' })).toHaveLength(1)
  expect(screen.queryByRole('article', { name: 'Main PC' })).not.toBeInTheDocument()
  const link = within(device).getByRole('link', { name: 'Browser profiles on this computer' })
  const destination = new URL(link.getAttribute('href')!, 'http://localhost')
  expect(destination.pathname).toBe('/settings/browser-profiles')
  expect(destination.searchParams.get('mainId')).toBe(mainTarget.hostRef.mainId)
  expect(destination.searchParams.get('computer')).toBe('device')
  expect(destination.searchParams.get('deviceId')).toBe(registration.deviceId)
})
