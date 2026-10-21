import { RETIRED_EXECUTION_TOOLS } from '@foreman-code/contracts/wave25'
import { z } from 'zod'
import { DomainError } from '../../modules/errors.js'
import { toolFailure } from '../shared/results.js'
import type { OperatorRequestContext } from './types.js'

/** Tombstones, not compatibility adapters. Never register, dispatch, convert or
 * read an old execution shape. Independent graph/MCP/native wire versions remain. */
const retired = new Set<string>(RETIRED_EXECUTION_TOOLS)
export const retiredExecutionTool = (name: string): boolean => retired.has(name)
const Call = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.string() }).passthrough() }).passthrough()

/** Called only after the existing credential/Host/Origin checks. An obsolete
 * tool name is an explicit unsupported operation, not permission to execute. */
export async function retiredExecutionToolCall(context: OperatorRequestContext, body: unknown) {
  const call = Call.safeParse(body)
  if (!call.success || !retiredExecutionTool(call.data.params.name)) return undefined
  const name = call.data.params.name
  await context.services.commands.recordAudit(context.principal.id, 'mcp', name, `mcp:${name}`, 'failed',
    { code: 'EXECUTION_SEMANTICS_UNSUPPORTED' })
  return { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(new DomainError(
    'EXECUTION_SEMANTICS_UNSUPPORTED',
    'This execution adapter is retired. Use current V3 workflow authoring and canonical graph reads.', 409)) }
}
