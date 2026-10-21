import { z } from 'zod'
import { DeliveryTargetSchema } from '@foreman-code/contracts'
import type { FastifyInstance } from 'fastify'
import { requirePrincipal } from '../access/http.js'
import { DomainError } from '../errors.js'
import type { ChatDeliveryRouter } from './delivery.js'

const read = z.object({ target: DeliveryTargetSchema, cursor: z.string().optional(), limit: z.number().int().min(1).max(100).optional(),
  commandId: z.string().min(1).optional(), receiptId: z.string().min(1).optional(), deliveryInputs: z.object({ cursor: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(), receiptId: z.string().min(1).optional(), bodyCursor: z.string().optional() }).optional() })

export function registerAgentDeliveryRoutes(app: FastifyInstance, delivery: ChatDeliveryRouter): void {
  const root = '/api/workspaces/:workspaceId/agent-chat/deliveries'
  register(app, root, delivery, (params, target) => {
    if (target.kind === 'operator_conversation' || target.agent.workspaceId !== params.workspaceId) {
      throw new DomainError('CHAT_TARGET_SCOPE_MISMATCH', 'This target does not belong to the selected workspace.', 403)
    }
  })
}

export function registerOperatorDeliveryRoutes(app: FastifyInstance, delivery: ChatDeliveryRouter): void {
  const root = '/api/operator/conversations/:conversationId/deliveries'
  register(app, root, delivery, (params, target) => {
    if (target.kind !== 'operator_conversation' || target.conversationId !== params.conversationId) {
      throw new DomainError('CHAT_TARGET_SCOPE_MISMATCH', 'This target does not belong to the selected Operator conversation.', 403)
    }
  })
}

function register(app: FastifyInstance, root: string, delivery: ChatDeliveryRouter,
  assertScope: (params: Record<string, string>, target: z.infer<typeof DeliveryTargetSchema>) => void): void {
  app.post<{ Params: Record<string, string>; Body: unknown }>(`${root}/read`, async request => {
    const input = read.parse(request.body)
    assertScope(request.params, input.target)
    return delivery.read(requirePrincipal(request), input)
  })
  for (const operation of ['send', 'stop', 'cancel'] as const) {
    app.post<{ Params: Record<string, string>; Body: unknown }>(`${root}/${operation}`, async request => {
      const input = z.object({ target: DeliveryTargetSchema }).passthrough().parse(request.body)
      assertScope(request.params, input.target)
      return delivery[operation](requirePrincipal(request), input)
    })
  }
}
