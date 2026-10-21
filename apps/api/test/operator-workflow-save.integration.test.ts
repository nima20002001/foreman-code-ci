import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { AgentMutationResultSchema } from '@foreman-code/contracts/management'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { CurrentWorkflowSaveResultSchema, CurrentWorkflowReadResultSchema,
  SavedManagedWorkflowCommandResultSchema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'

it('creates and saves without echoed stamps, checks revisions and grants, and replays after later saves', async () => {
  const f = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single') })
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await f.client.callTool({ name, arguments: args })
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true)
    return decodeMcpToolResult(reply)
  }
  try {
    const workspaceId = f.f.scope.workspaceId
    const created = SavedManagedWorkflowCommandResultSchema.parse(await call('workflow_create', {
      workspaceId, name: 'One worker', commandId: randomUUID(),
    })).value
    const { createdAt, updatedAt, version, ...definition } = f.f.version.definition
    void createdAt
    void updatedAt
    void version
    const input = { workspaceId, workflowId: created.workflow.id, commandId: randomUUID(),
      executionSemanticsVersion: 3, expectedRevision: created.revision, expectedWorkflowVersionId: null,
      expectedAgentConfigurationVersionIds: f.f.version.agentConfigurationVersionIds,
      graph: { ...definition, id: created.workflow.id, name: 'One worker', description: 'Saved description',
        executionPolicy: { ...definition.executionPolicy, agentActiveTimeoutMs: 60_000 } } }
    const reader = await f.access.issue({ name: 'Read-only workflow author', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['workflows:read', 'graph:read'], scope: {} }] })
    const denied = await (await f.connect(reader.token)).callTool({ name: 'workflow_save_v3', arguments: input })
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    const first = CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', input))
    expect(first.value.version.definition.createdAt).toBe(created.workflow.createdAt)
    expect(first.value.version.definition.updatedAt).toBeDefined()
    const saved = CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', {
      workspaceId, workflowId: created.workflow.id,
    }))
    expect(saved.version).toEqual(first.value.version)
    const stale = await f.client.callTool({ name: 'workflow_save_v3', arguments: { ...input, commandId: randomUUID() } })
    expect(stale.isError).toBe(true)
    expect(JSON.stringify(stale.content)).toContain('REVISION_CONFLICT')
    const { executionPolicy, description, ...withoutOverrides } = input.graph
    void description
    const missingLimits = await f.client.callTool({ name: 'workflow_save_v3', arguments: {
      ...input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId, graph: withoutOverrides,
    } })
    expect(missingLimits.isError).toBe(true)
    expect(JSON.stringify(missingLimits.content)).toContain('EXECUTION_LIMITS_REQUIRED')
    const { agentActiveTimeoutMs, ...limits } = executionPolicy
    void agentActiveTimeoutMs
    const edited = { ...input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId,
      graph: { ...withoutOverrides, executionPolicy: limits, nodes: input.graph.nodes.map(node => ({ ...node, initialPrompt: 'Changed prompt' })) } }
    const second = CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', edited))
    expect(second.value.version.version).toBe(first.value.version.version + 1)
    expect(second.value.version.definition.description).toBeUndefined()
    expect(second.value.version.definition.executionPolicy?.agentActiveTimeoutMs).toBeUndefined()
    const third = CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', { ...edited,
      commandId: randomUUID(), expectedRevision: second.value.revision,
      expectedWorkflowVersionId: second.value.currentVersionId,
      graph: { ...edited.graph, nodes: edited.graph.nodes.map(node => ({ ...node, initialPrompt: 'Another prompt' })) },
    }))
    expect(third.value.version.definition.createdAt).toBe(created.workflow.createdAt)
    expect(CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', edited)))
      .toEqual({ ...second, replayed: true })
    expect(CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', input)))
      .toEqual({ ...first, replayed: true })
    const changedRetry = await f.client.callTool({ name: 'workflow_save_v3', arguments: {
      ...input, graph: { ...input.graph, name: 'Different request' },
    } })
    expect(changedRetry.isError).toBe(true)
    expect(JSON.stringify(changedRetry.content)).toContain('COMMAND_ID_CONFLICT')
    const audited = await f.db.pool.query<{ outcome: string }>(
      "select outcome from management_audit where principal_id=$1 and action='workflow.save.v3'", [f.writer.principal.id])
    expect(audited.rows.some(row => row.outcome === 'succeeded')).toBe(true)
  } finally { await f.close() }
}, 120_000)

