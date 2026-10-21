import { z } from 'zod'
import { DeviceProvisioningTargetSchema } from '@foreman-code/contracts/device-resources'
import type { FastifyInstance } from 'fastify'
import { ProviderAccountIdSchema } from '@foreman-code/contracts/provider-accounts'
import { requireLocalHuman, requirePrincipal } from '../modules/access/http.js'
import type { ProviderAccountsService } from '../modules/provider-accounts/service.js'
import { DomainError } from '../modules/errors.js'

/** GET target is one percent-encoded JSON object; booleans use true/false. */
export function decodeProviderAccountQuery(raw: unknown): Record<string, unknown> {
  const input = z.record(z.string(), z.unknown()).parse(raw)
  const decoded = { ...input }
  if (input.target !== undefined) {
    const text = z.string().max(4096).parse(input.target)
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new DomainError('INVALID_INPUT', 'target must be a JSON object.', 400) }
    decoded.target = DeviceProvisioningTargetSchema.parse(value)
  }
  if (input.includeRemoved !== undefined) {
    decoded.includeRemoved = z.enum(['true', 'false']).parse(input.includeRemoved) === 'true'
  }
  return decoded
}

export function registerProviderAccountRoutes(app: FastifyInstance, accounts: ProviderAccountsService): void {
  app.get('/api/provider-accounts', request => accounts.list(requirePrincipal(request)))
  app.get('/api/provider-accounts/page', request => accounts.page(requirePrincipal(request), decodeProviderAccountQuery(request.query)))
  app.get('/api/provider-accounts/targets', request => accounts.targets(requirePrincipal(request)))
  app.get('/api/provider-accounts/profiles', request => accounts.profiles(requirePrincipal(request),
    decodeProviderAccountQuery(request.query)))
  app.get('/api/provider-accounts/:accountId/eligibility', request => accounts.eligibility(requirePrincipal(request), {
    ...decodeProviderAccountQuery(request.query), accountId: ProviderAccountIdSchema.parse((request.params as {accountId: string}).accountId),
  }))
  app.get('/api/provider-accounts/:accountId/authentication', request => accounts.authenticationList(requirePrincipal(request), {
    ...decodeProviderAccountQuery(request.query), accountId: ProviderAccountIdSchema.parse((request.params as {accountId: string}).accountId),
  }))
  app.post('/api/provider-accounts/authentication/handoff', async (request, reply) => {
    reply.header('cache-control', 'no-store, private').header('pragma', 'no-cache')
    reply.header('referrer-policy', 'no-referrer')
    const principal = requirePrincipal(request)
    try { requireLocalHuman(request) } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await accounts.auditDenied(principal, 'http', 'provider.account.auth.handoff', 'human-only', error)
      }
      throw error
    }
    return accounts.humanHandoff(principal, request.body)
  })
  app.post('/api/provider-accounts/register', request => accounts.register(requirePrincipal(request), 'http', request.body))
  app.post('/api/provider-accounts', request => accounts.create(requirePrincipal(request), 'http', request.body))
  const accountId = (params: unknown) => ProviderAccountIdSchema.parse((params as { accountId: string }).accountId)
  app.get('/api/provider-accounts/:accountId', request => accounts.get(requirePrincipal(request), {
    ...decodeProviderAccountQuery(request.query), accountId: accountId(request.params),
  }))
  app.get('/api/provider-accounts/:accountId/models', request => accounts.models(requirePrincipal(request), {
    ...decodeProviderAccountQuery(request.query), accountId: accountId(request.params),
  }))
  app.post('/api/provider-accounts/:accountId/remove', request =>
    accounts.remove(requirePrincipal(request), 'http', accountId(request.params), request.body))
  app.post('/api/provider-accounts/:accountId/authentication', request =>
    accounts.prepareAuthentication(requirePrincipal(request), 'http', accountId(request.params), request.body))
  app.post('/api/provider-accounts/authentication/status', request =>
    accounts.authenticationStatus(requirePrincipal(request), request.body))
  app.post('/api/provider-accounts/authentication/cancel', request =>
    accounts.cancelAuthentication(requirePrincipal(request), 'http', request.body))
  app.patch('/api/provider-accounts/:accountId', request =>
    accounts.rename(requirePrincipal(request), 'http', accountId(request.params), request.body))
  app.post('/api/provider-accounts/:accountId/default', request =>
    accounts.setDefault(requirePrincipal(request), 'http', accountId(request.params), request.body))
  app.post('/api/provider-accounts/:accountId/login', request =>
    accounts.login(requirePrincipal(request), 'http', accountId(request.params), request.body))
  app.post('/api/provider-accounts/:accountId/logout', request =>
    accounts.logout(requirePrincipal(request), 'http', accountId(request.params), request.body))
  app.post('/api/provider-accounts/:accountId/refresh', request =>
    accounts.refresh(requirePrincipal(request), 'http', accountId(request.params), request.body))
  app.post('/api/provider-accounts/:accountId/api-key', async request => {
    const principal = requirePrincipal(request)
    const id = accountId(request.params)
    try { requireLocalHuman(request) } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await accounts.auditDenied(principal, 'http', 'provider.account.key.provision', id, error)
      }
      throw error
    }
    return accounts.provisionApiKey(principal, id, request.body)
  })
}
