import { z } from 'zod'
import { hasAction, isAuthorized } from '../../modules/access/policy.js'
import { DomainError } from '../../modules/errors.js'
import { toolFailure } from '../shared/results.js'
import { TELEMETRY_READ_ACTIONS } from './availability.js'
import type { OperatorRequestContext } from './types.js'

const Call = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.enum(['resource_telemetry_read', 'resource_telemetry_selector_get']) }).passthrough() }).passthrough()
/** Preserve authenticated denials for hidden tools and explicit missing-domain readback. */
export async function unavailableResourceTelemetryToolCall(context: OperatorRequestContext, body: unknown) {
  const parsed = Call.safeParse(body)
  if (!parsed.success) return undefined
  const allowed = TELEMETRY_READ_ACTIONS.some(action => action === 'devices:metrics:read'
    ? isAuthorized(context.principal, action, {}) : hasAction(context.principal, action))
  if (allowed && context.services.resourceTelemetry) return undefined
  const name = parsed.data.params.name
  if (!allowed) await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
  return { jsonrpc: '2.0' as const, id: parsed.data.id, result: toolFailure(new DomainError(
    allowed ? 'RESOURCE_TELEMETRY_UNAVAILABLE' : 'ACCESS_DENIED',
    allowed ? 'The actual resource telemetry runtime is unavailable.' : 'A relevant explicit telemetry read grant is required.', allowed ? 503 : 403)) }
}
