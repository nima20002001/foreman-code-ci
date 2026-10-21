import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, memoryBoardTools, WORKFLOW_HIERARCHY_TOOLS, WorkflowHierarchyReadResultSchema,
  WorkflowReportsPageSchema, type WorkflowHierarchy } from '@foreman-code/contracts'
import { AgentDefaultsUpdateResultSchema, AgentMutationResultSchema, ManagedAgentDefaultsSchema,
  ManagedAgentDetailSchema, type ManagementGrant } from '@foreman-code/contracts/management'
import { CurrentManagedWorkflowSchema, CurrentWorkflowSaveResultSchema, SavedManagedWorkflowCommandResultSchema,
  CURRENT_WORKFLOW_TOOLS, CurrentEditReadResultSchema, WorkflowHierarchyUpdateResultSchema,
  type CurrentEditStageInput, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'

type AppFixture = Awaited<ReturnType<typeof currentOperatorIntegration>>
type SavedWorkflow = ReturnType<typeof CurrentWorkflowSaveResultSchema.parse>['value']
async function createHierarchy(f: AppFixture, includeHierarchy = true) {
  const workspaceId = f.f.scope.workspaceId
  const agents: Array<ReturnType<typeof AgentMutationResultSchema.parse>['value']> = []
  for (const productRole of [includeHierarchy ? 'master' : 'orchestrator', 'orchestrator', 'orchestrator', 'coder'] as const) {
    const response = await f.app.inject({ method: 'POST', url: `/api/management/workspaces/${workspaceId}/agents`,
      headers: graphHeaders(f.writer.token), payload: { workspaceId, commandId: randomUUID(), agentId: `agent-${randomUUID()}`,
        productRole, name: `${productRole} ${agents.length}`, configuration: DEFAULT_HARNESS_DEFAULTS.codex } })
    expect(response.statusCode, response.body).toBe(201)
    agents.push(AgentMutationResultSchema.parse(response.json()).value)
  }
  const created = await f.app.inject({ method: 'POST', url: `/api/management/workspaces/${workspaceId}/workflows`,
    headers: graphHeaders(f.writer.token), payload: { workspaceId, commandId: randomUUID(), name: 'F4 authenticated hierarchy' } })
  expect(created.statusCode, created.body).toBe(201)
  const managed = SavedManagedWorkflowCommandResultSchema.parse(created.json()).value
  const workflowId = managed.workflow.id, base = `/api/management/workspaces/${workspaceId}/workflows/${workflowId}`
  const edges = [[0, 1], [0, 2], [1, 3], [2, 3]].map(([from, to], index) => ({
    id: `route-${index}`, kind: 'execution' as const, source: `node-${from}`, target: `node-${to}`,
  }))
  const hierarchy: WorkflowHierarchy = { version: 1, masterNodeId: 'node-0', parents: [
    { workflowNodeId: 'node-1', parentNodeId: 'node-0' },
    { workflowNodeId: 'node-2', parentNodeId: 'node-0' },
    { workflowNodeId: 'node-3', parentNodeId: 'node-1' },
  ] }
  const graph: WorkflowDefinitionV3 = { ...managed.workflow, entryNodeId: 'node-0', ...(includeHierarchy ? { hierarchy } : {}),
    handoffs: { contractVersion: 1 }, approval: { handler: 'user' }, executionCondition: { kind: 'manual' },
    executionPolicy: { maxParallelism: 4, maxNodeExecutions: 100 }, edges,
    nodes: agents.map(({ agent }, index) => {
      const id = `node-${index}`, routes = edges.filter(edge => edge.source === id)
      return { id, agentId: agent.id, name: agent.name,
        ...(routes.length ? { choice: { outcomes: routes.map((edge, i) => ({ outcome: `child_${i}`,
          target: { kind: 'edge' as const, relationshipId: edge.id } })) } } : {}) }
    }) }
  const response = await f.app.inject({ method: 'PUT', url: `${base}/definition`, headers: graphHeaders(f.writer.token),
    payload: { workspaceId, workflowId, commandId: randomUUID(), executionSemanticsVersion: 3,
      expectedRevision: managed.revision, expectedWorkflowVersionId: null,
      expectedAgentConfigurationVersionIds: Object.fromEntries(agents.map(({ agent }) => [agent.id, agent.configurationVersionId!])), graph } })
  expect(response.statusCode, response.body).toBe(200)
  const saved = CurrentWorkflowSaveResultSchema.parse(response.json())
  const call = (name: string, input: unknown, token = f.writer.token) => graphRpc(f.app, token, 'tools/call', { name, arguments: input })
  const read = async (query = '', token = f.writer.token) => {
    const reply = await f.app.inject({ method: 'GET', url: `${base}/hierarchy${query}`, headers: graphHeaders(token) })
    expect(reply.statusCode, reply.body).toBe(200)
    return WorkflowHierarchyReadResultSchema.parse(reply.json())
  }
  return { workspaceId, workflowId, base, hierarchy, saved, agents, call, read }
}

async function readAgent(f: AppFixture, agentId: string) {
  const reply = await f.app.inject({ method: 'GET',
    url: `/api/management/workspaces/${f.f.scope.workspaceId}/agents/${agentId}`, headers: graphHeaders(f.writer.token) })
  expect(reply.statusCode, reply.body).toBe(200)
  return ManagedAgentDetailSchema.parse(reply.json())
}
function stageInput(saved: SavedWorkflow, graph: WorkflowDefinitionV3,
  stagedAgents: CurrentEditStageInput['stagedAgents']): CurrentEditStageInput {
  return { action: 'stage_edits', workspaceId: saved.workspaceId, workflowId: saved.workflowId,
    draftId: `editor-${randomUUID()}`, commandId: randomUUID(), executionSemanticsVersion: 3,
    expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
    expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds, graph, stagedAgents }
}
async function editCommand(f: AppFixture, base: string, input: unknown, via: 'http' | 'mcp') {
  if (via === 'http') {
    const reply = await f.app.inject({ method: 'POST', url: `${base}/definition/edits`, headers: { ...graphHeaders(f.writer.token), 'content-type': 'application/json' }, payload: JSON.stringify(input) })
    expect(reply.statusCode, reply.body).toBe(200)
    return CurrentEditReadResultSchema.parse(reply.json())
  }
  const reply = await graphRpc(f.app, f.writer.token, 'tools/call', { name: CURRENT_WORKFLOW_TOOLS.edits, arguments: input })
  expect(reply.result?.isError, JSON.stringify(reply)).not.toBe(true)
  return CurrentEditReadResultSchema.parse(graphRpcValue(reply.result))
}
async function publishEdits(f: AppFixture, base: string, staged: Awaited<ReturnType<typeof editCommand>>, via: 'http' | 'mcp') {
  const intent = staged.intent!
  const finished = await editCommand(f, base, { workspaceId: intent.workspaceId, workflowId: intent.workflowId,
    draftId: intent.draftId, intentId: intent.id, action: 'stop_and_save', commandId: intent.advanceCommandId }, via)
  expect(finished.intent?.state, JSON.stringify(finished.intent?.error)).toBe('saved')
  return finished.intent!.result!
}
function routeNodes(graph: WorkflowDefinitionV3, routes: [number, number][]): WorkflowDefinitionV3 {
  const edges = [...graph.edges]
  for (const [from, to] of routes) if (!edges.some(edge => edge.kind === 'execution' && edge.source === `node-${from}` && edge.target === `node-${to}`)) {
    edges.push({ id: `added-route-${edges.length}`, kind: 'execution', source: `node-${from}`, target: `node-${to}` })
  }
  return { ...graph, edges, nodes: graph.nodes.map(node => {
    if (node.kind === 'job') return node
    const outcomes = [...node.choice?.outcomes ?? []]
    for (const edge of edges.filter(edge => edge.kind === 'execution' && edge.source === node.id)) {
      if (!outcomes.some(item => item.target.kind === 'edge' && item.target.relationshipId === edge.id)) {
        outcomes.push({ outcome: `added_${outcomes.length}`, target: { kind: 'edge', relationshipId: edge.id } })
      }
    }
    return outcomes.length ? { ...node, choice: { outcomes } } : node
  }) }
}

describe.skipIf(!postgresEnabled)('Master hierarchy authenticated HTTP/MCP parity', () => {
  it('publishes membership once, returns retryable command IDs, preserves no-op timestamps and immutable historical pins', async () => {
    const f = await currentOperatorIntegration({ agentManagement: true, workflowHierarchy: true, approvalNodeIds: [] })
    try {
      const t = await createHierarchy(f)
      const hierarchy: WorkflowHierarchy = { ...t.hierarchy, parents: t.hierarchy.parents.map(member =>
        member.workflowNodeId === 'node-3' ? { ...member, parentNodeId: 'node-2' } : member) }
      const input = { workspaceId: t.workspaceId, workflowId: t.workflowId,
        expectedRevision: t.saved.value.revision, hierarchy }
      const update = await f.app.inject({ method: 'PUT', url: `${t.base}/hierarchy`, headers: { ...graphHeaders(f.writer.token), 'content-type': 'application/json' }, payload: JSON.stringify(input) })
      expect(update.statusCode, update.body).toBe(200)
      const changed = WorkflowHierarchyUpdateResultSchema.parse(update.json())
      expect(changed.value.currentVersionId).not.toBe(t.saved.value.currentVersionId)
      const replay = await t.call(WORKFLOW_HIERARCHY_TOOLS.update, { ...input, commandId: changed.commandId })
      expect(replay.result?.isError, JSON.stringify(replay)).not.toBe(true)
      expect(WorkflowHierarchyUpdateResultSchema.parse(graphRpcValue(replay.result))).toEqual({ ...changed, replayed: true })
      const current = await t.read()
      expect(current.hierarchy).toEqual(hierarchy)
      expect(graphRpcValue((await t.call(WORKFLOW_HIERARCHY_TOOLS.get,
        { workspaceId: t.workspaceId, workflowId: t.workflowId })).result)).toEqual(current)
      const before = await f.app.inject({ method: 'GET', url: t.base, headers: graphHeaders(f.writer.token) })
      const noop = await t.call(WORKFLOW_HIERARCHY_TOOLS.update, { ...input,
        expectedRevision: changed.value.revision, commandId: 'save hierarchy 1' })
      expect(noop.result?.isError, JSON.stringify(noop)).not.toBe(true)
      const noChange = WorkflowHierarchyUpdateResultSchema.parse(graphRpcValue(noop.result))
      expect(noChange.commandId).toBe('save hierarchy 1')
      expect(noChange.value.currentVersionId).toBe(changed.value.currentVersionId)
      expect(noChange.value.revision).toBe(changed.value.revision)
      const after = await f.app.inject({ method: 'GET', url: t.base, headers: graphHeaders(f.writer.token) })
      expect(CurrentManagedWorkflowSchema.parse(after.json())).toEqual(CurrentManagedWorkflowSchema.parse(before.json()))
      const old = await t.read(`?workflowVersionId=${t.saved.value.currentVersionId}`)
      expect(old.hierarchy).toEqual(t.hierarchy)
      expect(old.agents.map(agent => agent.configurationVersionId)).toEqual(t.agents.map(({ agent }) => agent.configurationVersionId))
      const master = t.agents[0]!
      const roleChange = await f.app.inject({ method: 'PATCH',
        url: `/api/management/workspaces/${t.workspaceId}/agents/${master.agent.id}`, headers: graphHeaders(f.writer.token),
        payload: { workspaceId: t.workspaceId, agentId: master.agent.id, commandId: randomUUID(),
          expectedRevision: master.metadataRevision, expectedConfigurationVersionId: master.agent.configurationVersionId,
          productRole: 'orchestrator' } })
      expect(roleChange.statusCode, roleChange.body).toBe(200)
      expect(AgentMutationResultSchema.parse(roleChange.json()).value.agent.productRole).toBe('orchestrator')
      expect((await t.read()).agents[0]!.productRole).toBe('master')
      const stalePins = await f.app.inject({ method: 'PUT', url: `${t.base}/hierarchy`, headers: graphHeaders(f.writer.token),
        payload: { workspaceId: t.workspaceId, workflowId: t.workflowId, hierarchy: t.hierarchy,
          expectedRevision: t.saved.value.revision, commandId: randomUUID() } })
      expect(stalePins.statusCode).toBe(409)
      expect((await t.read()).workflowVersionId).toBe(changed.value.currentVersionId)
    } finally { await f.close() }
  }, 60000)

  it('privately stages explicit Master adoption, replacement and removal and publishes immutable role pins through both transports', async () => {
    const f = await currentOperatorIntegration({ agentManagement: true, workflowHierarchy: true, approvalNodeIds: [] })
    try {
      const t = await createHierarchy(f, false), original = t.agents[0]!
      const adopt = stageInput(t.saved.value, { ...t.saved.value.version.definition, hierarchy: t.hierarchy }, [
        { agent: { ...original.agent, productRole: 'master' }, baseRevision: original.metadataRevision },
      ])
      const staged = await editCommand(f, t.base, adopt, 'mcp')
      expect((await readAgent(f, original.agent.id)).agent).toEqual(original.agent)
      expect((await t.read()).hierarchy).toBeNull()
      const adopted = await publishEdits(f, t.base, staged, 'http')
      expect((await t.read()).hierarchy).toEqual(t.hierarchy)
      expect(adopted.version.agentConfigurationVersionIds[original.agent.id]).not.toBe(original.agent.configurationVersionId)
      expect((await t.read(`?workflowVersionId=${t.saved.value.currentVersionId}`)).hierarchy).toBeNull()
      const oldMaster = await readAgent(f, original.agent.id), replacement = await readAgent(f, t.agents[1]!.agent.id)
      const replacedHierarchy: WorkflowHierarchy = { version: 1, masterNodeId: 'node-1', parents: [
        { workflowNodeId: 'node-0', parentNodeId: 'node-1' },
        { workflowNodeId: 'node-2', parentNodeId: 'node-1' },
        { workflowNodeId: 'node-3', parentNodeId: 'node-0' },
      ] }
      const obsolete = new Set(adopted.version.definition.edges.filter(edge => edge.kind === 'execution'
        && edge.target === 'node-1').map(edge => edge.id))
      const graph = routeNodes({ ...adopted.version.definition, entryNodeId: 'node-1', hierarchy: replacedHierarchy,
        edges: adopted.version.definition.edges.filter(edge => !obsolete.has(edge.id)),
        nodes: adopted.version.definition.nodes.map(node => node.choice ? { ...node, choice: {
          outcomes: node.choice.outcomes.filter(item => item.target.kind !== 'edge' || !obsolete.has(item.target.relationshipId)),
        } } : node) },
        [[1, 0], [1, 2], [0, 3], [2, 3]])
      const replacementStage = await editCommand(f, t.base, stageInput(adopted, graph, [
        { agent: { ...oldMaster.agent, productRole: 'orchestrator' }, baseRevision: oldMaster.metadataRevision },
        { agent: { ...replacement.agent, productRole: 'master' }, baseRevision: replacement.metadataRevision },
      ]), 'http')
      expect((await readAgent(f, oldMaster.agent.id)).agent.productRole).toBe('master')
      expect((await readAgent(f, replacement.agent.id)).agent.productRole).toBe('orchestrator')
      const replaced = await publishEdits(f, t.base, replacementStage, 'mcp')
      expect((await t.read()).hierarchy).toEqual(replacedHierarchy)
      expect(replaced.version.definition.edges).toEqual(graph.edges)
      expect(replaced.version.definition.nodes[0]!.choice?.outcomes).toEqual(graph.nodes[0]!.choice!.outcomes)
      const historical = await t.read(`?workflowVersionId=${adopted.currentVersionId}`)
      expect(historical.agents.find(agent => agent.agentId === oldMaster.agent.id)).toMatchObject({
        productRole: 'master', configurationVersionId: adopted.version.agentConfigurationVersionIds[oldMaster.agent.id],
      })
      const currentMaster = await readAgent(f, replacement.agent.id)
      const ordinary = { ...replaced.version.definition }; delete ordinary.hierarchy
      // Removing reporting does not delete routes. The caller explicitly removes
      // the retained reverse route before saving under ordinary DAG rules again.
      const removedRoutes = new Set(ordinary.edges.filter(edge => edge.kind === 'execution' && edge.target === ordinary.entryNodeId).map(edge => edge.id))
      ordinary.edges = ordinary.edges.filter(edge => !removedRoutes.has(edge.id))
      ordinary.nodes = ordinary.nodes.map(node => node.choice ? { ...node, choice: { outcomes: node.choice.outcomes
        .filter(item => item.target.kind !== 'edge' || !removedRoutes.has(item.target.relationshipId)) } } : node)
      const removalStage = await editCommand(f, t.base, stageInput(replaced, ordinary, [
        { agent: { ...currentMaster.agent, productRole: 'orchestrator' }, baseRevision: currentMaster.metadataRevision },
      ]), 'mcp')
      expect((await t.read()).hierarchy).toEqual(replacedHierarchy)
      const removed = await publishEdits(f, t.base, removalStage, 'http')
      expect((await t.read()).hierarchy).toBeNull()
      expect(removed.version.definition.edges).toEqual(ordinary.edges)
      expect((await t.read(`?workflowVersionId=${replaced.currentVersionId}`)).hierarchy).toEqual(replacedHierarchy)
      expect((await t.read(`?workflowVersionId=${replaced.currentVersionId}`)).agents.find(agent => agent.agentId === currentMaster.agent.id)?.productRole).toBe('master')
    } finally { await f.close() }
  }, 60000)

  it('keeps a new Master private until graph publication and rejects an invalid new Worker without publishing either', async () => {
    const f = await currentOperatorIntegration({ agentManagement: true, workflowHierarchy: true, approvalNodeIds: [] })
    try {
      const t = await createHierarchy(f), seed = t.agents[0]!.agent
      const created = await f.app.inject({ method: 'POST', url: `/api/management/workspaces/${t.workspaceId}/workflows`,
        headers: graphHeaders(f.writer.token), payload: { workspaceId: t.workspaceId, name: 'Private Master workflow', commandId: randomUUID() } })
      expect(created.statusCode, created.body).toBe(201)
      const fresh = SavedManagedWorkflowCommandResultSchema.parse(created.json()).value
      const base = `/api/management/workspaces/${t.workspaceId}/workflows/${fresh.workflow.id}`
      const master = { ...seed, id: `private-master-${randomUUID()}`, configurationVersionId: undefined, name: 'Private new Master' }
      const graph: WorkflowDefinitionV3 = { ...fresh.workflow, entryNodeId: 'new-master',
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 }, approval: { handler: 'user' },
        nodes: [{ id: 'new-master', agentId: master.id, name: master.name }], edges: [], handoffs: { contractVersion: 1 },
        hierarchy: { version: 1, masterNodeId: 'new-master', parents: [] } }
      const staged = await editCommand(f, base, { action: 'stage_edits', workspaceId: t.workspaceId, workflowId: fresh.workflow.id,
        draftId: `editor-${randomUUID()}`, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedRevision: fresh.revision, expectedWorkflowVersionId: null, expectedAgentConfigurationVersionIds: {},
        graph, stagedAgents: [{ agent: master, baseRevision: null }] }, 'http')
      const agentUrl = `/api/management/workspaces/${t.workspaceId}/agents/`
      expect((await f.app.inject({ method: 'GET', url: `${agentUrl}${master.id}`, headers: graphHeaders(f.writer.token) })).statusCode).toBe(404)
      expect(CurrentManagedWorkflowSchema.parse((await f.app.inject({ method: 'GET', url: base, headers: graphHeaders(f.writer.token) })).json()).currentVersionId).toBeNull()
      const saved = await publishEdits(f, base, staged, 'mcp')
      const published = await readAgent(f, master.id)
      expect(published.agent).toMatchObject({ id: master.id, productRole: 'master', name: master.name,
        configurationVersionId: saved.version.agentConfigurationVersionIds[master.id] })
      const worker = { ...master, id: `private-worker-${randomUUID()}`, productRole: 'coder' as const,
        name: 'Invalid private Worker', graphqlTools: [] }
      const invalid = stageInput(saved, { ...saved.version.definition,
        nodes: [...saved.version.definition.nodes, { id: 'invalid-worker', agentId: worker.id, name: worker.name }],
        hierarchy: { version: 1, masterNodeId: 'new-master', parents: [{ workflowNodeId: 'invalid-worker', parentNodeId: 'new-master' }] },
      }, [{ agent: worker, baseRevision: null }])
      const rejected = await f.app.inject({ method: 'POST', url: `${base}/definition/edits`, headers: graphHeaders(f.writer.token), payload: invalid })
      expect(rejected.statusCode, rejected.body).toBe(409)
      expect((await f.app.inject({ method: 'GET', url: `${agentUrl}${worker.id}`, headers: graphHeaders(f.writer.token) })).statusCode).toBe(404)
      const readback = CurrentManagedWorkflowSchema.parse((await f.app.inject({ method: 'GET', url: base, headers: graphHeaders(f.writer.token) })).json())
      expect(readback.currentVersionId).toBe(saved.currentVersionId)
      expect((await readAgent(f, master.id)).agent.configurationVersionId).toBe(published.agent.configurationVersionId)
    } finally { await f.close() }
  }, 60000)

  it('includes an active Run in another workflow when a reused Agent is explicitly adopted and keeps Stage and Discard private', async () => {
    const f = await currentOperatorIntegration({ agentManagement: true, workflowHierarchy: true, approvalNodeIds: [] })
    try {
      const workspaceId = f.f.scope.workspaceId, agentId = f.f.configurations[0]!.agentId
      const reused = await readAgent(f, agentId)
      const created = await f.app.inject({ method: 'POST', url: `/api/management/workspaces/${workspaceId}/workflows`,
        headers: graphHeaders(f.writer.token), payload: { workspaceId, name: 'Reused Agent adoption', commandId: randomUUID() } })
      expect(created.statusCode, created.body).toBe(201)
      const managed = SavedManagedWorkflowCommandResultSchema.parse(created.json()).value
      const workflowId = managed.workflow.id, base = `/api/management/workspaces/${workspaceId}/workflows/${workflowId}`
      const savedReply = await f.app.inject({ method: 'PUT', url: `${base}/definition`, headers: graphHeaders(f.writer.token), payload: {
        workspaceId, workflowId, commandId: randomUUID(), executionSemanticsVersion: 3,
        expectedRevision: managed.revision, expectedWorkflowVersionId: null,
        expectedAgentConfigurationVersionIds: { [agentId]: reused.agent.configurationVersionId },
        graph: { ...managed.workflow, entryNodeId: 'reused-node', approval: { handler: 'user' },
          nodes: [{ id: 'reused-node', agentId, name: 'Reused Agent' }], edges: [],
          executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 } },
      } })
      expect(savedReply.statusCode, savedReply.body).toBe(200)
      const saved = CurrentWorkflowSaveResultSchema.parse(savedReply.json()).value
      const runUrl = `/api/management/workspaces/${workspaceId}/runs/${f.f.run.id}`
      const runBefore = await f.app.inject({ method: 'GET', url: runUrl, headers: graphHeaders(f.writer.token) })
      expect(runBefore.statusCode, runBefore.body).toBe(200)
      const staged = await editCommand(f, base, stageInput(saved, { ...saved.version.definition,
        handoffs: { contractVersion: 1 }, hierarchy: { version: 1, masterNodeId: 'reused-node', parents: [] },
      }, [{ agent: { ...reused.agent, productRole: 'master' }, baseRevision: reused.metadataRevision }]), 'mcp')
      expect(staged.intent!.affected).toEqual(expect.arrayContaining([expect.objectContaining({ runId: f.f.run.id, workflowId: f.f.scope.workflowId })]))
      expect(staged.current.some(item => !item.settled)).toBe(true)
      expect((await readAgent(f, agentId)).agent).toEqual(reused.agent)
      const intent = staged.intent!
      const discarded = await editCommand(f, base, { action: 'discard_edits', workspaceId, workflowId,
        draftId: intent.draftId, intentId: intent.id, commandId: intent.discardCommandId }, 'http')
      expect(discarded.intent?.state).toBe('discarded')
      expect((await readAgent(f, agentId)).agent).toEqual(reused.agent)
      expect((await f.app.inject({ method: 'GET', url: runUrl, headers: graphHeaders(f.writer.token) })).json()).toEqual(runBefore.json())
      expect(CurrentManagedWorkflowSchema.parse((await f.app.inject({ method: 'GET', url: base, headers: graphHeaders(f.writer.token) })).json()).currentVersionId).toBe(saved.currentVersionId)
    } finally { await f.close() }
  }, 60000)

  it('shares strict read pins, report bounds, scoped discovery and denied mutations across transports', async () => {
    const f = await currentOperatorIntegration({ agentManagement: true, workflowHierarchy: true, approvalNodeIds: [] })
    try {
      const t = await createHierarchy(f)
      const issue = (grants: ManagementGrant[]) => f.access.issue({ name: 'F4 scoped reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants })
      const reader = await issue([{ actions: ['capabilities:read'], scope: {} }, {
        actions: ['workflows:read', 'graph:read'], scope: { workspaceIds: [t.workspaceId], workflowIds: [t.workflowId] },
      }])
      const list = await graphRpc(f.app, reader.token, 'tools/list')
      const names = list.result?.tools?.map(tool => tool.name)
      expect(names).toContain(WORKFLOW_HIERARCHY_TOOLS.get)
      expect(names).not.toContain(WORKFLOW_HIERARCHY_TOOLS.update)
      expect(names).not.toContain(WORKFLOW_HIERARCHY_TOOLS.reports)
      await t.read('', reader.token)
      const update = { workspaceId: t.workspaceId, workflowId: t.workflowId, hierarchy: t.hierarchy }
      const denied = await f.app.inject({ method: 'PUT', url: `${t.base}/hierarchy`, headers: graphHeaders(reader.token), payload: update })
      expect(denied.statusCode).toBe(403)
      expect(graphRpcValue((await t.call(WORKFLOW_HIERARCHY_TOOLS.update, update, reader.token)).result)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      const disjoint = await issue([{ actions: ['capabilities:read'], scope: {} }, {
        actions: ['workflows:read', 'graph:read'], scope: { workflowIds: [t.workflowId] },
      }, { actions: ['runs:read'], scope: { workflowIds: ['a-different-workflow'] } }])
      expect((await graphRpc(f.app, disjoint.token, 'tools/list')).result?.tools?.map(tool => tool.name))
        .not.toContain(WORKFLOW_HIERARCHY_TOOLS.reports)
      const pins = { workspaceId: t.workspaceId, workflowId: t.workflowId,
        workflowVersionId: t.saved.value.currentVersionId, runId: f.f.run.id }
      expect((await f.app.inject({ method: 'GET', url: `${t.base}/hierarchy?runId=${pins.runId}&workflowVersionId=${pins.workflowVersionId}`,
        headers: graphHeaders(f.writer.token) })).statusCode).toBe(400)
      expect((await t.call(WORKFLOW_HIERARCHY_TOOLS.get, pins)).result?.isError).toBe(true)
      const runScope = { workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId, runId: f.f.run.id }
      const reportUrl = `/api/management/workspaces/${runScope.workspaceId}/workflows/${runScope.workflowId}/hierarchy/reports?runId=${runScope.runId}`
      const reports = await f.app.inject({ method: 'GET', url: reportUrl, headers: graphHeaders(f.writer.token) })
      expect(reports.statusCode, reports.body).toBe(200)
      const page = WorkflowReportsPageSchema.parse(reports.json())
      expect(page.items).toEqual([])
      expect(page.hasMore).toBe(false)
      expect(graphRpcValue((await t.call(WORKFLOW_HIERARCHY_TOOLS.reports, runScope)).result)).toEqual(page)
      expect((await f.app.inject({ method: 'GET', url: `${reportUrl}&limit=101`, headers: graphHeaders(f.writer.token) })).statusCode).toBe(400)
      await f.access.revoke(reader.principal.id)
      expect((await f.app.inject({ method: 'GET', url: `${t.base}/hierarchy`, headers: graphHeaders(reader.token) })).statusCode).toBe(401)
      expect((await t.call(WORKFLOW_HIERARCHY_TOOLS.get, { workspaceId: t.workspaceId, workflowId: t.workflowId }, reader.token)).status).toBe(401)
    } finally { await f.close() }
  }, 60000)

  it('copies explicit Master and memory tool templates through HTTP and authenticated MCP without changing existing Agents', async () => {
    const f = await currentOperatorIntegration({ agentManagement: true, workflowHierarchy: true, approvalNodeIds: [] })
    const call = async (name: string, input: unknown, token = f.writer.token) =>
      graphRpcValue((await graphRpc(f.app, token, 'tools/call', { name, arguments: input })).result)
    try {
      const workspaceId = f.f.scope.workspaceId, path = '/api/management/settings/agents'
      const before = ManagedAgentDefaultsSchema.parse(await call('agent_defaults_get', {}))
      const existing = AgentMutationResultSchema.parse(await call('agent_create', { workspaceId,
        commandId: randomUUID(), agentId: `existing-${randomUUID()}`, name: 'Existing Worker', productRole: 'coder' }))
      expect(existing.value.agent.graphqlTools).toEqual(expect.arrayContaining(memoryBoardTools('read')))
      expect(existing.value.agent.graphqlTools).not.toContain('memory_card_update')
      const value = { ...before.value, master: { ...before.value.orchestrator, role: 'master' as const, graphqlTools: [] },
        coder: { ...before.value.coder, graphqlTools: memoryBoardTools('write') } }
      const input = { commandId: randomUUID(), expectedRevision: before.revision, value }
      const reader = await f.access.issue({ name: 'Defaults read-only caller', audience: 'operator',
        expiresAt: new Date(Date.now() + 600000), grants: [{ actions: ['settings:read'], scope: {} }] })
      expect(await call('agent_defaults_update', input, reader.token)).toMatchObject({ error: { code: 'ACCESS_DENIED' } })
      expect(ManagedAgentDefaultsSchema.parse(await call('agent_defaults_get', {}))).toEqual(before)
      const saved = AgentDefaultsUpdateResultSchema.parse(await call('agent_defaults_update', input))
      const http = await f.app.inject({ method: 'GET', url: path, headers: graphHeaders(f.writer.token) })
      expect(http.statusCode, http.body).toBe(200)
      expect(ManagedAgentDefaultsSchema.parse(http.json())).toEqual(saved.value)
      expect(AgentDefaultsUpdateResultSchema.parse(await call('agent_defaults_update', input))).toEqual({ ...saved, replayed: true })
      const master = AgentMutationResultSchema.parse(await call('agent_create', { workspaceId,
        commandId: randomUUID(), agentId: `master-${randomUUID()}`, name: 'Template Master', productRole: 'master' }))
      expect(master.value.agent.graphqlTools).toEqual([])
      expect(master.value.agent.productRole).toBe('master')
      const worker = await f.app.inject({ method: 'POST', url: `/api/management/workspaces/${workspaceId}/agents`,
        headers: graphHeaders(f.writer.token), payload: { workspaceId, commandId: randomUUID(),
          agentId: `worker-${randomUUID()}`, name: 'Template Worker', productRole: 'coder' } })
      expect(worker.statusCode, worker.body).toBe(201)
      expect(AgentMutationResultSchema.parse(worker.json()).value.agent.graphqlTools).toEqual(memoryBoardTools('write'))
      expect((await readAgent(f, existing.value.agent.id)).agent).toEqual(existing.value.agent)
    } finally { await f.close() }
  }, 60000)

  it.each(['http', 'mcp'] as const)('freezes new-Agent tool defaults at %s Stage and preserves explicit empty and legacy absent policies', async via => {
    const f = await currentOperatorIntegration({ agentManagement: true, workflowHierarchy: true, approvalNodeIds: [] })
    const other = via === 'http' ? 'mcp' : 'http'
    const call = async (name: string, input: unknown) => graphRpcValue((await graphRpc(f.app, f.writer.token,
      'tools/call', { name, arguments: input })).result)
    try {
      const workspaceId = f.f.scope.workspaceId
      const defaults = ManagedAgentDefaultsSchema.parse(await call('agent_defaults_get', {}))
      const configured = AgentDefaultsUpdateResultSchema.parse(await call('agent_defaults_update', {
        commandId: randomUUID(), expectedRevision: defaults.revision, value: { ...defaults.value,
          master: { ...defaults.value.orchestrator, role: 'master', graphqlTools: [] },
          coder: { ...defaults.value.coder, graphqlTools: memoryBoardTools('write') },
        },
      }))
      const direct = AgentMutationResultSchema.parse(await call('agent_create', { workspaceId,
        commandId: randomUUID(), agentId: randomUUID(), name: 'Direct template Worker', productRole: 'coder' })).value
      const created = await f.app.inject({ method: 'POST', url: `/api/management/workspaces/${workspaceId}/workflows`,
        headers: graphHeaders(f.writer.token), payload: { workspaceId, commandId: randomUUID(), name: 'Staged role defaults' } })
      expect(created.statusCode, created.body).toBe(201)
      const fresh = SavedManagedWorkflowCommandResultSchema.parse(created.json()).value
      const workflowId = fresh.workflow.id, base = `/api/management/workspaces/${workspaceId}/workflows/${workflowId}`
      const agents = (['master', 'orchestrator', 'coder', 'coder'] as const).map((productRole, index) => ({
        id: `private-${randomUUID()}`, name: `Private ${index}`, productRole, harness: 'codex' as const,
        harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex, prompt: {}, assignedSkills: [],
        ...(index === 3 ? { graphqlTools: [] } : {}),
      }))
      const graph = routeNodes({ ...fresh.workflow, entryNodeId: 'node-0', handoffs: { contractVersion: 1 },
        approval: { handler: 'user' },
        executionPolicy: { maxParallelism: 2, maxNodeExecutions: 8 },
        nodes: agents.map((agent, index) => ({ id: `node-${index}`, agentId: agent.id, name: agent.name })), edges: [],
        hierarchy: { version: 1, masterNodeId: 'node-0', parents: [
          { workflowNodeId: 'node-1', parentNodeId: 'node-0' }, { workflowNodeId: 'node-2', parentNodeId: 'node-1' },
          { workflowNodeId: 'node-3', parentNodeId: 'node-1' },
        ] },
      }, [[0, 1], [1, 2], [1, 3]])
      const input: CurrentEditStageInput = { action: 'stage_edits', workspaceId, workflowId, draftId: randomUUID(),
        commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: fresh.revision,
        expectedWorkflowVersionId: null, expectedAgentConfigurationVersionIds: {}, graph,
        stagedAgents: agents.map(agent => ({ agent, baseRevision: null })),
      }
      const staged = await editCommand(f, base, input, via)
      for (const agent of agents) expect((await f.app.inject({ method: 'GET',
        url: `/api/management/workspaces/${workspaceId}/agents/${agent.id}`, headers: graphHeaders(f.writer.token) })).statusCode).toBe(404)
      AgentDefaultsUpdateResultSchema.parse(await call('agent_defaults_update', { commandId: randomUUID(),
        expectedRevision: configured.value.revision, value: { ...configured.value.value,
          master: { ...configured.value.value.master!, graphqlTools: memoryBoardTools('write') },
          coder: { ...configured.value.value.coder, graphqlTools: [] },
        } }))
      const replay = await editCommand(f, base, input, other)
      expect(replay.intent).toEqual(staged.intent)
      const saved = await publishEdits(f, base, replay, other)
      expect((await readAgent(f, agents[0]!.id)).agent.graphqlTools).toEqual([])
      expect((await readAgent(f, agents[2]!.id)).agent.graphqlTools).toEqual(direct.agent.graphqlTools)
      expect((await readAgent(f, agents[2]!.id)).agent.graphqlTools).toEqual(memoryBoardTools('write'))
      expect((await readAgent(f, agents[3]!.id)).agent.graphqlTools).toEqual([])
      const again = await publishEdits(f, base, replay, via)
      expect(again).toEqual(saved)

      // A legacy existing Agent's absent policy remains absent even under a new role template.
      const legacy = await readAgent(f, f.f.configurations[0]!.agentId)
      expect(legacy.agent.graphqlTools).toBeUndefined()
      const existingGraph: WorkflowDefinitionV3 = { ...saved.version.definition,
        nodes: [...saved.version.definition.nodes, { id: 'legacy-worker', agentId: legacy.agent.id, name: legacy.agent.name }],
        hierarchy: { ...saved.version.definition.hierarchy!, parents: [...saved.version.definition.hierarchy!.parents,
          { workflowNodeId: 'legacy-worker', parentNodeId: 'node-1' }] },
        edges: [...saved.version.definition.edges, { id: 'legacy-route', source: 'node-1', target: 'legacy-worker', kind: 'execution' as const }],
      }
      existingGraph.nodes = existingGraph.nodes.map(node => node.id === 'node-1' ? { ...node,
        choice: { outcomes: [...node.choice!.outcomes, { outcome: 'legacy', target: { kind: 'edge' as const, relationshipId: 'legacy-route' } }] } } : node)
      const legacyStage = await editCommand(f, base, { ...stageInput(saved, existingGraph, [{
        agent: { ...legacy.agent, name: 'Legacy renamed privately' }, baseRevision: legacy.metadataRevision,
      }]), expectedAgentConfigurationVersionIds: { ...saved.version.agentConfigurationVersionIds,
        [legacy.agent.id]: legacy.agent.configurationVersionId } }, via)
      expect(legacyStage.intent!.stagedDraft.stagedAgents!.find(item => item.agent.id === legacy.agent.id)!.agent.graphqlTools).toBeUndefined()
      expect((await readAgent(f, legacy.agent.id)).agent).toEqual(legacy.agent)
      await editCommand(f, base, { action: 'discard_edits', workspaceId, workflowId, draftId: legacyStage.intent!.draftId,
        intentId: legacyStage.intent!.id, commandId: legacyStage.intent!.discardCommandId }, other)
    } finally { await f.close() }
  }, 90000)

  it('rejects incomplete Orchestrator removal and publishes a complete Worker move plus route repair atomically', async () => {
    const f = await currentOperatorIntegration({ agentManagement: true, workflowHierarchy: true, approvalNodeIds: [] })
    try {
      const t = await createHierarchy(f), saved = t.saved.value
      const removed = { ...saved.version.definition, nodes: saved.version.definition.nodes.filter(node => node.id !== 'node-1'),
        edges: saved.version.definition.edges.filter(edge => edge.source !== 'node-1' && edge.target !== 'node-1') }
      const incomplete = await f.app.inject({ method: 'POST', url: `${t.base}/definition/edits`, headers: graphHeaders(f.writer.token),
        payload: stageInput(saved, removed, []) })
      expect(incomplete.statusCode, incomplete.body).toBe(409)
      expect((await t.read()).hierarchy).toEqual(t.hierarchy)
      const repaired = { ...removed, hierarchy: { ...t.hierarchy, parents: t.hierarchy.parents
        .filter(member => member.workflowNodeId !== 'node-1')
        .map(member => member.workflowNodeId === 'node-3' ? { ...member, parentNodeId: 'node-2' } : member) },
        nodes: removed.nodes.map(node => node.choice ? { ...node, choice: { outcomes: node.choice.outcomes.filter(item =>
          item.target.kind !== 'edge' || removed.edges.some(edge => item.target.kind === 'edge' && item.target.relationshipId === edge.id)) } } : node) }
      const pins = { ...saved.version.agentConfigurationVersionIds }; delete pins[t.agents[1]!.agent.id]
      const staged = await editCommand(f, t.base, { ...stageInput(saved, repaired, []), expectedAgentConfigurationVersionIds: pins }, 'mcp')
      expect((await t.read()).hierarchy).toEqual(t.hierarchy)
      const published = await publishEdits(f, t.base, staged, 'http')
      expect((await t.read()).hierarchy).toEqual(repaired.hierarchy)
      expect(published.version.definition.nodes.find(node => node.id === 'node-3')).toEqual(saved.version.definition.nodes.find(node => node.id === 'node-3'))
      expect(published.version.definition.edges).toEqual(repaired.edges)
      expect((await readAgent(f, t.agents[1]!.agent.id)).agent).toEqual(t.agents[1]!.agent)
      expect((await t.read(`?workflowVersionId=${saved.currentVersionId}`)).hierarchy).toEqual(t.hierarchy)
    } finally { await f.close() }
  }, 60000)
})
