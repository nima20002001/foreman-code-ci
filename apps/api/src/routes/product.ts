import {
  ListAgentsResponseSchema,
  ListInteractionsResponseSchema,
  GetInteractionResponseSchema,
  RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
} from '@foreman-code/contracts'
import { SavedWorkflowResponseSchema, SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import type { OperatorServices } from '../mcp/operator/types.js'
import { InteractionListInputSchema } from '@foreman-code/contracts/management'
import type { FastifyInstance } from 'fastify'

import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { LangGraphWorkflowEngine } from '../modules/runs/engine.js'
import type { PostgresRunRepository } from '../modules/runs/postgres.js'
import type { PostgresWorkflowRepository } from '../modules/workflows/postgres.js'
import type { PostgresWorkspaceRepository } from '../modules/workspaces/postgres.js'
import type { OperatorChatService } from '../modules/conversations/operatorChat.js'
import { registerOperatorChatRoutes } from './operatorChat.js'
import type { InteractionService } from '../modules/interactions/service.js'

export interface ProductServices {
  workspaces: PostgresWorkspaceRepository
  workflows: PostgresWorkflowRepository
  runs: PostgresRunRepository
  engine: LangGraphWorkflowEngine
  chat?: OperatorChatService
  interactions?: InteractionService
}

interface WorkspaceParams { workspaceId: string }
interface WorkflowParams extends WorkspaceParams { workflowId: string }
interface RunParams extends WorkspaceParams { runId: string }

function notFound(kind: string, id: string): never {
  throw new DomainError(`${kind.toUpperCase()}_NOT_FOUND`, `${kind} '${id}' was not found.`, 404)
}

export function registerProductRoutes(
  app: FastifyInstance, services: ProductServices, management?: Pick<OperatorServices, 'workflows' | 'runs'>,
): void {
  if (services.chat) registerOperatorChatRoutes(app, services.chat)
  app.get<{ Params: WorkspaceParams }>('/api/workspaces/:workspaceId', async (request) => {
    const details = await services.workspaces.getDetails(request.params.workspaceId, requirePrincipal(request))
    // getDetails already returns a SavedWorkspaceDetailsSchema-parsed value; a second parse of this large read only costs time.
    return details ?? notFound('workspace', request.params.workspaceId)
  })

  app.get<{ Params: WorkspaceParams }>('/api/workspaces/:workspaceId/agents', async (request) =>
    ListAgentsResponseSchema.parse({ agents: await services.workspaces.listAgents(request.params.workspaceId) }))

  app.get<{ Params: WorkflowParams }>('/api/workspaces/:workspaceId/workflows/:workflowId', async (request) => {
    const principal = requirePrincipal(request)
    if (!management) throw new DomainError('WORKFLOW_SERVICES_UNAVAILABLE', 'Current workflow services are not composed.', 503)
    const managed = await management.workflows.get(principal, request.params.workspaceId, request.params.workflowId)
    return SavedWorkflowResponseSchema.parse({ workflow: managed.workflow })
  })

  // Raw workflow Save/Start and cancel adapters are retired. All mutations use
  // the authenticated revision/receipt-checked current management family.
  app.get<{ Params: RunParams }>('/api/workspaces/:workspaceId/runs/:runId', async (request) => {
    const principal = requirePrincipal(request)
    if (!management) throw new DomainError('RUN_SERVICES_UNAVAILABLE', 'Current Run services are not composed.', 503)
    const details = await management.runs.get(principal, request.params.workspaceId, request.params.runId)
    return details ? SavedRunDetailsSchema.parse(details) : notFound('run', request.params.runId)
  })

  const interactions = services.interactions
  if (interactions) {
    if (management) {
      app.get<{ Querystring: unknown }>('/api/management/interactions', async (request) => {
        const query = request.query as Record<string, unknown>
        const input = InteractionListInputSchema.parse({
          ...query, ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}),
        })
        return ListInteractionsResponseSchema.parse(await interactions.listVisible(requirePrincipal(request), input))
      })
      app.get<{ Params: { interactionId: string } }>('/api/management/interactions/:interactionId', async (request) => {
        const detail = await interactions.reviewStatusVisible(requirePrincipal(request), request.params.interactionId)
        return GetInteractionResponseSchema.parse({ ...detail, canRespond: detail.activity.response.available })
      })
      app.post<{ Params: { interactionId: string }; Body: unknown }>(
        '/api/management/interactions/:interactionId/respond', async (request) => {
          const input = RespondToInteractionRequestSchema.parse(request.body)
          if (input.interactionId !== request.params.interactionId) {
            throw new DomainError('INVALID_INTERACTION', 'The response does not match the requested interaction.', 400)
          }
          return RespondToInteractionResponseSchema.parse(await interactions.respond(
            { kind: 'operator', principal: requirePrincipal(request) }, input))
        })
    }
  }

}
