import { describe, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { OperatorRequestContext } from '../types.js'
import { operatorToolAvailable, operatorToolRequirements } from '../availability.js'
import { unavailableDeviceOperatorToolCall } from '../unavailableTools.js'

const principal: ManagementPrincipal = { id: 'device-reader', name: 'Reader', audience: 'operator', expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
  grants: [{ actions: ['settings:read'], scope: {} }] }
function context(caller = principal) {
  return { principal: caller, services: { devices: {}, commands: { recordDenied: vi.fn(async () => {}) } } } as unknown as OperatorRequestContext
}
it('requires globally usable settings grants and composed devices in capability discovery', () => {
  const reader = context()
  expect(operatorToolAvailable(reader, 'devices_list')).toBe(true)
  expect(operatorToolAvailable(reader, 'device_revoke')).toBe(false)
  const scoped = context({ ...principal, grants: [{ actions: ['settings:read', 'settings:update'], scope: { workspaceIds: ['only-this-workspace'] } }] })
  expect(operatorToolAvailable(scoped, 'devices_list', { workspaceId: 'only-this-workspace' })).toBe(false)
  expect(operatorToolAvailable(scoped, 'device_revoke')).toBe(false)
  expect(operatorToolRequirements('device_revoke')).toEqual([{ action: 'settings:update', scope: 'global' }])
  delete reader.services.devices
  expect(operatorToolAvailable(reader, 'devices_list')).toBe(false)
})
describe('existing authenticated dispatcher device denial', () => {
  it('audits guessed calls to hidden mutation tools', async () => {
    const reader = context()
    const response = await unavailableDeviceOperatorToolCall(reader, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'device_revoke', arguments: {} } })
    expect(response?.result.isError).toBe(true)
    expect(reader.services.commands.recordDenied).toHaveBeenCalledWith(principal.id, 'mcp', 'device_revoke', 'mcp:device_revoke')
    expect(await unavailableDeviceOperatorToolCall(reader, { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'devices_list', arguments: {} } })).toBeUndefined()
  })
})

it('discovers connection tools only with a composed service and compatible global grants', async () => {
  const reader = context()
  expect(operatorToolAvailable(reader, 'device_connection_read')).toBe(false)
  reader.services.trustedConnections = {} as NonNullable<OperatorRequestContext['services']['trustedConnections']>
  expect(operatorToolAvailable(reader, 'device_connection_read')).toBe(true)
  expect(operatorToolAvailable(reader, 'device_connection_configure')).toBe(false)
  expect(operatorToolRequirements('device_connection_configure')).toEqual([{ action: 'settings:update', scope: 'global' }])
  const scoped = { ...reader, principal: { ...principal, grants: [{ actions: ['settings:read' as const], scope: { workspaceIds: ['only-this-workspace'] } }] } }
  expect(operatorToolAvailable(scoped, 'device_connection_read', { workspaceId: 'only-this-workspace' })).toBe(false)
  const response = await unavailableDeviceOperatorToolCall(reader, { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'device_connection_configure', arguments: {} } })
  expect(response?.result.isError).toBe(true)
  expect(reader.services.commands.recordDenied).toHaveBeenCalledWith(principal.id, 'mcp', 'device_connection_configure', 'mcp:device_connection_configure')
})