it('accepts default native approval handling and rejects explicitly interactive policies', async () => {
  const f = await currentOperatorIntegration({ agentManagement: true,
    fixture: makeCurrentWorkflowFixture(randomUUID(), 'single') })
  const call = async (name: string, args: Record<string, unknown>) => {
    const reply = await f.client.callTool({ name, arguments: args })
    expect(reply.isError, JSON.stringify(reply)).not.toBe(true)
    return decodeMcpToolResult(reply)
  }
  try {
    const workspaceId = f.f.scope.workspaceId
    const agentId = randomUUID()
    const configuration = { harness: 'codex', model: 'recorded-model', reasoningEffort: 'low',
      sandbox: 'read-only', serviceTier: 'standard' }
    const agent = AgentMutationResultSchema.parse(await call('agent_create', {
      workspaceId, agentId, commandId: randomUUID(), name: 'Worker', configuration, prompt: {},
    })).value
    const input = await f.create()
    input.expectedAgentConfigurationVersionIds = { [agentId]: agent.agent.configurationVersionId! }
    input.graph = { ...input.graph, approval: { handler: 'native' },
      nodes: input.graph.nodes.map(node => ({ ...node, agentId })), edges: [] }
    const first = CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', input))
    const read = () => call('workflow_saved_get_v3', { workspaceId, workflowId: input.workflowId })
      .then(value => CurrentWorkflowReadResultSchema.parse(value))
    expect((await read()).version).toEqual(first.value.version)
    expect(first.value.version.approval.handler).toBe('native')
    const interactive = AgentMutationResultSchema.parse(await call('agent_update', {
      workspaceId, agentId, commandId: randomUUID(), expectedRevision: agent.metadataRevision,
      expectedConfigurationVersionId: agent.agent.configurationVersionId,
      configuration: { ...configuration, advanced: {
        ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'on-request', approvalsReviewer: 'user',
      } },
    })).value
    const edited = { ...input, commandId: randomUUID(), expectedRevision: first.value.revision,
      expectedWorkflowVersionId: first.value.currentVersionId,
      expectedAgentConfigurationVersionIds: { [agentId]: interactive.agent.configurationVersionId } }
    const invalid = await f.client.callTool({ name: 'workflow_save_v3', arguments: edited })
    expect(invalid.isError).toBe(true)
    expect(JSON.stringify(invalid.content)).toContain('GRAPH_INVALID')
    expect((await read()).version).toEqual(first.value.version)
    const updated = AgentMutationResultSchema.parse(await call('agent_update', {
      workspaceId, agentId, commandId: randomUUID(), expectedRevision: interactive.metadataRevision,
      expectedConfigurationVersionId: interactive.agent.configurationVersionId,
      configuration: { ...configuration, advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' } },
    })).value
    const saved = CurrentWorkflowSaveResultSchema.parse(await call('workflow_save_v3', { ...edited,
      commandId: randomUUID(), expectedAgentConfigurationVersionIds: { [agentId]: updated.agent.configurationVersionId },
    }))
    const persisted = await read()
    expect(persisted.version).toEqual(saved.value.version)
    expect(persisted.version.approval.handler).toBe('native')
    expect(persisted.version.agentConfigurationVersionIds)
      .toEqual({ [agentId]: updated.agent.configurationVersionId })
  } finally { await f.close() }
}, 120_000)
