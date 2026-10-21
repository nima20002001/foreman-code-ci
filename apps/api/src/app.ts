import { registerRuntimeInstallationSecurity } from './infrastructure/runtimeIdentity.js'
import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { scheduleDispatchLog } from './modules/schedules/dispatchErrors.js'

import {
  ApiErrorResponseSchema,
  ServiceHealthSchema,
  type ServiceHealth,
  type RuntimeIdentity, type RuntimeBuildIdentity, RuntimeBuildIdentitySchema, frozenRuntimeIdentity,
} from '@foreman-code/contracts'
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import type pg from 'pg'
import { z } from 'zod'

import type { AppMcpServices } from './mcp/app/types.js'
import { registerGraphqlMcp, type GraphqlMcpServices } from './mcp/unified/transport.js'
import type { OperatorServices } from './mcp/operator/types.js'
import { registerOperatorHttpSecurity, requireLocalRequest } from './modules/access/http.js'
import type { PostgresAccessService } from './modules/access/postgres.js'
import type { LocalHumanAccess } from './modules/access/localHuman.js'
import { DomainError, databaseConnectionFailure, databaseReadFailure, publicFailureClass } from './modules/errors.js'
import type { McpDetectionService } from './modules/harnesses/mcpDetection.js'
import { registerUserInteractions } from './routes/userInteractions.js'
import { registerRunGraphRoutes } from './routes/runGraph.js'
import { registerRunPlacementRoutes, registerNodePlacementChoicesRoutes } from './modules/placement/transports.js'
import { registerManagementRoutes } from './routes/management.js'
import { registerMcpDetectionRoute } from './routes/mcpDetection.js'
import { registerProductRoutes, type ProductServices } from './routes/product.js'
import { registerAgentChatRoutes } from './routes/agentChat.js'
import { registerWorkflowScheduleRoutes } from './routes/workflowSchedules.js'
import { registerProviderAccountRoutes } from './routes/providerAccounts.js'

export interface ReadinessDependencies {
  database: { ping(signal?: AbortSignal): Promise<void> }
  checkpoints: { ping(signal?: AbortSignal): Promise<void> }
}

export interface BuildAppOptions {
  runtimeIdentity?: () => Promise<RuntimeIdentity>
  runtimeBuildIdentity?: () => RuntimeBuildIdentity
  localHuman?: LocalHumanAccess
  browserOrigin?: string
  readiness: ReadinessDependencies
  readinessTimeoutMs?: number
  product?: ProductServices
  operator?: { access: PostgresAccessService; services: OperatorServices }
  appMcp?: AppMcpServices
  workerArtifacts?: GraphqlMcpServices['workerArtifacts']
  mcpDetection?: { pool: pg.Pool; service: McpDetectionService }
  logger?: boolean | FastifyBaseLogger
  closeInfrastructure?: () => Promise<void>
}

type DependencyStatus = 'ok' | 'unavailable'

function createDependencyCheck(
  check: (signal: AbortSignal) => Promise<void>,
  timeoutMs: number,
): () => Promise<DependencyStatus> {
  let inFlight: Promise<DependencyStatus> | undefined
  return () => {
    if (inFlight) return inFlight
    const controller = new AbortController()
    const work = Promise.resolve().then(() => check(controller.signal))
    const status = work.then<DependencyStatus, DependencyStatus>(
      () => 'ok',
      () => 'unavailable',
    )
    let timer: ReturnType<typeof setTimeout>
    const deadline = new Promise<DependencyStatus>((resolve) => {
      timer = setTimeout(() => {
        controller.abort(new Error('Readiness deadline exceeded'))
        resolve('unavailable')
      }, timeoutMs)
    })
    const attempt = Promise.race([status, deadline])
    inFlight = attempt
    // Keep the same unavailable result while a non-cooperative check is still
    // pending. Concurrent/repeated probes must not queue more dependency work.
    void status.then(() => {
      clearTimeout(timer)
      inFlight = undefined
    })
    return attempt
  }
}

const SLOW_REQUEST_MS = 2000

