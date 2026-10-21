import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import {
  GraphIdSchema, GraphSequenceSchema, CANONICAL_RUN_GRAPH_ROUTES as RUN_GRAPH_ROUTES,
  CanonicalRunGraphSnapshotSchema, CanonicalRunGraphCurrentSchema, CanonicalRunGraphEventsResponseSchema,
  CanonicalRunGraphHttpSnapshotQuerySchema as RunGraphHttpSnapshotQuerySchema,
  CanonicalRunGraphHttpEventsQuerySchema as RunGraphHttpEventsQuerySchema,
} from '@foreman-code/contracts/wave25'
import { canonicalRunGraphReadApi } from '../modules/run-graph/repeatReadService.js'
import type { RunGraphReadApi } from '../modules/run-graph/readService.js'
import { RunGraphError, runGraphErrorResponse, runGraphErrorStatus } from '../modules/run-graph/errors.js'
import { ignoreError } from '../modules/diagnostics/ignoredError.js'

const Params = z.object({ workspaceId: GraphIdSchema, workflowId: GraphIdSchema, runId: GraphIdSchema }).strict()
export type GraphHttpDenialAudit = (principalId: string | undefined, code: string, route: string) => Promise<void>

/** Register ONLY after the existing Operator HTTP authentication/security hook. */
export function registerRunGraphRoutes(app: FastifyInstance, reads: RunGraphReadApi, recordDenied: GraphHttpDenialAudit): void {
  const canonical = canonicalRunGraphReadApi(reads)
  const invoke = async (request: FastifyRequest, reply: FastifyReply, route: string, work: () => Promise<unknown> | unknown) => {
    reply.header('Cache-Control', 'private, no-store').header('Vary', 'Authorization')
    try {
      if (!request.operatorPrincipal) throw new RunGraphError('GRAPH_READ_ACCESS_DENIED')
      return await work()
    } catch (error) {
      const safe = error instanceof RunGraphError ? error : new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      if (safe.code === 'GRAPH_READ_ACCESS_DENIED') {
        await recordDenied(request.operatorPrincipal?.id, safe.code, route).catch(ignoreError('http', 'record denied run graph read audit', { route }))
      }
      return reply.code(runGraphErrorStatus(safe.code)).send(runGraphErrorResponse(safe))
    }
  }
  app.get(RUN_GRAPH_ROUTES.capabilities, (request, reply) => invoke(request, reply, RUN_GRAPH_ROUTES.capabilities,
    () => reads.capabilities(request.operatorPrincipal!)))
  app.get(RUN_GRAPH_ROUTES.readCapabilities, (request, reply) => invoke(request, reply, RUN_GRAPH_ROUTES.readCapabilities,
    () => canonical.readCapabilities(request.operatorPrincipal!)))
  for (const kind of ['snapshot', 'current'] as const) app.get(RUN_GRAPH_ROUTES[kind], (request, reply) =>
    invoke(request, reply, RUN_GRAPH_ROUTES[kind], async () => {
      const parameters = Params.safeParse(request.params), query = RunGraphHttpSnapshotQuerySchema.safeParse(request.query)
      if (!parameters.success || !query.success) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
      const value = await canonical[kind](request.operatorPrincipal!, { protocolVersion: 1, scope: {
        ...parameters.data, workflowVersionId: query.data.workflowVersionId,
        executionSemanticsVersion: 3,
      } })
      return (kind === 'snapshot' ? CanonicalRunGraphSnapshotSchema : CanonicalRunGraphCurrentSchema).parse(value)
    }))
  app.get(RUN_GRAPH_ROUTES.events, (request, reply) => invoke(request, reply, RUN_GRAPH_ROUTES.events, async () => {
    const parameters = Params.safeParse(request.params), query = RunGraphHttpEventsQuerySchema.safeParse(request.query)
    const cursor = typeof request.query === 'object' && request.query !== null && 'afterSequence' in request.query
      ? request.query.afterSequence : undefined
    if (!GraphSequenceSchema.safeParse(cursor).success) throw new RunGraphError('GRAPH_INVALID_CURSOR')
    if (!parameters.success || !query.success) throw new RunGraphError('GRAPH_SCOPE_MISMATCH')
    return CanonicalRunGraphEventsResponseSchema.parse(await canonical.events(request.operatorPrincipal!, { protocolVersion: 1, afterSequence: query.data.afterSequence, scope: {
      ...parameters.data, workflowVersionId: query.data.workflowVersionId,
      executionSemanticsVersion: 3,
    } }))
  }))
}
