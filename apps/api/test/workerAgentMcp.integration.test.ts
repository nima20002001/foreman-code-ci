import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { AgentSubject } from '@foreman-code/contracts'
import { WorkerConversationBindingSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { AcceptedHarnessProfileAdmission } from '../src/modules/harnesses/instanceSettings/acceptedProfile.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import type { ClaudeProfileOwner } from '../src/modules/harnesses/claudeSdk/production.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { DomainError } from '../src/modules/errors.js'
import { MainWorkerConversationMcp, type WorkerConversationAgentMcp } from '../src/modules/conversations/mainWorkerMcp.js'
import { MainWorkerConversationBridge } from '../src/modules/conversations/workerBridge.js'
import { prepareWorkerConversationMcp } from '../src/modules/conversations/workerMcpAccess.js'
import { workerConversationSessionStart } from '../src/modules/conversations/workerConversationStart.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { conversationDeliveryFixture } from '../src/modules/conversations/conversationDelivery.test-support.js'

describe('conversation Agent scoped tools through authenticated paired relay and native startup', () => {
  let f: Awaited<ReturnType<typeof conversationDeliveryFixture>>
  beforeEach(async () => { f = await conversationDeliveryFixture() })
  afterEach(async () => { await f.close() })

  it('keeps Agent credentials subject-bound end to end and preserves registry, channel and owner denials', async () => {
    const state = await f.agent.ensureConversation(f.owner, { workspaceId: f.scope.workspaceId, ...f.query })
    if (!state.conversation) throw new Error('Expected the public conversation record.')
    const row = await f.agentRepository.get(state.conversation.id)
    if (!row) throw new Error('Expected retained owner metadata.')
    const original = await new PostgresWorkflowRepository(f.database.pool).getAgentConfiguration(row.agent_configuration_version_id)
    if (!original) throw new Error('Expected accepted configuration.')
    const worker = workerConversationFixture('agent')
    const configuration = { ...original, harnessProfileSelection: worker.binding.profile }
    const binding = WorkerConversationBindingSchema.parse({ ...worker.binding, appMcpAccess: 'scoped', owner: {
      kind: 'agent', conversationId: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id,
      workflowNodeId: row.workflow_node_id, agentId: row.agent_id, configurationVersionId: configuration.id,
      configurationHash: commandInputHash(configuration),
    } })
    // Typed owner/setup port stands in for D's committed native binding writer, never for the relay under test.
    const seedOwner = async (accepted: typeof binding) => {
      await f.database.pool.query('update operator_conversations set worker_conversation_binding=$2::jsonb where id=$1',
        [row.id, JSON.stringify(accepted)])
    }
    await seedOwner(binding)
    const subject: Extract<AgentSubject, { kind: 'conversation' }> = { kind: 'conversation', conversationId: row.id,
      agent: { workspaceId: row.workspace_id, workflowId: row.workflow_id, workflowNodeId: row.workflow_node_id,
        agentId: row.agent_id, configurationVersionId: configuration.id, productRole: 'coder', displayName: 'Exact Agent' } }
    let enabled = true, foreignSubject = false, current = worker.connection
    const forwarded = vi.fn(async () => ({ statusCode: 200, contentType: 'application/json' as const, body: '{"tools":["workflow_chat_read"]}' }))
    const scoped: WorkerConversationAgentMcp = { authorize: async request => {
      if (!enabled || request.token !== 'agent-scoped-token') throw new DomainError('FORBIDDEN', 'The saved node tool is disabled or its credential is unavailable.', 403)
      return { subject: foreignSubject ? { ...subject, conversationId: 'another-conversation' } : subject,
        expiresAt: new Date(Date.now() + 60_000).toISOString() }
    }, forward: () => ({ request: forwarded }) }
    const profiles = new AcceptedHarnessProfileAdmission<ClaudeProfileOwner>(new HarnessInstanceSettingsRepository(f.database.pool),
      new HostHarnessProfileEvidenceRepository(f.database.pool), { authorize: async () => { throw new Error('Agent used Operator profile admission.') },
        current: async () => { throw new Error('Agent used Operator profile inventory.') }, assertCurrent() {} })
    const operatorAuth = vi.fn(async () => { throw new Error('Agent credential reached Operator authentication.') })
    const bridge = new MainWorkerConversationBridge()
    const main = new MainWorkerConversationMcp({ pool: f.database.pool, access: { authenticate: operatorAuth },
      operators: f.operatorRepository, profiles, claudeProfiles: profiles, bridge, current: () => current,
      forward: () => ({ request: async () => { throw new Error('Agent reached the Operator MCP endpoint.') } }), agent: scoped })
    const controller = new AbortController()
    try {
      const source = { method: 'conversation.status' as const, binding, admissionId: randomUUID() }
      const relay = await prepareWorkerConversationMcp({ source, token: 'agent-scoped-token', signal: controller.signal,
        request: async (_namespace, raw, options) => ({ payload: await main.handle(raw, worker.connection, options.signal) }) })
      expect(relay.environment.agentId).toBe(row.agent_id)
      const start = workerConversationSessionStart(binding, configuration, relay.environment,
        { correlationId: 'accepted-agent-input', instructionsDelivered: false })
      expect(start).toMatchObject({ kind: 'agent-chat', conversationId: row.id, workflowId: row.workflow_id,
        workflowNodeId: row.workflow_node_id, environment: { agentId: row.agent_id } })
      expect(await relay.request({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toMatchObject({ statusCode: 200 })
      expect(forwarded).toHaveBeenCalledOnce()
      enabled = false
      await expect(relay.request({ method: 'tools/list' })).rejects.toMatchObject({ status: 403 })
      enabled = true; foreignSubject = true
      await expect(relay.request({ method: 'tools/list' })).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_MCP_DENIED' })
      foreignSubject = false; current = { ...current, authorizationRevision: current.authorizationRevision + 1 }
      await expect(relay.request({ method: 'tools/list' })).rejects.toMatchObject({ code: 'WORKER_CONVERSATION_MCP_DENIED' })
      expect(forwarded).toHaveBeenCalledOnce()
      expect(operatorAuth).not.toHaveBeenCalled()
      expect(() => workerConversationSessionStart(binding, configuration, { agentId: 'application-operator', variables: { FOREMAN_CODE_MCP_TOKEN: 'wrong-owner-token' } },
        { correlationId: 'wrong-owner', instructionsDelivered: false })).toThrowError(expect.objectContaining({ code: 'HARNESS_ROLE_AUTHORITY_INVALID' }))
      await expect(prepareWorkerConversationMcp({ source: { method: 'conversation.refresh-mcp', binding, configuration,
        admissionId: randomUUID(), applicationAccess: { kind: 'operator-chat-mcp', token: 'operator-token' } }, token: 'operator-token',
        request: async () => { throw new Error('Operator token escaped its local owner guard.') }, signal: controller.signal }))
        .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_MCP_DENIED' })
    } finally { controller.abort(); await bridge.close() }
  })

  it('authorizes a fresh Agent record and rejects the same credential after archival', async () => {
    const state = await f.agent.ensureConversation(f.owner, { workspaceId: f.scope.workspaceId, ...f.query })
    if (!state.conversation) throw new Error('Expected a conversation.')
    const row = await f.agentRepository.get(state.conversation.id)
    if (!row) throw new Error('Expected the persisted Agent record.')
    const worker = workerConversationFixture('agent')
    const binding = WorkerConversationBindingSchema.parse({ ...worker.binding, appMcpAccess: 'scoped', owner: {
      kind: 'agent', conversationId: row.id, workspaceId: row.workspace_id, workflowId: row.workflow_id,
      workflowNodeId: row.workflow_node_id, agentId: row.agent_id,
      configurationVersionId: row.agent_configuration_version_id, configurationHash: worker.binding.owner.configurationHash,
    } })
    await f.database.pool.query('update operator_conversations set worker_conversation_binding=$2::jsonb where id=$1',
      [row.id, JSON.stringify(binding)])
    const subject: Extract<AgentSubject, { kind: 'conversation' }> = { kind: 'conversation', conversationId: row.id,
      agent: { workspaceId: row.workspace_id, workflowId: row.workflow_id, workflowNodeId: row.workflow_node_id,
        agentId: row.agent_id, configurationVersionId: row.agent_configuration_version_id, productRole: 'coder', displayName: 'Agent' } }
    const expiresAt = new Date(Date.now() + 60_000).toISOString()
    const authorize = vi.fn(async () => ({ subject, expiresAt }))
    const profiles = new AcceptedHarnessProfileAdmission<ClaudeProfileOwner>(new HarnessInstanceSettingsRepository(f.database.pool),
      new HostHarnessProfileEvidenceRepository(f.database.pool), {
        authorize: async () => { throw new Error('Agent used Operator profiles.') },
        current: async () => { throw new Error('Agent used Operator profiles.') }, assertCurrent() {},
      })
    const bridge = new MainWorkerConversationBridge()
    const main = new MainWorkerConversationMcp({ pool: f.database.pool, access: {
      authenticate: async () => { throw new Error('Agent used Operator credentials.') },
    }, operators: f.operatorRepository, profiles, claudeProfiles: profiles, bridge, current: () => worker.connection,
    forward: () => ({ request: async () => { throw new Error('Agent used Operator transport.') } }),
    agent: { authorize, forward: () => ({ request: async () => { throw new Error('Authorization must not forward a tool call.') } }) } })
    const request = { version: 1, operation: 'conversation-mcp.authorize', binding, admissionId: randomUUID(), token: 'scoped-agent' }
    try {
      await expect(main.handle(request, worker.connection, new AbortController().signal)).resolves.toEqual({ expiresAt })
      expect(authorize).toHaveBeenCalledOnce()
      await f.database.pool.query("update operator_conversations set record=record || '{\"archived\":true}'::jsonb where id=$1", [row.id])
      await expect(main.handle(request, worker.connection, new AbortController().signal))
        .rejects.toMatchObject({ code: 'WORKER_CONVERSATION_MCP_DENIED' })
      expect(authorize).toHaveBeenCalledOnce()
    } finally { await bridge.close() }
  })

})
