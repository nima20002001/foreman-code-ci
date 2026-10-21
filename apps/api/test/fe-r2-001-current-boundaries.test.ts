import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import type { McpServer } from '@modelcontextprotocol/server'
import {
  CANONICAL_RUN_GRAPH_MCP_TOOLS, CANONICAL_RUN_GRAPH_ROUTES,
  CanonicalRunGraphReadRequestSchema, CanonicalRunGraphCurrentSchema, CanonicalRunGraphEventsResponseSchema,
} from '@foreman-code/contracts/wave25'
import { DomainError } from '../src/modules/errors.js'
import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import { registerRunGraphRoutes } from '../src/routes/runGraph.js'
import { registerRunGraphTools, unavailableRunGraphToolCall } from '../src/mcp/operator/tools/runGraph.js'
import type { OperatorRequestContext, OperatorServices } from '../src/mcp/operator/types.js'
import type { RunGraphReadApi } from '../src/modules/run-graph/readService.js'
import { currentGraphPrincipal, currentGraphReadUnit, currentGraphRequest } from './helpers/currentGraphReadUnit.js'

// In-process HTTP/MCP adapters, real canonical service and strict SQL model.
// Authentication is a credential resolver port, not browser login or live grants.
function tools(context: OperatorRequestContext, reads: RunGraphReadApi) {
  const registered = new Map<string, { definition: Record<string, unknown>; invoke(input: unknown): Promise<unknown> }>()
  const server = { registerTool(name: string, definition: Record<string, unknown>, invoke: (input: unknown) => Promise<unknown>) {
    registered.set(name, { definition, invoke })
  } } as unknown as McpServer
  registerRunGraphTools(server, context, reads)
  return registered
}
function url(kind: 'current' | 'events' = 'current') {
  const { scope } = currentGraphRequest
  const route = CANONICAL_RUN_GRAPH_ROUTES[kind].replace(':workspaceId', scope.workspaceId)
    .replace(':workflowId', scope.workflowId).replace(':runId', scope.runId)
  return `${route}?${new URLSearchParams({ workflowVersionId: scope.workflowVersionId, executionSemanticsVersion: '3',
    ...(kind === 'events' ? { afterSequence: '0' } : {}) })}`
}

