import { randomUUID } from 'node:crypto'
import { McpServer } from '@modelcontextprotocol/server'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { MainDeviceIdentityPublicSchema, type DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { DeviceSetupOptionsSchema } from '@foreman-code/contracts/device-setup'
import { describe, expect, it, vi } from 'vitest'
import { registerDeviceManagementTools, type DeviceManagementService } from './management.js'

describe('device Operator MCP shared service', () => {
  it('exposes persisted readback and removes write tools for denied callers', async () => {
    const registration: DeviceRegistration = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(),
      keyRevision: 1, authorizationRevision: 2, status: 'revoked', scopes: ['connect'], publicKeyFingerprint: 'a'.repeat(64) }
    const main = MainDeviceIdentityPublicSchema.parse({ mainId: registration.mainId, mainPublicKey: 'public-key', mainPublicKeyFingerprint: 'b'.repeat(64) })
    const setup = DeviceSetupOptionsSchema.parse({ endpoint: null, available: false, reason: 'listener-unconfigured' })
    const readMainIdentity = vi.fn(async () => main), readSetupOptions = vi.fn(async () => setup)
    const rejectWrite = vi.fn(async () => { throw new Error('Unexpected device write') })
    const service: DeviceManagementService = { list: async () => [registration], readMainIdentity, readSetupOptions,
      createPairingGrant: rejectWrite, createSetupCode: rejectWrite, revoke: rejectWrite }
    const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator', revokedAt: null,
      expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['settings:read'], scope: {} }] }
    const server = new McpServer({ name: 'device-test', version: '1' })
    registerDeviceManagementTools(server, service, principal)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'reader', version: '1' })
    try {
      await server.connect(serverTransport); await client.connect(clientTransport)
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['device_main_identity_get', 'device_setup_options_get', 'devices_list'])
      expect((await client.callTool({ name: 'device_main_identity_get', arguments: {} })).structuredContent).toEqual(main)
      expect(readMainIdentity).toHaveBeenCalledWith(principal)
      expect((await client.callTool({ name: 'device_setup_options_get', arguments: {} })).structuredContent).toEqual(setup)
      expect(readSetupOptions).toHaveBeenCalledWith(principal)
      const result = await client.callTool({ name: 'devices_list', arguments: {} })
      expect(result.structuredContent).toEqual({ devices: [registration] })
      await expect(client.callTool({ name: 'device_revoke', arguments: { deviceId: registration.deviceId, expectedRevision: 2, commandId: 'denied-test' } })).rejects.toThrow('not found')
      await expect(client.callTool({ name: 'device_setup_code_create', arguments: {} })).rejects.toThrow('not found')
      expect((await client.callTool({ name: 'devices_list', arguments: {} })).structuredContent).toEqual({ devices: [registration] })
      expect(rejectWrite).not.toHaveBeenCalled()
    } finally { await client.close(); await server.close() }
  })
})
