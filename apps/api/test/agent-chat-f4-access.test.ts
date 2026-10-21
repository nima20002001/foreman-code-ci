import Fastify from 'fastify'
import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { agentChatFixtures, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import type { ManagementAction, ManagementPrincipal, ManagementScope, OperatorToolName } from '@foreman-code/contracts/management'
import type { McpServer } from '@modelcontextprotocol/server'

import { registerOperatorHttpSecurity } from '../src/modules/access/http.js'
import type { PostgresAccessService } from '../src/modules/access/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import type { AgentConversationRow, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import type { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { DomainError } from '../src/modules/errors.js'
import { operatorToolAvailable } from '../src/mcp/operator/availability.js'
import { agentChatTools } from '../src/mcp/operator/tools/agentChat.js'
import { registerOperatorToolGroup } from '../src/mcp/operator/server.js'
import type { OperatorRequestContext } from '../src/mcp/operator/types.js'
import { registerAgentChatRoutes } from '../src/routes/agentChat.js'

const base = agentChatFixtures.idleAfterCompletion
const actions: ManagementAction[] = ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel', 'agent_chat:respond']
function principal(allowed = actions, scope: ManagementScope = {}): ManagementPrincipal {
  return { id: 'f4-caller', name: 'F4 caller', audience: 'operator', grants: [{ actions: allowed, scope }], revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z' }
}

/** Real service authorization with substituted read ports; not PostgreSQL/provider proof. */
function fixture(runId?: string) {
  const context = { ...base.context, ...(runId ? { runId } : {}) }
  const row: AgentConversationRow = {
    id: base.conversation.id, agent_key: 'key', workspace_id: context.workspaceId, workflow_id: context.workflowId,
    workflow_node_id: context.workflowNodeId, agent_id: context.agentId, agent_configuration_version_id: 'config',
    origin_run_id: runId ?? null, origin_execution_id: runId ? 'execution' : null, harness: 'codex',
    provider_version: '0.154.0', native_session_id: 'session', active_request_id: null, active_native_turn_id: null,
    cancel_requested: false, turn_state: 'idle', last_error: null, revision: 7, pending_interaction: null, last_result: null,
    record: { origin: runId ? { kind: 'run_execution', runId, executionId: 'execution', sourceNativeSessionId: 'source' } : { kind: 'fresh' },
      workingDirectory: '/tmp/f4', runtimeDirectory: '/tmp/f4' },
    created_at: new Date(base.conversation.createdAt), updated_at: new Date(base.conversation.updatedAt),
  }
  let live: ManagementPrincipal | null = principal()
  const poolQuery = vi.fn(async (sql: string, values: unknown[]) => {
    if (sql.includes('from harness_native_events')) {
      return { rows: runId && values[0] === 'execution' && values[1] === runId
        && values[2] === context.workflowNodeId && values[3] === context.agentId
        ? [{ item_key: 'source-reply', role: 'assistant', content: 'Saved Run reply', original_bytes: 15,
          complete: true, sequence: '1', revision: '1' }] : [] }
    }
    if (!sql.startsWith('select ') || !sql.includes('from management_principals')) {
      throw new Error('Unexpected chat persistence operation')
    }
    return { rows: live && values[0] === live.id ? [{ id: live.id, name: live.name, audience: live.audience, grants: live.grants,
      expires_at: new Date(live.expiresAt), revoked_at: live.revokedAt ? new Date(live.revokedAt) : null, delegated_from: null }] : [] }
  })
  const repository = { get: vi.fn(async () => row), byKey: vi.fn(async () => row),
    state: vi.fn(async () => ({ row, turns: base.turns, messages: base.messages, hasEarlierMessages: false,
      activityPage: { activities: [], nextCursor: null, itemRevisions: {}, itemProvenance: {} }, unfinishedActivities: [],
      activeStartedAt: null, latestRequestId: base.turns.at(-1)?.requestId ?? null,
      selection: runId ? { workflowVersionId: 'version', attemptKey: '1' } : null })),
    history: vi.fn(async () => ({ messages: base.messages, nextCursor: null })),
    turn: vi.fn(async () => base.turns[0]),
    admit: vi.fn(async () => ({ conversationId: row.id, turn: base.turns[0], replayed: true })),
    cancelQueued: vi.fn(), requestCancel: vi.fn(), pending: vi.fn(),
  }
  const version = { definition: { nodes: [{ id: context.workflowNodeId, agentId: context.agentId }] } }
  const workflows = { getCurrentSavedVersion: async () => version, getSavedVersion: async () => version,
    getAgentConfiguration: async () => ({ id: 'config', agentId: context.agentId, harness: { harness: 'codex' } }) } as unknown as ConstructorParameters<typeof AgentChatService>[3]
  const runs = { getForWorkspace: async () => ({ workflowId: context.workflowId, workflowVersionId: 'version', executionState: 'completed', id: runId }),
    getExecution: async (id: string) => id === 'execution' ? { id, runId, workflowNodeId: context.workflowNodeId,
      agentId: context.agentId, agentConfigurationVersionId: 'config', attempt: 1, input: {}, state: 'completed',
      nativeSessionId: 'source', workingDirectory: '/tmp/chat-access', createdAt: base.conversation.createdAt } : undefined,
    async *executionPages() { yield [] } } as unknown as ConstructorParameters<typeof AgentChatService>[4]
  const native = vi.fn()
  const service = new AgentChatService({ query: poolQuery } as unknown as pg.Pool, repository as unknown as PostgresAgentChatRepository,
    {} as PostgresOperatorConversationRepository, workflows, runs, native, '/tmp/f4')
  const request: SendAgentChatMessageRequest = { requestId: 'request-1', content: base.messages[0]!.content, intent: 'next_turn',
    expectedConversationId: row.id, context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId,
      agentId: context.agentId, ...(runId ? { runId } : {}) } }
  return { service, repository, native, poolQuery, row, context, request,
    setLive: (value: ManagementPrincipal | null) => { live = value } }
}

function transport(f: ReturnType<typeof fixture>, caller: ManagementPrincipal) {
  f.setLive(caller)
  const app = Fastify()
  registerOperatorHttpSecurity(app, { authenticate: async (token: string) => {
    if (token !== 'f4-token') throw new DomainError('AUTH_INVALID', 'Invalid credential.', 401)
    return caller
  } } as unknown as PostgresAccessService)
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ code: error.code, message: error.message })
    return reply.code(400).send({ code: 'INVALID_REQUEST' })
  })
  registerAgentChatRoutes(app, f.service)
  return app
}
function mcpContext(service: AgentChatService, caller: ManagementPrincipal) {
  return { principal: caller, services: { agentChat: service, commands: { recordDenied: vi.fn(async () => undefined) } } } as unknown as OperatorRequestContext
}
const headers = { authorization: 'Bearer f4-token' }