describe('current workflow HTTP/MCP shared read boundaries', () => {
  it('returns unactivated nodes without invented native work through Operator MCP', async () => {
    const f = await currentGraphReadUnit()
    const services = { runGraph: f.reads } as unknown as OperatorServices
    const context = { principal: currentGraphPrincipal(), services }
    const tool = tools(context, f.reads).get(CANONICAL_RUN_GRAPH_MCP_TOOLS.current)!
    const response = await tool.invoke(f.request) as { structuredContent: unknown }
    const current = CanonicalRunGraphCurrentSchema.parse(decodeMcpToolResult(response))

    expect(current.asOfSequence).toBe('1')
    expect(current.state.executions).toEqual([])
    expect(current.state.nodes).toEqual(f.db.fixture.version.definition.nodes.map(({ id }) => ({
      state: { workflowNodeId: id, lifecycle: 'not_activated' },
      activity: { workflowNodeId: id, status: 'unknown' },
      attention: {
        workflowNodeId: id,
        pendingInteractionCount: 0,
        unsettledReviewCount: 0,
        cleanupPending: false,
        telemetry: 'unknown',
      },
    })))
  })
  it('uses the authenticated canonical HTTP route and the same service/schema as Operator MCP', async () => {
    const f = await currentGraphReadUnit(), recordDenied = vi.fn(async () => undefined)
    const services = { runGraph: f.reads, commands: { recordDenied } } as unknown as OperatorServices
    let principal = currentGraphPrincipal()
    const app = Fastify()
    app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 500)
      .send({ error: { code: error instanceof DomainError ? error.code : 'INVALID_INPUT', message: 'Request rejected' } }))
    registerOperatorHttpSecurity(app, { authenticate: async (token: string | undefined) => {
      if (token !== 'fe-r2-test-credential') throw new DomainError('AUTH_REQUIRED', 'Test credential required', 401)
      return principal
    } } as unknown as PostgresAccessService)
    registerRunGraphRoutes(app, f.reads, async (id, code, route) => { await recordDenied(); void id; void code; void route })
    try {
      const headers = { host: 'localhost', authorization: 'Bearer fe-r2-test-credential' }
      const response = await app.inject({ method: 'GET', url: url(), headers })
      expect(response.statusCode, response.body).toBe(200)
      const current = CanonicalRunGraphCurrentSchema.parse(response.json())
      expect(current.kind).toBe('current'); expect(current.scope.executionSemanticsVersion).toBe(3)
      expect(response.headers['cache-control']).toBe('private, no-store')
      expect(response.headers.vary).toBe('Authorization')
      expect(JSON.stringify(current)).not.toMatch(/PRIVATE-RUN-INPUT|executionLocation|authorizationPrincipalId|nativeSessionId/)
      const tool = tools({ principal, services }, f.reads).get(CANONICAL_RUN_GRAPH_MCP_TOOLS.current)!
      expect(tool.definition.inputSchema).toBe(CanonicalRunGraphReadRequestSchema)
      expect(tool.definition.outputSchema).toBe(CanonicalRunGraphCurrentSchema)
      const mcp = await tool.invoke(f.request) as { structuredContent: unknown }
      expect(CanonicalRunGraphCurrentSchema.parse(decodeMcpToolResult(mcp))).toEqual(current)
      const events = await app.inject({ method: 'GET', headers, url: url('events') })
      expect(events.statusCode, events.body).toBe(200)
      const history = CanonicalRunGraphEventsResponseSchema.parse(events.json())
      expect(history.kind).toBe('page')
      if (history.kind === 'page') {
        expect(history.batches).toHaveLength(1); expect(history.throughSequence).toBe('1'); expect(history.hasMore).toBe(false)
      }
      const calls = f.db.calls.length
      expect((await app.inject({ method: 'GET', url: url(), headers: { host: 'localhost', authorization: 'Bearer invalid' } })).statusCode).toBe(401)
      const retired = await app.inject({ method: 'GET', headers, url: url().replace('executionSemanticsVersion=3', 'executionSemanticsVersion=2') })
      expect(retired.statusCode).toBe(409); expect(retired.json().error.code).toBe('GRAPH_SCOPE_MISMATCH')
      principal = currentGraphPrincipal(false)
      expect((await app.inject({ method: 'GET', headers, url: url() })).statusCode).toBe(403)
      expect(f.db.calls).toHaveLength(calls)
    } finally { await app.close() }
  })
  it('keeps discovery parity and audits hidden/direct MCP denials before protected metadata reads', async () => {
    const f = await currentGraphReadUnit(), recordDenied = vi.fn(async (...args: unknown[]) => { void args; return undefined })
    const services = { runGraph: f.reads, commands: { recordDenied } } as unknown as OperatorServices
    const denied = { principal: currentGraphPrincipal(false), services }
    expect(tools(denied, f.reads).has(CANONICAL_RUN_GRAPH_MCP_TOOLS.current)).toBe(false)
    const hidden = await unavailableRunGraphToolCall(denied, { jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: CANONICAL_RUN_GRAPH_MCP_TOOLS.current, arguments: f.request } })
    expect(hidden?.result.isError).toBe(true); expect(f.db.calls).toEqual([])
    const principal = currentGraphPrincipal(); principal.grants[0]!.scope.workflowIds = ['foreign-workflow']
    const context = { principal, services }, tool = tools(context, f.reads).get(CANONICAL_RUN_GRAPH_MCP_TOOLS.current)!
    const result = await tool.invoke(f.request) as { isError: boolean; structuredContent?: unknown }
    expect(result.isError).toBe(true); expect(result.structuredContent).toBeUndefined()
    expect(f.db.scopeReads).toBe(1)
    f.db.assertNoProtectedGraphReads()
    expect(recordDenied).toHaveBeenLastCalledWith(context.principal.id, 'mcp', 'GRAPH_READ_ACCESS_DENIED',
      `mcp:${CANONICAL_RUN_GRAPH_MCP_TOOLS.current}`)
  })
})
