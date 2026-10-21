import { settleObserved } from '../../modules/diagnostics/ignoredError.js'
import { unavailableResourceTelemetryToolCall } from '../operator/resourceTelemetryUnavailable.js'
import { unavailableDeviceOperatorToolCall, unavailableOperatorControlToolCall, unavailableProviderAccountToolCall, unavailableRunToolCall } from '../operator/unavailableTools.js'
import { unavailableJobToolCall } from '../operator/tools/jobs.js'
import { unavailableJobRuntimeToolCall } from '../operator/tools/jobRuntimeProfiles.js'
import { unavailableHostHarnessToolCall } from '../../modules/harnesses/instanceSettings/management.js'
import type { AgentReferenceService } from '../../modules/files/references/agentService.js'
import type { TemporaryFileService } from '../../modules/files/service.js'
import type { FileReferenceService } from '../../modules/files/references/service.js'
import { MAX_REFERENCE_MCP_BODY_BYTES } from '../../modules/files/references/requests.js'
import { unavailableFileReferenceToolCall } from '../operator/tools/fileReferences.js'
import { toNodeHandler } from '@modelcontextprotocol/node'
import type { ManagementAudience, ManagementPrincipal } from '@foreman-code/contracts/management'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { WebStandardStreamableHTTPServerTransport, type McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'

import { requireLocalRequest } from '../../modules/access/http.js'
import { bearerToken, type PostgresAccessService } from '../../modules/access/postgres.js'
import type { AppInteractionService } from '../../modules/interactions/app.js'
import type { BugReportService } from '../../modules/bug-reports/service.js'
import type { PostgresCommandCoordinator } from '../../modules/commands/postgres.js'
import { retiredExecutionToolCall } from '../operator/retiredExecutionTools.js'
import { unavailableCurrentWorkflowToolCall } from '../operator/tools/currentWorkflow.js'
import { unavailableRunGraphToolCall } from '../operator/tools/runGraph.js'
import { unavailableRunInspectionToolCall } from '../operator/tools/runInspection.js'
import { unavailableFileRetentionToolCall } from '../operator/tools/fileRetention.js'
import { unavailableWorkflowScheduleToolCall } from '../operator/tools/workflowSchedules.js'
import { unavailableRunHistoryToolCall } from '../operator/tools/runHistory.js'
import type { OperatorServices } from '../operator/types.js'
import type { McpRole } from './roles.js'
import { createGraphqlMcpServer, roleDeniedToolCall, type McpRequestRegistration } from './server.js'
import { McpRequestCancellation } from '../shared/cancellation.js'
import { withDatabaseReadRetry } from '../../infrastructure/databaseReadRetry.js'

export const GRAPHQL_MCP_PATH = '/mcp'
const RpcIdSchema = z.union([z.string(), z.number().int()])
const CancellableRequestSchema = z.object({
  jsonrpc: z.literal('2.0'), id: RpcIdSchema, method: z.literal('tools/call'),
}).passthrough()
const ArtifactReadToolSchema = z.object({ name: z.literal('files.read_edge_input') }).passthrough()
const CancellationSchema = z.object({
  jsonrpc: z.literal('2.0'), method: z.literal('notifications/cancelled'),
  params: z.object({ requestId: RpcIdSchema }).passthrough(),
}).strict()

/** Closed artifact group: separate native context authority, never graph-tool grants. */
export interface WorkerArtifactMcpExtension {
  register(server: McpServer, request: FastifyRequest, principal: ManagementPrincipal): Promise<void>
  call(request: FastifyRequest, principal: ManagementPrincipal, body: unknown): Promise<unknown | undefined>
}

export interface GraphqlMcpServices {
  access: PostgresAccessService
  /** Serves Operator credentials. */
  operator?: OperatorServices
  /** Serves Worker credentials (Orchestrator and Coder Agents). */
  interactions?: AppInteractionService
  references?: AgentReferenceService
  bugReports?: BugReportService
  commands?: PostgresCommandCoordinator
  workerArtifacts?: () => WorkerArtifactMcpExtension | undefined
}

/** The single, stateless Foreman Code MCP endpoint. The bearer credential decides the role. */
export function registerGraphqlMcp(app: FastifyInstance, services: GraphqlMcpServices): void {
  const cancellations = new McpRequestCancellation()
  // FIL-03 is composed after buildProductionApp. Bind the same service before any MCP request,
  // rather than constructing another storage/auth boundary or changing server startup ownership.
  app.addHook('onReady', async () => {
    if (services.operator && app.hasDecorator('temporaryFileService')) {
      services.operator.temporaryFiles = app.getDecorator<TemporaryFileService>('temporaryFileService')
    }
    if (services.operator && app.hasDecorator('fileReferenceService')) {
      services.operator.fileReferences = app.getDecorator<FileReferenceService>('fileReferenceService')
    }
  })
  const audiences: ManagementAudience[] = [
    ...(services.operator ? ['operator' as const] : []), ...(services.interactions ? ['worker' as const] : []),
  ]
  app.post(GRAPHQL_MCP_PATH, { bodyLimit: services.operator ? MAX_REFERENCE_MCP_BODY_BYTES : 1_000_000,
    // Large inline adds must authenticate before Fastify buffers/parses their bounded JSON body.
    onRequest: async (request) => {
      requireLocalRequest(request)
      await withDatabaseReadRetry(() => services.access.authenticate(bearerToken(request.headers.authorization), audiences))
    },
  }, async (request, reply) => {
    requireLocalRequest(request)
    const principal = await withDatabaseReadRetry(() =>
      services.access.authenticate(bearerToken(request.headers.authorization), audiences))
    const cancelled = CancellationSchema.safeParse(request.body)
    if (cancelled.success) {
      cancellations.cancel(principal.id, cancelled.data.params.requestId)
      return reply.code(202).send()
    }
    const call = CancellableRequestSchema.safeParse(request.body)
    const operation = call.success ? cancellations.track(principal.id, call.data.id) : undefined
    reply.raw.once('finish', () => operation?.finish())
    reply.raw.once('close', () => {
      if (!reply.raw.writableFinished) operation?.cancel()
      operation?.finish()
    })
    const access = principal.audience === 'operator' ? undefined : await withDatabaseReadRetry(() =>
      services.interactions!.toolAccess(principal), operation?.signal)
    const role: McpRole = access?.role ?? 'operator'
    if (role === 'operator' && services.operator) {
      const context = { principal, services: services.operator }
      // Retired execution tools and unlisted current writes still need authenticated denial audit,
      // rather than disappearing into the SDK's generic unknown-tool response.
      const unavailable = await unavailableResourceTelemetryToolCall(context, request.body)
        ?? await unavailableProviderAccountToolCall(context, request.body)
        ?? await unavailableFileRetentionToolCall(context, request.body)
        ?? await retiredExecutionToolCall(context, request.body)
        ?? await unavailableRunToolCall(context, request.body)
        ?? await unavailableCurrentWorkflowToolCall(context, request.body)
        ?? await unavailableRunGraphToolCall(context, request.body)
        ?? await unavailableRunInspectionToolCall(context, request.body)
        ?? await unavailableFileReferenceToolCall(context, request.body)
        ?? await unavailableWorkflowScheduleToolCall(context, request.body)
        ?? await unavailableRunHistoryToolCall(context, request.body)
        ?? await unavailableDeviceOperatorToolCall(context, request.body)
        ?? await unavailableOperatorControlToolCall(context, request.body)
        ?? await unavailableJobToolCall(context, request.body)
        ?? await unavailableJobRuntimeToolCall(context, request.body)
        ?? await unavailableHostHarnessToolCall(context, request.body)
      if (unavailable) return reply.send(unavailable)
    }
    const references = services.references ?? (app.hasDecorator('agentReferenceService')
      ? app.getDecorator<AgentReferenceService>('agentReferenceService') : undefined)
    const context = { role, principal,
      reauthorize: () => services.access.authenticate(bearerToken(request.headers.authorization), audiences),
      ...(references ? { references } : {}), ...(access ? { tools: access.tools } : {}),
      ...(operation ? { signal: operation.signal } : {}),
      ...(services.operator ? { operator: services.operator } : {}),
      ...(services.interactions ? { interactions: services.interactions } : {}),
      ...(services.bugReports ? { bugReports: services.bugReports } : {}),
      ...(services.commands ? { commands: services.commands } : {}) }
    // Cover every other known tool hidden by grants before the SDK handles unknown names.
    const registration: McpRequestRegistration = {}
    const denied = await roleDeniedToolCall(context, request.body, registration)
    if (denied) return reply.send(denied)
    const artifacts = principal.audience === 'worker' ? services.workerArtifacts?.() : undefined
    const artifactRead = call.success && ArtifactReadToolSchema.safeParse(call.data.params).success
    const invokeArtifact = async () => artifacts?.call(request, principal, request.body)
    const artifactCall = artifactRead
      ? await withDatabaseReadRetry(invokeArtifact, operation?.signal)
      : await invokeArtifact()
    if (artifactCall !== undefined) return reply.send(artifactCall)
    const server = await withDatabaseReadRetry(() =>
      createGraphqlMcpServer(context, request.body, registration), operation?.signal)
    // Artifact calls are dispatched above. Discovery's execution locks are only
    // needed for catalogs, not unrelated status or interaction reads.
    if (!call.success) await artifacts?.register(server, request, principal)
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined })
    reply.raw.once('close', () => { void settleObserved('http', 'close disconnected MCP resources', [transport.close(), server.close()]) })
    await server.connect(transport)
    reply.hijack()
    reply.raw.once('finish', () => {
      if (reply.raw.statusCode >= 400) request.log.warn({ statusCode: reply.raw.statusCode, audience: principal.audience, role,
        method: (request.body as { method?: unknown } | null)?.method ?? null }, 'MCP transport rejected request')
    })
    // Fastify already consumed the body; the adapter must not drain the raw request again.
    const handleRequest = toNodeHandler({
      fetch: (webRequest, options) => transport.handleRequest(webRequest, options),
    }, { onerror: error => request.log.error({ err: error }, 'MCP request adapter failed') })
    await handleRequest({
      method: request.method,
      url: request.url,
      headers: request.raw.headers,
      [Symbol.asyncIterator]: () => request.raw[Symbol.asyncIterator](),
    }, reply.raw, request.body)
  })
  for (const method of ['GET', 'DELETE'] as const) {
    app.route({ method, url: GRAPHQL_MCP_PATH, handler: async (request, reply) => {
      requireLocalRequest(request)
      await services.access.authenticate(bearerToken(request.headers.authorization), audiences)
      return reply.code(405).send({
        jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed.' }, id: null,
      })
    } })
  }
}
