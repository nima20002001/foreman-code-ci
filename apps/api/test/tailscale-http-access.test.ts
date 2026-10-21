import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { describe, expect, it, vi } from 'vitest'

import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'

const principal: ManagementPrincipal = {
  id: 'network-reader', name: 'Network reader', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null,
  grants: [{ actions: ['capabilities:read'], scope: {} }],
}

function fixture() {
  const access = new PostgresAccessService({} as never)
  const authenticate = vi.spyOn(access, 'authenticate').mockImplementation(async token => {
    if (token !== 'reader-token') throw new DomainError('AUTH_INVALID', 'Invalid credential.', 401)
    return principal
  })
  const app = buildApp({
    readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
    operator: { access, services: {
      commands: { recordDenied: vi.fn(async () => undefined) },
    } as unknown as OperatorServices },
  })
  return { app, authenticate }
}

describe('Tailscale HTTP access', () => {
  it.each(['node.example.ts.net', '100.64.0.0', '100.100.20.30', '100.127.255.255'])(
    'accepts authenticated Host and Origin at %s for HTTP and MCP', async host => {
      const { app, authenticate } = fixture()
      const headers = { host: `${host}:3000`, origin: `http://${host}:5173`, authorization: 'Bearer reader-token' }
      try {
        const response = await app.inject({ url: '/api/local-human', headers, remoteAddress: '100.100.20.31' })
        expect(response.statusCode).toBe(200)
        expect(response.json().principal.id).toBe(principal.id)
        const mcp = await app.inject({ method: 'GET', url: '/mcp', headers })
        expect(mcp.statusCode).toBe(405)
        expect(mcp.json().error.message).toBe('Method not allowed.')
        expect(authenticate).toHaveBeenCalledWith('reader-token', 'operator')
      } finally { await app.close() }
    },
  )

  it.each([
    'public.example', 'ts.net', 'node.ts.net.public.example', 'fake-ts.net',
    '100.63.255.255', '100.128.0.0', '100.64.0.256',
  ])('rejects Host and Origin outside the allowed network: %s', async host => {
    const { app, authenticate } = fixture()
    try {
      for (const url of ['/api/local-human', '/mcp']) {
        const deniedHost = await app.inject({ url, headers: { host, authorization: 'Bearer reader-token' } })
        expect(deniedHost.statusCode).toBe(403)
        const deniedOrigin = await app.inject({ url, headers: {
          host: 'node.example.ts.net', origin: `http://${host}`, authorization: 'Bearer reader-token',
        } })
        expect(deniedOrigin.statusCode).toBe(403)
      }
      expect(authenticate).not.toHaveBeenCalled()
    } finally { await app.close() }
  })

  it.each(['node.example.ts.net', '100.100.20.30'])(
    'requires credentials at %s even through a loopback proxy', async host => {
      const { app } = fixture()
      try {
        for (const remoteAddress of ['100.100.20.31', '127.0.0.1']) {
          for (const url of ['/api/local-human', '/mcp']) {
            const response = await app.inject({ url, headers: { host }, remoteAddress })
            expect(response.statusCode).toBe(401)
          }
        }
        const invalid = await app.inject({ url: '/api/local-human', headers: {
          host, origin: `http://${host}`, authorization: 'Bearer invalid',
        } })
        expect(invalid.statusCode).toBe(401)
      } finally { await app.close() }
    },
  )

  it('rejects invalid origins and preserves authenticated loopback access', async () => {
    const { app } = fixture()
    try {
      for (const host of ['localhost', '127.0.0.1', '[::1]']) {
        const response = await app.inject({ url: '/api/local-human', headers: {
          host: `${host}:3000`, origin: `http://${host}:5173`, authorization: 'Bearer reader-token',
        } })
        expect(response.statusCode).toBe(200)
      }
      const invalid = await app.inject({ url: '/api/local-human', headers: {
        host: 'node.example.ts.net', origin: 'invalid-origin', authorization: 'Bearer reader-token',
      } })
      expect(invalid.statusCode).toBe(403)
    } finally { await app.close() }
  })
})
