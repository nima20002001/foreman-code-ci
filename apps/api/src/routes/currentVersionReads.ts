import type { FastifyInstance } from 'fastify'
import { WorkflowVersionGetInputSchema, WorkflowVersionListInputSchema, AgentVersionGetInputSchema,
  AgentVersionResultSchema } from '@foreman-code/contracts/management'
import { CurrentWorkflowVersionDetailSchema, CurrentWorkflowVersionPageSchema } from '@foreman-code/contracts/wave25'
import type { OperatorServices } from '../mcp/operator/types.js'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'

/** The Board reads the SAME immutable history service exposed to Operator MCP.
 * The service verifies grants, physical row identity and immutable content; no moving-head projection. */
export function registerCurrentVersionReadRoutes(app: FastifyInstance, services: OperatorServices): void {
  const history = () => {
    if (!services.extensions) throw new DomainError('VERSION_HISTORY_UNAVAILABLE', 'Immutable version reads are unavailable.', 503)
    return services.extensions.history
  }
  app.get<{ Params: Record<string, string>; Querystring: Record<string, string | undefined> }>(
    '/api/management/workspaces/:workspaceId/workflows/:workflowId/versions', async (request) => {
      const principal = requirePrincipal(request)
      const input = WorkflowVersionListInputSchema.parse({ ...request.params,
        ...(request.query.cursor ? { cursor: request.query.cursor } : {}),
        ...(request.query.limit ? { limit: Number(request.query.limit) } : {}) })
      return CurrentWorkflowVersionPageSchema.parse(await history().workflows(principal, input))
    })
  app.get<{ Params: Record<string, string> }>(
    '/api/management/workspaces/:workspaceId/workflows/:workflowId/versions/:versionId', async (request) => {
      const principal = requirePrincipal(request)
      return CurrentWorkflowVersionDetailSchema.parse(await history().workflow(principal, WorkflowVersionGetInputSchema.parse(request.params)))
    })
  app.get<{ Params: Record<string, string> }>(
    '/api/management/workspaces/:workspaceId/agents/:agentId/versions/:versionId', async (request) => {
      const principal = requirePrincipal(request)
      return AgentVersionResultSchema.parse(await history().agent(principal, AgentVersionGetInputSchema.parse(request.params)))
    })
}
