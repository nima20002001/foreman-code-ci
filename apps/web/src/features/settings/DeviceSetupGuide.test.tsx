import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { ConnectionSetupStatus, DeviceSetupGuide } from './DeviceSetupGuide'

afterEach(cleanup)
const registration = (status: DeviceRegistration['status']): DeviceRegistration => ({
  mainId: '11111111-1111-4111-8111-111111111111', deviceId: '22222222-2222-4222-8222-222222222222',
  workerInstallationId: '22222222-2222-4222-8222-222222222222', publicKeyFingerprint: 'b'.repeat(64),
  keyRevision: 1, authorizationRevision: 1, status, scopes: ['connect', 'heartbeat'],
})

describe('device setup guidance', () => {
  it('orders local installation before pairing and explains direct Operator configuration', () => {
    render(<DeviceSetupGuide />)
    const steps = screen.getAllByRole('listitem').map(item => item.textContent ?? '')
    expect(steps[0]).toMatch(/Install the companion on the remote computer first/)
    expect(steps[1]).toMatch(/Pairing authorizes.*Operator.*device_connection_configure/)
    expect(steps[1]).toMatch(/settings:update/)
    expect(screen.queryByText(/Pairing lets the computer connect/)).not.toBeInTheDocument()
    fireEvent.mouseEnter(screen.getByRole('button', { name: 'About Pairing' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('Pairing authorizes connection changes; connection readiness is checked separately.')
    expect(screen.getByText(/SSH and rsync must already be installed/)).toBeInTheDocument()
    expect(screen.getByText(/this page does not install it or change network settings/)).toBeInTheDocument()
  })

  it('allows LAN or optional Tailscale rather than requiring LAN', () => {
    render(<DeviceSetupGuide />)
    expect(screen.getByText(/over your LAN or, optionally, over Tailscale/)).toBeInTheDocument()
  })

  it.each([
    ['pending', 'needs-pairing', /Pairing needed\..*Pair this computer/],
    ['paired', 'unverified', /Connection status unverified\..*Ask the Operator to read and configure its connection, then check readiness/],
    ['revoked', 'blocked', /Blocked\..*registration is revoked/],
  ] as const)('shows a distinct message for a %s computer without inferring approval or readiness', (status, state, message) => {
    render(<ConnectionSetupStatus registration={registration(status)} />)
    expect(screen.getByRole('region', { name: 'Remote command connection' })).toHaveAttribute('data-state', state)
    expect(screen.getByRole('status')).toHaveTextContent(message)
    expect(screen.queryByText(/not approved|is approved|\bready\b/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
