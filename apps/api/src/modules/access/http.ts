import type { FastifyInstance, FastifyRequest } from 'fastify'
import { isIP, Socket } from 'node:net'

import { LocalHumanAccessSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { localHumanClient, LocalClientUnavailableError } from '@foreman-code/contracts/local-client-node'
import { requireAuthorization } from './policy.js'
import { bearerToken, type PostgresAccessService } from './postgres.js'
import { DomainError } from '../errors.js'
import { localHumanPrincipal, type LocalHumanAccess } from './localHuman.js'

declare module 'fastify' {
  interface FastifyRequest {
    operatorPrincipal?: ManagementPrincipal
    operatorAuthentication?: 'local-human' | 'bearer'
    reauthorizeOperator?: () => Promise<ManagementPrincipal>
  }
}

const LOOPBACK_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function isAllowedRequestHost(hostname: string): boolean {
  if (LOOPBACK_HOSTS.has(hostname)) return true
  if (isIP(hostname) === 4) {
    const [first, second] = hostname.split('.').map(Number)
    return first === 100 && second !== undefined && second >= 64 && second <= 127
  }
  return hostname.length <= 253
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net$/i.test(hostname)
}

export function requireLocalRequest(request: FastifyRequest): void {
  if (!isAllowedRequestHost(request.hostname)) {
    throw new DomainError('HOST_NOT_ALLOWED', 'The request Host is not allowed.', 403)
  }
  const origin = request.headers.origin
  if (!origin) return
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new DomainError('ORIGIN_NOT_ALLOWED', 'The request Origin is invalid.', 403)
  }
  if (!isAllowedRequestHost(url.hostname)) {
    throw new DomainError('ORIGIN_NOT_ALLOWED', 'The request Origin is not allowed.', 403)
  }
}

function actionFor(request: FastifyRequest) {
  const url = request.url.split('?')[0] ?? request.url
  if (url === '/api/provider-accounts' || url.startsWith('/api/provider-accounts/')) {
    return request.method === 'GET' ? 'settings:read' as const : 'settings:update' as const
  }
  if (url === '/api/devices' || url === '/api/devices/main' || url === '/api/devices/setup-options') return 'settings:read' as const
  if (['/api/devices/connection-host', '/api/devices/connection-read', '/api/devices/connection-inspect', '/api/devices/connection-check'].includes(url)) return 'settings:read' as const
  if (url === '/api/devices/connection-configure') return 'settings:update' as const
  if (url === '/api/devices/pairing-grants' || url === '/api/devices/revoke' || url === '/api/devices/setup-codes') return 'settings:update' as const
  if (/^\/api\/workspaces\/[^/]+\/reference-files(?:\/|$)/.test(url)) {
    return request.method === 'GET' ? 'workspaces:read' as const : 'workspaces:update' as const
  }
  if (/^\/api\/workspaces\/[^/]+\/workflows\/[^/]+\/reference-files(?:\/|$)/.test(url)) {
    return request.method === 'GET' ? 'workflows:read' as const : 'workflows:update' as const
  }
  if (url === '/api/operator/setup') return 'harnesses:read' as const
  if (url.startsWith('/api/operator/conversations')) {
    if (['GET', 'HEAD'].includes(request.method)) return 'operator_chat:read' as const
    // Upload IDs are data, not chat actions (for example: uploads/cancel or uploads/responses).
    if (/^\/api\/operator\/conversations\/[^/]+\/files(?:\/|$)/.test(url)) return 'operator_chat:write' as const
    if (url.endsWith('/cancel')) return 'operator_chat:cancel' as const
    if (url.endsWith('/responses')) return 'operator_chat:respond' as const
    return 'operator_chat:write' as const
  }
  if (/^\/api\/workspaces\/[^/]+\/agent-chat(?:\/|$)/.test(url)) {
    if (['GET', 'HEAD'].includes(request.method)) return 'agent_chat:read' as const
    if (url.endsWith('/interrupt') || url.endsWith('/cancel')) return 'agent_chat:cancel' as const
    if (url.endsWith('/responses')) return 'agent_chat:respond' as const
    return 'agent_chat:write' as const
  }
  if (url.includes('/agents')) return request.method === 'GET' ? 'agents:read' as const : 'graph:edit' as const
  if (url.includes('/runs/') && url.endsWith('/cancel')) return 'runs:stop' as const
  if (url.includes('/runs')) return request.method === 'GET' ? 'runs:read' as const : 'runs:start' as const
  if (url.includes('/workflows/') || url.endsWith('/graph')) return request.method === 'GET' ? 'workflows:read' as const : 'graph:save' as const
  if (url.includes('/workspaces/')) return 'workspaces:read' as const
  return 'capabilities:read' as const
}

