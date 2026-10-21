import Fastify from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { loadConfig } from '../src/config.js'
import { localHumanPrincipal } from '../src/modules/access/localHuman.js'
import { registerOperatorHttpSecurity, requireLocalHuman, requirePrincipal } from '../src/modules/access/http.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import * as localClient from '@foreman-code/contracts/local-client-node'

async function fixture() {
  const app = Fastify()
  const authenticate = vi.fn(async (token: string) => {
    if (token !== 'reader-token') throw new DomainError('AUTH_INVALID', 'Invalid credential.', 401)
    return { ...localHumanPrincipal, id: 'reader', grants: [{ actions: ['settings:read' as const], scope: {} }] }
  })
  registerOperatorHttpSecurity(app, { authenticate } as unknown as PostgresAccessService)
  app.get('/api/devices/connection-host', request => requirePrincipal(request))
  app.post('/api/devices/connection-configure', request => requirePrincipal(request))
  app.post('/api/human-decision', request => { requireLocalHuman(request); return { approved: true } })
  app.setErrorHandler((error, _request, reply) => {
    const status = error instanceof DomainError ? error.status : 500
    void reply.code(status).send({ code: error instanceof DomainError ? error.code : 'UNEXPECTED' })
  })
  return { app, authenticate }
}

describe('implicit local human', () => {
  it('returns retryable peer errors on real HTTP without granting access or changing bearer permissions', async () => {
    const { app, authenticate } = await fixture()
    const peer = vi.spyOn(localClient, 'localHumanClient')
    peer.mockRejectedValue(new localClient.LocalClientUnavailableError())
    try {
      const address = await app.listen({ port: 0, host: '127.0.0.1' })
      const unknown = await fetch(`${address}/api/local-human`)
      expect(unknown.status).toBe(503)
      expect(unknown.headers.get('retry-after')).toBe('1')
      expect(await unknown.json()).toEqual({ code: 'LOCAL_CLIENT_UNAVAILABLE' })
      expect(authenticate).not.toHaveBeenCalled()
      const headers = { authorization: 'Bearer reader-token' }
      const reader = await fetch(`${address}/api/devices/connection-host`, { headers })
      expect(reader.status).toBe(200)
      expect((await reader.json()).id).toBe('reader')
      const write = await fetch(`${address}/api/devices/connection-configure`, { method: 'POST', headers })
      expect(write.status).toBe(403)
      await write.body?.cancel()
      expect(peer).toHaveBeenCalledTimes(1)
      peer.mockResolvedValue(false)
      const denied = await fetch(`${address}/api/local-human`)
      expect(denied.status).toBe(403)
      await denied.body?.cancel()
      peer.mockResolvedValue(true)
      const recovered = await fetch(`${address}/api/local-human`)
      expect(recovered.status).toBe(200)
      expect((await recovered.json()).principal.id).toBe(localHumanPrincipal.id)
    } finally {
      peer.mockRestore()
      await app.close()
    }
  })
  it('defaults to loopback and rejects non-loopback binds', () => {
    const environment = { DATABASE_URL: 'postgresql://graphql:graphql@127.0.0.1/graphql' }
    expect(loadConfig(environment).host).toBe('127.0.0.1')
    expect(loadConfig({ ...environment, HOST: '::1' }).host).toBe('::1')
    for (const host of ['0.0.0.0', '::', '192.0.2.1']) expect(() => loadConfig({ ...environment, HOST: host })).toThrow()
  })
  it('reads and writes without cookies or credentials and ignores obsolete browser cookies', async () => {
    const { app, authenticate } = await fixture()
    try {
      for (const headers of [{}, { cookie: 'graphql_operator=obsolete; better-auth.session_token=obsolete' }]) {
        const read = await app.inject({ url: '/api/local-human', headers })
        expect(read.statusCode).toBe(200)
        expect(read.json().principal.id).toBe(localHumanPrincipal.id)
        expect(read.headers['set-cookie']).toBeUndefined()
        expect((await app.inject({ method: 'POST', url: '/api/devices/connection-configure', headers })).statusCode).toBe(200)
        expect((await app.inject({ method: 'POST', url: '/api/human-decision', headers })).json()).toEqual({ approved: true })
      }
      expect(authenticate).not.toHaveBeenCalled()
      for (const url of ['/api/auth/session', '/api/auth/setup', '/api/auth/sign-in/email', '/api/auth/enroll', '/api/auth/logout']) {
        expect((await app.inject({ method: 'POST', url })).statusCode).toBe(404)
      }
    } finally { await app.close() }
  })
  it('rejects remote clients, foreign hosts/origins and cross-site browser requests', async () => {
    const { app } = await fixture()
    try {
      for (const options of [
        { remoteAddress: '192.0.2.1' }, { headers: { host: 'attacker.invalid' } },
        { headers: { origin: 'https://attacker.invalid' } },
        { headers: { origin: 'http://127.0.0.1:9999' } },
        { headers: { 'sec-fetch-site': 'cross-site' } },
      ]) expect((await app.inject({ url: '/api/local-human', ...options })).statusCode).toBe(403)
    } finally { await app.close() }
  })
  it('preserves bearer precedence, denied writes and the human approval boundary', async () => {
    const { app, authenticate } = await fixture()
    try {
      const headers = { authorization: 'Bearer reader-token' }
      expect((await app.inject({ url: '/api/devices/connection-host', headers })).json().id).toBe('reader')
      expect((await app.inject({ method: 'POST', url: '/api/devices/connection-configure', headers })).statusCode).toBe(403)
      expect((await app.inject({ method: 'POST', url: '/api/human-decision', headers })).statusCode).toBe(403)
      for (const authorization of ['Bearer invalid', 'invalid']) {
        expect((await app.inject({ url: '/api/local-human', headers: { authorization } })).statusCode).toBe(401)
      }
      expect(authenticate).toHaveBeenCalledWith('reader-token', 'operator')
    } finally { await app.close() }
  })
})
