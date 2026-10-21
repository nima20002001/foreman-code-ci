import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { HarnessHostInventoryMetadataSchema } from '@foreman-code/contracts/harness-registry'
import { ComputerPresence } from './ComputerPresence'
import { connectionSummary } from './computerPresenceModel'

const mainId = '11111111-1111-4111-8111-111111111111'
const deviceId = '22222222-2222-4222-8222-222222222222'
const workerId = '33333333-3333-4333-8333-333333333333'
const host = { kind: 'device', mainId, deviceId } as const
const connection = {
  binding: { mainId, deviceId, workerInstallationId: workerId, bootId: '44444444-4444-4444-8444-444444444444', keyRevision: 1, authorizationRevision: 2,
    connectionGeneration: 7, connectionEpoch: '55555555-5555-4555-8555-555555555555' },
  phase: 'ready', dispatch: true, transfer: false, appVersion: '1.4.2', protocolVersion: 1, lastSeenAt: '2026-10-01T00:00:00.000Z',
} as const
const metadata = (value: unknown) => HarnessHostInventoryMetadataSchema.parse({ hostRef: host, applicationInstallationId: workerId, platform: null, workspaceRoots: null, connection: value })

afterEach(cleanup)
describe('worker presence', () => {
  it('shows only the observed server facts', () => {
    render(<ComputerPresence host={host} applicationInstallationId={workerId} metadata={metadata(connection)} />)
    expect(screen.getByText('App version').nextElementSibling).toHaveTextContent('1.4.2')
    expect(screen.getByText('Protocol version').nextElementSibling).toHaveTextContent('1')
    expect(screen.getByText('Connection').nextElementSibling).toHaveTextContent('Ready')
    expect(screen.getByText('Job dispatch').nextElementSibling).toHaveTextContent('Available')
    expect(screen.getByText('File transfer').nextElementSibling).toHaveTextContent('Not available')
    expect(screen.getByText('2026-10-01T00:00:00.000Z')).toBeVisible()
  })
  it('keeps a paired worker with no observation unknown and never ready', () => {
    render(<ComputerPresence host={host} applicationInstallationId={workerId} metadata={metadata(null)} />)
    expect(screen.getByText(/has not observed an authenticated connection/)).toBeVisible()
    expect(screen.queryByText('Ready')).not.toBeInTheDocument()
    expect(connectionSummary(host, workerId, metadata(null))).toBe('Worker connection not observed')
  })
  it('reports offline and does not claim readiness', () => {
    expect(connectionSummary(host, workerId, metadata({ ...connection, phase: 'offline' }))).toMatch(/^Worker offline/)
  })
  it('treats missing metadata, another installation or another host as unavailable', () => {
    const observed = metadata(connection)
    expect(connectionSummary(host, workerId, undefined)).toBe('Worker connection unavailable')
    expect(connectionSummary(host, mainId, observed)).toBe('Worker connection unavailable')
    expect(connectionSummary({ ...host, deviceId: mainId }, workerId, observed)).toBe('Worker connection unavailable')
  })
  it('describes the selected main as having no worker connection', () => {
    const main = HarnessHostInventoryMetadataSchema.parse({ hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, platform: null, workspaceRoots: null, connection: null })
    render(<ComputerPresence host={{ kind: 'main', mainId }} applicationInstallationId={mainId} metadata={main} />)
    expect(screen.queryByText(/no separate worker connection/)).not.toBeInTheDocument()
    fireEvent.focus(screen.getByRole('button', { name: 'About Main connection' }))
    expect(screen.getByRole('tooltip')).toHaveTextContent('It owns scheduling and has no separate worker connection.')
  })
})
