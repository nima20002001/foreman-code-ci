import {
  GetInteractionResponseSchema, ListInteractionsResponseSchema, RespondToInteractionRequestSchema,
  RespondToInteractionResponseSchema,
} from '@foreman-code/contracts'
import { InteractionListInputSchema } from '@foreman-code/contracts/management'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { FastifyInstance, FastifyRequest } from 'fastify'

import { requireLocalHuman, requirePrincipal } from '../modules/access/http.js'
import { canUserInteract } from '../modules/access/userPolicy.js'
import { DomainError } from '../modules/errors.js'
import type { InteractionService } from '../modules/interactions/service.js'

export function registerUserInteractions(app: FastifyInstance, interactions: InteractionService): void {
  const authenticate = (request: FastifyRequest): ManagementPrincipal => {
    requireLocalHuman(request)
    const human = requirePrincipal(request)
    return { ...human, audience: 'user', grants: [{ actions: ['interactions:read', 'interactions:respond'], scope: {} }] }
  }
  app.get<{ Querystring: Record<string, unknown> }>('/api/user/interactions', async (request) => {
    const principal = await authenticate(request)
    const query = request.query
    const input = InteractionListInputSchema.parse({ ...query, ...(query.limit !== undefined ? { limit: Number(query.limit) } : {}) })
    const resource = { ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), ...(input.workflowId ? { workflowId: input.workflowId } : {}), ...(input.runId ? { runId: input.runId } : {}) }
    if (!canUserInteract(principal, 'interactions:read', resource)) throw new DomainError('ACCESS_DENIED', 'The User cannot read this scope.', 403)
    if (input.cursor) {
      const cursor = await interactions.get(input.cursor)
      if (cursor.approval.handler !== 'user' || !canUserInteract(principal, 'interactions:read', cursor)
        || input.workspaceId && cursor.workspaceId !== input.workspaceId
        || input.workflowId && cursor.workflowId !== input.workflowId || input.runId && cursor.runId !== input.runId) {
        throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
      }
    }
    const page = await interactions.list({ ...resource, handler: 'user', limit: input.limit, ...(input.status ? { status: input.status } : {}), ...(input.cursor ? { cursor: input.cursor } : {}) })
    return ListInteractionsResponseSchema.parse(page)
  })
  app.get<{ Params: { interactionId: string } }>('/api/user/interactions/:interactionId', async (request) => {
    const principal = await authenticate(request)
    const interaction = await interactions.get(request.params.interactionId)
    if (interaction.approval.handler !== 'user' || !canUserInteract(principal, 'interactions:read', interaction)) {
      throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
    }
    const activity = await interactions.readActivity(interaction, canUserInteract(principal, 'interactions:respond', interaction))
    return GetInteractionResponseSchema.parse({ interaction, activity, canRespond: activity.response.available })
  })
  app.post<{ Params: { interactionId: string }; Body: unknown }>('/api/user/interactions/:interactionId/respond', async (request) => {
    const principal = await authenticate(request)
    const input = RespondToInteractionRequestSchema.parse(request.body)
    if (input.interactionId !== request.params.interactionId) throw new DomainError('INVALID_INTERACTION', 'The response does not match the requested interaction.', 400)
    const interaction = await interactions.get(input.interactionId)
    if (interaction.approval.handler !== 'user' || !canUserInteract(principal, 'interactions:respond', interaction)) {
      throw new DomainError('INTERACTION_NOT_FOUND', 'The interaction was not found.', 404)
    }
    return RespondToInteractionResponseSchema.parse(await interactions.respond({ kind: 'user', principal }, input))
  })
}