function publicRequestError(error: unknown): DomainError {
  if (error instanceof DomainError) return error
  if (error instanceof z.ZodError) {
    return new DomainError('INVALID_REQUEST', 'The request does not match its shared contract.', 400, {
      issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    })
  }
  if (error instanceof Error && 'code' in error) {
    switch (error.code) {
      case 'FST_ERR_CTP_INVALID_JSON_BODY':
      case 'FST_ERR_CTP_EMPTY_JSON_BODY':
        return new DomainError('INVALID_REQUEST', 'The request body must contain valid JSON.', 400)
      case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
        return new DomainError('INVALID_REQUEST', 'The request body does not match its Content-Length.', 400)
      case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
        return new DomainError('UNSUPPORTED_MEDIA_TYPE', 'The request content type is not supported.', 415)
      case 'FST_ERR_CTP_BODY_TOO_LARGE':
        return new DomainError('REQUEST_TOO_LARGE', 'The request body exceeds the allowed size.', 413)
    }
  }
  return new DomainError('INTERNAL_ERROR', 'The API could not complete the request.', 500)
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const timeoutMs = options.readinessTimeoutMs ?? 2000
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new RangeError('readinessTimeoutMs must be a positive 32-bit integer')
  }
  const app = Fastify({
    ...(typeof options.logger === 'object'
      ? { loggerInstance: options.logger }
      : { logger: options.logger ?? false }),
    genReqId: () => randomUUID(),
    // Startup hooks can outlast Fastify's 10 s default on a loaded computer; the service manager bounds startup.
    pluginTimeout: 0,
    // Fastify's per-request lines are replaced by one line whose level says whether it matters.
    logController: new LogController({ disableRequestLogging: true }),
  })
  // Fetch pools can replace aborted streams with connections that have no HTTP request yet.
  const unusedConnections = new Set<Socket>()
  let httpClosing = false
  app.server.on('connection', socket => {
    if (httpClosing) {
      socket.destroy()
      return
    }
    unusedConnections.add(socket)
    socket.once('close', () => unusedConnections.delete(socket))
  })
  app.server.on('request', request => unusedConnections.delete(request.socket))
  app.addHook('preClose', async () => {
    httpClosing = true
    for (const socket of unusedConnections) socket.destroy()
    unusedConnections.clear()
  })
  const closeInfrastructure = options.closeInfrastructure
  if (closeInfrastructure) {
    // Fastify closes hooks in reverse order; infrastructure outlives every runtime hook.
    app.addHook('onClose', async () => { await closeInfrastructure() })
  }
  // Timed delivery is an API lifecycle, never a browser or HTTP-request timer.
  app.addHook('onReady', async () => {
    options.operator?.services.runs?.startScheduleDispatcher?.((error, context) => {
      app.log.error(scheduleDispatchLog(error, context), 'schedule dispatch failed; durable state retained for retry')
    })
  })
  app.addHook('preClose', async () => { await options.operator?.services.runs?.stopScheduleDispatcher?.() })
  app.addHook('onResponse', async (request, reply) => {
    const statusCode = reply.statusCode, responseTimeMs = Math.round(reply.elapsedTime)
    // Routine success (the Board polls every 1.5s) is debug; failures and slow calls stay visible.
    const level = statusCode >= 500 ? 'error' : responseTimeMs >= SLOW_REQUEST_MS ? 'warn' : statusCode >= 400 ? 'info' : 'debug'
    // The path without its query string: queries can carry codes and tokens.
    request.log[level]({ method: request.method, path: request.url.split('?')[0], statusCode, responseTimeMs }, 'request completed')
  })
  if (options.operator || options.appMcp) {
    app.addHook('onRequest', async request => { requireLocalRequest(request) })
  }
  const checkDatabase = createDependencyCheck(
    (signal) => options.readiness.database.ping(signal), timeoutMs,
  )
  const checkCheckpoints = createDependencyCheck(
    (signal) => options.readiness.checkpoints.ping(signal), timeoutMs,
  )

  if (options.runtimeIdentity) {
    registerRuntimeInstallationSecurity(app, options.runtimeIdentity)
    app.get('/health/identity', async (_request, reply) => { reply.header('cache-control', 'no-store'); return frozenRuntimeIdentity(await options.runtimeIdentity!()) })
    app.get('/api/runtime/identity', async (_request, reply) => { reply.header('cache-control', 'no-store'); return frozenRuntimeIdentity(await options.runtimeIdentity!()) })
  }

  if (options.runtimeBuildIdentity) {
    app.get('/api/runtime/build-identity/v1', async (_request, reply) => {
      reply.header('cache-control', 'no-store')
      return RuntimeBuildIdentitySchema.parse(options.runtimeBuildIdentity!())
    })
  }

  app.get('/health/live', async () => ServiceHealthSchema.parse({ status: 'ok', service: 'graphql-api' }))

  app.get('/health/ready', async (_request, reply) => {
    const [database, checkpoints] = await Promise.all([checkDatabase(), checkCheckpoints()])
    const response: ServiceHealth = ServiceHealthSchema.parse({
      status: database === 'ok' && checkpoints === 'ok' ? 'ok' : 'unavailable',
      service: 'graphql-api',
      checks: { database, checkpoints },
    })
    if (response.status === 'unavailable') reply.code(503)
    return response
  })

  if (options.operator) registerOperatorHttpSecurity(app, options.operator.access, options.localHuman, options.browserOrigin)
  if (options.operator) registerManagementRoutes(app, options.operator.services)
  if (options.operator?.services.providerAccounts) registerProviderAccountRoutes(app, options.operator.services.providerAccounts)
  if (options.operator?.services.runPlacements) registerRunPlacementRoutes(app, options.operator.services.runPlacements)
  if (options.operator?.services.placementChoices) registerNodePlacementChoicesRoutes(app, options.operator.services.placementChoices)
  if (options.operator?.services.workflows?.schedules) registerWorkflowScheduleRoutes(app, options.operator.services.workflows.schedules)
  if (options.operator?.services.runGraph) registerRunGraphRoutes(app, options.operator.services.runGraph,
    (principalId, code, route) => options.operator!.services.commands.recordDenied(principalId, 'http', code, route))
  if (options.operator && options.mcpDetection) {
    registerMcpDetectionRoute(app, options.operator.services.locations, options.mcpDetection.service,
      options.operator.services.harnessSettings?.mcp)
  }
  if (options.operator?.services.agentChat) registerAgentChatRoutes(app, options.operator.services.agentChat)
  if (options.operator && options.product?.interactions) registerUserInteractions(app, options.product.interactions)
  if (options.product) registerProductRoutes(app, options.product, options.operator?.services)
  const bugReports = options.appMcp?.bugReports ?? options.operator?.services.bugReports
  const commands = options.appMcp?.commands ?? options.operator?.services.commands
  if (options.operator || options.appMcp) registerGraphqlMcp(app, {
    access: (options.operator?.access ?? options.appMcp?.access)!,
    ...(options.operator ? { operator: Object.assign(options.operator.services, { workerToolsMcpImplemented: Boolean(options.appMcp) }) } : {}),
    ...(options.appMcp ? { interactions: options.appMcp.interactions } : {}),
    ...(options.appMcp?.references ? { references: options.appMcp.references } : {}),
    ...(bugReports ? { bugReports } : {}),
    ...(commands ? { commands } : {}),
    ...(options.workerArtifacts ? { workerArtifacts: options.workerArtifacts } : {}),
  })

  app.setErrorHandler(async (error, request, reply) => {
    const failure = databaseConnectionFailure(databaseReadFailure(error))
    const domain = publicRequestError(failure)
    const failureClass = publicFailureClass(failure)
    if (domain.status >= 500) request.log.error({ err: error }, domain.message)
    const mcpRequest = request.url.split('?')[0] === '/mcp'
    if (mcpRequest && domain.status >= 400 && domain.status < 500 && domain.status !== 401) {
      request.log.warn({ code: domain.code, statusCode: domain.status }, 'MCP request rejected')
    }
    if (options.operator && !domain.denialAudited && (domain.status === 401 || domain.status === 403)
      && (request.url.startsWith('/api/') || mcpRequest)) {
      await options.operator.services.commands.recordDenied(
        request.operatorPrincipal?.id, mcpRequest ? 'mcp' : 'http',
        domain.code, request.url.split('?')[0] ?? request.url,
      ).catch((auditError: unknown) => request.log.error({ err: auditError }, 'management denial audit failed'))
    }
    const body = ApiErrorResponseSchema.parse({
      error: {
        code: domain.code,
        message: domain.message,
        ...(domain.details ? { details: domain.details } : {}),
        ...(failureClass ? { class: failureClass } : {}),
        requestId: request.id,
      },
    })
    return reply.code(domain.status).send(body)
  })

  app.setNotFoundHandler((request, reply) => {
    const body = ApiErrorResponseSchema.parse({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested API route was not found.',
        requestId: request.id,
      },
    })
    return reply.code(404).send(body)
  })

  return app
}