describe('F4 A-R02/A-R03 scoped HTTP/MCP chat authorization', () => {
  for (const scope of ['workspace', 'workflow', 'run'] as const) {
    it(`${scope}: matching scoped HTTP read/history/replayed send works; mismatched resources disclose nothing`, async () => {
      const f = fixture(scope === 'run' ? 'run-f4' : undefined)
      const dimension = scope === 'workspace' ? 'workspaceIds' : scope === 'workflow' ? 'workflowIds' : 'runIds'
      const identity = scope === 'workspace' ? f.context.workspaceId : scope === 'workflow' ? f.context.workflowId : 'run-f4'
      for (const matching of [true, false]) {
        const caller = principal(actions, { [dimension]: [matching ? identity : 'other'] })
        const app = transport(f, caller)
        const root = `/api/workspaces/${f.context.workspaceId}/agent-chat`
        try {
          const query = new URLSearchParams(Object.entries(f.request.context).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString()
          for (const url of [`${root}?${query}`, `${root}/conversations/${f.row.id}/history`]) {
            const response = await app.inject({ method: 'GET', url, headers })
            expect(response.statusCode, response.body).toBe(matching ? 200 : 403)
            if (matching && scope === 'run' && url.startsWith(`${root}?`)) {
              expect(response.json().sourceTranscript).toMatchObject({ executionId: 'execution',
                messages: [{ role: 'assistant', content: 'Saved Run reply' }] })
            }
            if (!matching) {
              expect(response.body).not.toContain(base.messages[0]!.content)
              expect(response.body).not.toContain('Saved Run reply')
            }
          }
          const response = await app.inject({ method: 'POST', url: `${root}/messages`, headers, payload: f.request })
          expect(response.statusCode, response.body).toBe(matching ? 200 : 403)
          expect(operatorToolAvailable(mcpContext(f.service, caller), 'agent_chat_send')).toBe(true)
          expect(operatorToolAvailable(mcpContext(f.service, caller), 'agent_chat_send', {
            workspaceId: f.context.workspaceId, workflowId: f.context.workflowId,
            ...(f.context.runId ? { runId: f.context.runId } : {}),
          })).toBe(matching)
        } finally { await app.close() }
      }
      expect(f.repository.admit).toHaveBeenCalledTimes(1)
      expect(f.native).not.toHaveBeenCalled()
    })
  }

  for (const action of actions) {
    it(`${action} alone: mutation responses require read plus command authority before any effect`, async () => {
      const f = fixture(), caller = principal([action]), app = transport(f, caller)
      const root = `/api/workspaces/${f.context.workspaceId}/agent-chat`
      try {
        for (const [suffix, body] of [
          ['/messages', f.request],
          [`/conversations/${f.row.id}/interrupt`, { requestId: 'interrupt' }],
          [`/conversations/${f.row.id}/turns/request-1/cancel`, { requestId: 'cancel' }],
          [`/conversations/${f.row.id}/responses`, { requestId: 'respond', nativeRequestId: 'approval', optionId: 'approve' }],
        ] as const) {
          const response = await app.inject({ method: 'POST', url: `${root}${suffix}`, headers, payload: body })
          expect(response.statusCode, response.body).toBe(403)
          expect(response.body).not.toContain(base.messages[0]!.content)
        }
        for (const tool of ['agent_chat_send', 'agent_chat_interrupt', 'agent_chat_cancel_queued', 'agent_chat_respond'] as const) {
          expect(operatorToolAvailable(mcpContext(f.service, caller), tool)).toBe(false)
        }
        const history = await app.inject({ method: 'GET', url: `${root}/conversations/${f.row.id}/history`, headers })
        expect(history.statusCode).toBe(action === 'agent_chat:read' ? 200 : 403)
        expect(f.repository.admit).not.toHaveBeenCalled()
        expect(f.repository.cancelQueued).not.toHaveBeenCalled()
        expect(f.repository.requestCancel).not.toHaveBeenCalled()
        expect(f.repository.pending).not.toHaveBeenCalled()
        expect(f.native).not.toHaveBeenCalled()
      } finally { await app.close() }
    })
  }

  it.each(['revoked', 'expired', 'missing', 'read-grant-removed'] as const)(
    '%s live authority denies cached-principal transcript reads and controls before effects', async (failure) => {
      const f = fixture(), caller = principal(), app = transport(f, caller)
      f.setLive(failure === 'missing' ? null : failure === 'revoked' ? { ...caller, revokedAt: '2026-01-01T00:00:00Z' }
        : failure === 'expired' ? { ...caller, expiresAt: '2026-01-01T00:00:00Z' }
          : { ...caller, grants: [{ scope: {}, actions: ['agent_chat:write', 'agent_chat:cancel', 'agent_chat:respond'] }] })
      const root = `/api/workspaces/${f.context.workspaceId}/agent-chat`
      const query = new URLSearchParams(Object.entries(f.request.context).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString()
      try {
        for (const url of [`${root}?${query}`, `${root}/conversations/${f.row.id}/history`]) {
          const response = await app.inject({ method: 'GET', url, headers })
          expect(response.statusCode, response.body).toBe(403)
          expect(response.json().code).toBe(failure === 'read-grant-removed' ? 'ACCESS_DENIED' : 'AUTH_REVOKED')
          expect(response.body).not.toContain(base.messages[0]!.content)
        }
        for (const [suffix, payload] of [
          ['/interrupt', { requestId: 'interrupt' }],
          ['/turns/request-1/cancel', { requestId: 'cancel' }],
          ['/responses', { requestId: 'respond', nativeRequestId: 'approval', optionId: 'approve' }],
        ] as const) {
          const response = await app.inject({ method: 'POST', url: `${root}/conversations/${f.row.id}${suffix}`, headers, payload })
          expect(response.statusCode, response.body).toBe(403)
          expect(response.body).not.toContain(base.messages[0]!.content)
        }
        expect(f.poolQuery).toHaveBeenCalled()
        expect(f.repository.state).not.toHaveBeenCalled(); expect(f.repository.history).not.toHaveBeenCalled()
        expect(f.repository.admit).not.toHaveBeenCalled(); expect(f.repository.cancelQueued).not.toHaveBeenCalled()
        expect(f.repository.requestCancel).not.toHaveBeenCalled(); expect(f.repository.pending).not.toHaveBeenCalled()
        expect(f.native).not.toHaveBeenCalled()
      } finally { await app.close() }
    })

  it('A-R12 advertises strict shared MCP control schemas and carries their request IDs into the service', async () => {
    const f = fixture()
    type Tool = { inputSchema: { parse(value: unknown): Record<string, unknown> } }
    const tools = new Map<string, { definition: Tool; invoke: (value: Record<string, unknown>) => Promise<unknown> }>()
    const server = { registerTool: (name: string, definition: Tool, invoke: (value: Record<string, unknown>) => Promise<unknown>) => {
      tools.set(name, { definition, invoke })
    } }
    const interrupt = vi.spyOn(f.service, 'interrupt').mockResolvedValue(base)
    const cancel = vi.spyOn(f.service, 'cancelQueued').mockResolvedValue(base)
    const respond = vi.spyOn(f.service, 'respond').mockResolvedValue(base)
    registerOperatorToolGroup(server as unknown as McpServer, mcpContext(f.service, principal()), agentChatTools)
    const inputs: Partial<Record<OperatorToolName, Record<string, unknown>>> = {
      agent_chat_interrupt: { requestId: 'i', expectedNativeTurnId: 'turn-one' },
      agent_chat_cancel_queued: { requestId: 'c', turnRequestId: 'queued' },
      agent_chat_respond: { requestId: 'r', nativeRequestId: 'approval', optionId: 'yes' },
    }
    for (const [name, input] of Object.entries(inputs)) {
      const tool = tools.get(name)!
      const addressed = { workspaceId: f.context.workspaceId, conversationId: f.row.id, ...input }
      expect(() => tool.definition.inputSchema.parse({ ...addressed, requestId: undefined })).toThrow()
      await tool.invoke(tool.definition.inputSchema.parse(addressed))
    }
    expect(interrupt).toHaveBeenCalledWith(expect.anything(), f.context.workspaceId, f.row.id,
      { requestId: 'i', expectedNativeTurnId: 'turn-one' }, 'mcp')
    expect(cancel).toHaveBeenCalledWith(expect.anything(), f.context.workspaceId, f.row.id, 'queued', { requestId: 'c' }, 'mcp')
    expect(respond).toHaveBeenCalledWith(expect.anything(), f.context.workspaceId, f.row.id,
      { requestId: 'r', nativeRequestId: 'approval', optionId: 'yes' }, 'mcp')
  })
})