export function requirePrincipal(request: FastifyRequest): ManagementPrincipal {
  if (!request.operatorPrincipal) throw new DomainError('AUTH_REQUIRED', 'An authenticated Operator principal is required.', 401)
  return request.operatorPrincipal
}

/** Human decisions cannot be made by an agent bearer credential. */
export function requireLocalHuman(request: FastifyRequest): void {
  requirePrincipal(request)
  if (request.operatorAuthentication !== 'local-human') {
    throw new DomainError('MCP_BROWSER_REVIEW_REQUIRED', 'Review this change in the local app.', 403)
  }
}

export function registerOperatorHttpSecurity(app: FastifyInstance, access: PostgresAccessService,
  localHuman?: LocalHumanAccess, browserOrigin = 'http://127.0.0.1:5173'): void {
  app.addHook('preHandler', async (request, reply) => {
    const path = request.url.split('?')[0]
    if (!path?.startsWith('/api/')) return
    requireLocalRequest(request)
    reply.header('cache-control', 'no-store')
    const headerToken = bearerToken(request.headers.authorization)
    if (request.headers.authorization !== undefined && !headerToken) {
      throw new DomainError('AUTH_INVALID', 'The Authorization header is invalid.', 401)
    }
    if (!headerToken) {
      if (!LOOPBACK_HOSTS.has(request.hostname)) {
        throw new DomainError('AUTH_REQUIRED', 'A bearer credential is required.', 401)
      }
      if (!LOOPBACK_IPS.has(request.ip)) {
        throw new DomainError('LOCAL_HUMAN_REQUIRED', 'The local app requires a loopback client.', 403)
      }
      if (request.headers.origin && request.headers.origin !== browserOrigin
        || request.headers['sec-fetch-site'] === 'cross-site') {
        throw new DomainError('ORIGIN_NOT_ALLOWED', 'The request Origin is not allowed.', 403)
      }
      try {
        if (request.raw.socket instanceof Socket && !await localHumanClient(request.raw.socket)) {
          throw new DomainError('LOCAL_HUMAN_REQUIRED', 'Agent processes require an application credential.', 403)
        }
      } catch (error) {
        if (!(error instanceof LocalClientUnavailableError)) throw error
        reply.header('retry-after', '1')
        throw new DomainError(error.code, error.message, 503, { retryable: true }, { cause: error })
      }
    }
    const authenticate = () => headerToken ? access.authenticate(headerToken, 'operator')
      : localHuman?.current() ?? Promise.resolve(localHumanPrincipal)
    const principal = await authenticate()
    request.operatorPrincipal = principal
    request.operatorAuthentication = headerToken ? 'bearer' : 'local-human'
    // Account and chat services resolve persisted resources before checking their full scopes.
    const providerAccounts = path === '/api/provider-accounts' || path.startsWith('/api/provider-accounts/')
    const agentChat = /^\/api\/workspaces\/[^/]+\/agent-chat(?:\/|$)/.test(path)
    const selfReadback = path === '/api/local-human' || path === '/api/runtime/identity' || path === '/api/runtime/build-identity/v1'
    const params = request.params as Record<string, string | undefined>
    const resource = {
      ...(params.workspaceId ? { workspaceId: params.workspaceId } : {}),
      ...(params.workflowId ? { workflowId: params.workflowId } : {}),
      ...(params.runId ? { runId: params.runId } : {}),
    }
    request.reauthorizeOperator = async () => {
      const current = await authenticate()
      // Re-check against the same route resource; scoped grants never match an empty resource.
      if (!agentChat && !selfReadback && !providerAccounts) requireAuthorization(current, actionFor(request), resource)
      return current
    }
    if (!agentChat && !selfReadback && !providerAccounts && !request.url.startsWith('/api/management/')) {
      requireAuthorization(principal, actionFor(request), resource)
      if (request.method === 'GET' && /^\/api\/workspaces\/[^/]+\/runs\/[^/]+(?:\?.*)?$/.test(request.url)) {
        requireAuthorization(principal, 'workspace_locations:read', resource)
      }
      if (request.method === 'GET' && /^\/api\/workspaces\/[^/]+(?:\?.*)?$/.test(request.url)) {
        for (const action of ['workflows:read', 'agents:read', 'runs:read'] as const) {
          requireAuthorization(principal, action, resource)
        }
      }
    }
  })

  app.get('/api/local-human', (request) => {
    const principal = requirePrincipal(request)
    return LocalHumanAccessSchema.parse({ principal: {
      id: principal.id, name: principal.name, expiresAt: principal.expiresAt, grants: principal.grants,
    } })
  })
}
