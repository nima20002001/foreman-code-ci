import Fastify from 'fastify'
import { expect, it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { registerOperatorHttpSecurity, requirePrincipal } from '../src/modules/access/http.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'

it('maps device connection reads and changes to their actual settings permissions', async () => {
  const reader: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator', revokedAt: null, expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['settings:read'], scope: {} }] }
  const capabilityReader: ManagementPrincipal = { ...reader, id: 'capability-reader', grants: [{ actions: ['capabilities:read'], scope: {} }] }
  const writer: ManagementPrincipal = { ...reader, id: 'writer', grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] }
  const app = Fastify()
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.status(error.status).send({ code: error.code })
    return reply.status(500).send({ code: 'UNEXPECTED' })
  })
  const principals: Record<string, ManagementPrincipal> = { reader, writer, capabilities: capabilityReader }
  const access = { authenticate: async (token: string) => principals[token] ?? capabilityReader } as unknown as PostgresAccessService
  registerOperatorHttpSecurity(app, access)
  for (const path of ['/api/devices/connection-read', '/api/devices/connection-check', '/api/devices/connection-inspect', '/api/devices/connection-configure']) {
    app.post(path, request => ({ caller: requirePrincipal(request).id }))
  }
  app.get('/api/devices/connection-host', request => ({ caller: requirePrincipal(request).id }))
  try {
    for (const path of ['connection-read', 'connection-check', 'connection-inspect']) {
      expect((await app.inject({ method: 'POST', url: `/api/devices/${path}`, headers: { authorization: 'Bearer reader' }, payload: {} })).statusCode).toBe(200)
      expect((await app.inject({ method: 'POST', url: `/api/devices/${path}`, headers: { authorization: 'Bearer capabilities' }, payload: {} })).statusCode).toBe(403)
    }
    const configure = (token: string) => app.inject({ method: 'POST', url: '/api/devices/connection-configure',
      headers: { authorization: `Bearer ${token}` }, payload: {} })
    expect((await configure('reader')).statusCode).toBe(403)
    expect((await configure('capabilities')).statusCode).toBe(403)
    expect((await configure('writer')).statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/api/devices/connection-host', headers: { authorization: 'Bearer reader' } })).statusCode).toBe(200)
  } finally { await app.close() }
})
