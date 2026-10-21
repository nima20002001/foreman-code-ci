import { randomUUID } from 'node:crypto'
import Fastify from 'fastify'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'
import { McpServer } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { describe, expect, it, vi } from 'vitest'
import { requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'
import { registerTrustedConnectionRoutes, registerTrustedConnectionTools, type TrustedConnectionManagementService } from './trustedConnectionManagement.js'
import type { TrustedConnectionConsent } from './trustedConnectionSetup.js'

function fixture() {
  const principal: ManagementPrincipal = { id: 'owner', name: 'Owner', audience: 'operator', revokedAt: null, expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] }
  const reader: ManagementPrincipal = { ...principal, id: 'reader', grants: [{ actions: ['settings:read'], scope: {} }] }
  const registration = { mainId: randomUUID(), deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1, publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect'] as ('connect')[], status: 'paired' as const }
  const input = { deviceId: registration.deviceId, commandId: randomUUID(), expectedRevision: 0, expectedAuthorizationRevision: 1, endpoint: { host: '100.64.0.20', port: 22, osUser: 'builder', transport: 'tailscale' as const }, hostKeyFingerprint: `SHA256:${'b'.repeat(43)}`, allowOwnerCommands: true }
  let consent: TrustedConnectionConsent | null = null
  const service = {
    read: vi.fn(async (who: ManagementPrincipal) => { requireAuthorization(who, 'settings:read'); return { registration, consent } }),
    configure: vi.fn(async (who: ManagementPrincipal) => {
      requireAuthorization(who, 'settings:update')
      consent ??= { mainId: registration.mainId, deviceId: registration.deviceId, workerInstallationId: registration.workerInstallationId, keyRevision: 1, authorizationRevision: 1, publicKeyFingerprint: registration.publicKeyFingerprint,
        revision: 1, endpoint: input.endpoint, hostKeyFingerprint: input.hostKeyFingerprint, allowOwnerCommands: true, privilege: 'selected-os-user', automaticSudo: false, grantsAgentPermissions: false }
      return consent
    }),
  } as unknown as TrustedConnectionManagementService
  return { principal, reader, registration, input, service }
}
describe('trusted device HTTP and Operator MCP registrar parity', () => {
  it('uses the same service for HTTP configuration, MCP retry and readback, and denies a read-only caller', async () => {
    const f = fixture(), app = Fastify(), server = new McpServer({ name: 'connection', version: '1' }), client = new Client({ name: 'owner', version: '1' })
    registerTrustedConnectionRoutes(app, f.service, async request => {
      if (request.headers.authorization === 'Bearer owner') return f.principal
      if (request.headers.authorization === 'Bearer reader') return f.reader
      throw new DomainError('UNAUTHENTICATED', 'Authentication required.', 401)
    })
    registerTrustedConnectionTools(server, f.service, f.principal)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport); await client.connect(clientTransport)
      const http = await app.inject({ method: 'POST', url: '/api/devices/connection-configure', headers: { authorization: 'Bearer owner' }, payload: f.input })
      expect(http.statusCode).toBe(200)
      const retry = await client.callTool({ name: 'device_connection_configure', arguments: f.input })
      expect(retry.isError).not.toBe(true); expect(retry.structuredContent).toEqual(http.json())
      const readback = await client.callTool({ name: 'device_connection_read', arguments: { deviceId: f.registration.deviceId } })
      expect(readback.structuredContent).toEqual({ registration: f.registration, consent: http.json() })
      const denied = await app.inject({ method: 'POST', url: '/api/devices/connection-configure', headers: { authorization: 'Bearer reader' }, payload: f.input })
      expect(denied.statusCode).toBe(403)
      const unauthenticated = await app.inject({ method: 'POST', url: '/api/devices/connection-read', payload: { deviceId: f.registration.deviceId } })
      expect(unauthenticated.statusCode).toBe(401)
      expect(f.service.configure).toHaveBeenCalledWith(f.principal, f.input, 'http')
      expect(f.service.configure).toHaveBeenCalledWith(f.principal, f.input, 'mcp')
    } finally { await client.close(); await server.close(); await app.close() }
  })
  it('does not expose the configuration tool to a read-only agent', async () => {
    const f = fixture(), server = new McpServer({ name: 'reader', version: '1' }), client = new Client({ name: 'reader', version: '1' })
    registerTrustedConnectionTools(server, f.service, f.reader)
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await server.connect(serverTransport); await client.connect(clientTransport)
      const names = (await client.listTools()).tools.map(tool => tool.name)
      expect(names).toContain('device_connection_check'); expect(names).not.toContain('device_connection_configure')
      await expect(client.callTool({ name: 'device_connection_configure', arguments: f.input })).rejects.toThrow('not found')
    } finally { await client.close(); await server.close() }
  })
})

it('does not register global host diagnostics for workspace-scoped settings grants', async () => {
  const f = fixture(), server = new McpServer({ name: 'scoped', version: '1' }), client = new Client({ name: 'scoped', version: '1' })
  registerTrustedConnectionTools(server, f.service, { ...f.principal, grants: [{ actions: ['settings:read', 'settings:update'], scope: { workspaceIds: ['only-this-workspace'] } }] })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  try {
    await server.connect(serverTransport); await client.connect(clientTransport)
    expect((await client.listTools()).tools).toEqual([])
    expect(f.service.read).not.toHaveBeenCalled()
  } finally { await client.close(); await server.close() }
})
