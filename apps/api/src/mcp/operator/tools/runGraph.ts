import type { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import {
  CANONICAL_RUN_GRAPH_MCP_TOOLS as RUN_GRAPH_MCP_TOOLS,
  CanonicalRunGraphReadRequestSchema as RunGraphReadRequestSchema,
  CanonicalRunGraphEventsRequestSchema as RunGraphEventsRequestSchema,
  CanonicalRunGraphSnapshotSchema as RunGraphSnapshotSchema,
  CanonicalRunGraphEventsResponseSchema as RunGraphEventsResponseSchema,
  CanonicalRunGraphCurrentSchema, CanonicalRunGraphReadCapabilitiesSchema,
} from '@foreman-code/contracts/wave25'
import { hasAction, isAuthorized } from '../../../modules/access/policy.js'
import type { OperatorRequestContext } from '../types.js'
import { canonicalRunGraphReadApi } from '../../../modules/run-graph/repeatReadService.js'
import type { RunGraphReadApi } from '../../../modules/run-graph/readService.js'
import { RunGraphError, runGraphErrorResponse } from '../../../modules/run-graph/errors.js'
import { ignoreError } from '../../../modules/diagnostics/ignoredError.js'

/** Current execution reads; independent graph/MCP protocol versions are unchanged. */
export function registerRunGraphTools(server: McpServer, context: OperatorRequestContext, reads: RunGraphReadApi): void {
  const canonical = canonicalRunGraphReadApi(reads)
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  const invoke = async (name: string, work: () => Promise<unknown> | unknown) => {
    try {
      const value = await work()
      return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> }
    } catch (error) {
      const safe = error instanceof RunGraphError ? error : new RunGraphError('GRAPH_INVARIANT_VIOLATION')
      if (safe.code === 'GRAPH_READ_ACCESS_DENIED') await context.services.commands.recordDenied(
        context.principal.id, 'mcp', safe.code, `mcp:${name}`).catch(ignoreError('http', 'record denied run graph read audit', { tool: name }))
      return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(runGraphErrorResponse(safe)) }] }
    }
  }
  if (runGraphToolAvailable(context, RUN_GRAPH_MCP_TOOLS.capabilities)) server.registerTool(RUN_GRAPH_MCP_TOOLS.capabilities, {
    description: 'Read canonical graph protocol-1 capabilities for current semantics-3 persisted metadata only. Not runtime admission or Stop qualification.',
    inputSchema: z.object({}).strict(), outputSchema: CanonicalRunGraphReadCapabilitiesSchema, annotations,
  }, async () => invoke(RUN_GRAPH_MCP_TOOLS.capabilities, () => reads.capabilities(context.principal)))
  if (runGraphToolAvailable(context, RUN_GRAPH_MCP_TOOLS.readCapabilities)) server.registerTool(RUN_GRAPH_MCP_TOOLS.readCapabilities, {
    description: 'Discover qualified persisted canonical graph READS: current, snapshot, complete batches, reset and retention. Semantics-3 payloads are metadata only. This grants no native Start, Stop settlement or meaningful-edit support.',
    inputSchema: z.object({}).strict(), outputSchema: CanonicalRunGraphReadCapabilitiesSchema, annotations,
  }, async () => invoke(RUN_GRAPH_MCP_TOOLS.readCapabilities, () => canonical.readCapabilities(context.principal)))
  if (runGraphToolAvailable(context, RUN_GRAPH_MCP_TOOLS.snapshot)) server.registerTool(RUN_GRAPH_MCP_TOOLS.snapshot, {
    description: 'Read a coherent, bounded graph snapshot for the exact authorized workspace/workflow/Run/version. Current node resolutions retain the newest 2000 rows. Truncated native checkpoints report unknown activity until complete evidence repairs them. No native bodies or filesystem details.',
    inputSchema: RunGraphReadRequestSchema, outputSchema: RunGraphSnapshotSchema, annotations,
  }, async (input) => invoke(RUN_GRAPH_MCP_TOOLS.snapshot, async () => RunGraphSnapshotSchema.parse(await canonical.snapshot(context.principal, input))))
  if (runGraphToolAvailable(context, RUN_GRAPH_MCP_TOOLS.current)) server.registerTool(RUN_GRAPH_MCP_TOOLS.current, {
    description: 'Read the exact authorized canonical current cut. Semantics 3 only; ordinary nodes have no synthetic repeat occurrence. Requires runs:read; unqualified v3 remains unavailable.',
    inputSchema: RunGraphReadRequestSchema, outputSchema: CanonicalRunGraphCurrentSchema, annotations,
  }, async (input) => invoke(RUN_GRAPH_MCP_TOOLS.current,
    async () => CanonicalRunGraphCurrentSchema.parse(await canonical.current(context.principal, input))))
  if (runGraphToolAvailable(context, RUN_GRAPH_MCP_TOOLS.events)) server.registerTool(RUN_GRAPH_MCP_TOOLS.events, {
    description: 'Read complete semantic batches after an exact decimal cursor, or an explicit reset. Never advance past throughSequence.',
    inputSchema: RunGraphEventsRequestSchema, outputSchema: RunGraphEventsResponseSchema, annotations,
  }, async (input) => invoke(RUN_GRAPH_MCP_TOOLS.events, async () => RunGraphEventsResponseSchema.parse(await canonical.events(context.principal, input))))
}

export function runGraphToolAvailable(context: OperatorRequestContext, name: string): boolean {
  if (!context.services.runGraph || !Object.values(RUN_GRAPH_MCP_TOOLS).some((tool) => tool === name)
    || !hasAction(context.principal, 'runs:read')) return false
  return name !== RUN_GRAPH_MCP_TOOLS.capabilities && name !== RUN_GRAPH_MCP_TOOLS.readCapabilities
    || isAuthorized(context.principal, 'capabilities:read')
}
const GraphToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.enum(Object.values(RUN_GRAPH_MCP_TOOLS)) }).passthrough() }).passthrough()
/** An authenticated caller cannot avoid audit by invoking a hidden graph tool. */
export async function unavailableRunGraphToolCall(context: OperatorRequestContext, body: unknown) {
  const call = GraphToolCall.safeParse(body)
  if (!call.success || runGraphToolAvailable(context, call.data.params.name)) return undefined
  const error = new RunGraphError(context.services.runGraph ? 'GRAPH_READ_ACCESS_DENIED' : 'GRAPH_NOT_INITIALIZED')
  if (error.code === 'GRAPH_READ_ACCESS_DENIED') await context.services.commands.recordDenied(
    context.principal.id, 'mcp', error.code, `mcp:${call.data.params.name}`)
  return { jsonrpc: '2.0' as const, id: call.data.id, result: { isError: true,
    content: [{ type: 'text' as const, text: JSON.stringify(runGraphErrorResponse(error)) }] } }
}
