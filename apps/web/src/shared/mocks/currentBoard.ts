import { errorMessage } from '../errorMessage'
import { nativeNode } from './nativeFixtureTypes'
import { http, HttpResponse, type RequestHandler } from 'msw'
import { inspectionFixturePage, runInspectionFixtureResponse, type RunInspectionFixture, type RunInspectionActivity } from './runInspection'
import { AgentConfigurationVersionSchema, AgentSchema, DEFAULT_WORKFLOW_APPROVAL_HANDLER,
  WorkflowRunSummarySchema, type Agent } from '@foreman-code/contracts'
import { ReadSelectedRunChatResponseSchema } from '@foreman-code/contracts/selected-run-chat'
import { RunBoardSnapshotGetResultSchema } from '@foreman-code/contracts/run-snapshots'
import { AgentCreateInputSchema, AgentUpdateInputSchema, AgentMutationResultSchema, LocalHumanAccessSchema, ManagedWorkspaceSchema, RunStopInputSchema, WorkflowUpdateInputSchema, WorkflowArchiveInputSchema, WorkflowBatchArchiveInputSchema } from '@foreman-code/contracts/management'
import {
  CurrentManagedWorkflowSchema, CurrentWorkspaceDetailsSchema, CurrentWorkflowCreateInputSchema,
  CurrentWorkflowCapabilitiesSchema, GraphDraftV3Schema, WorkflowDefinitionV3Schema,
  ExecutableWorkflowV3Schema, AcceptedWorkflowRunV3Schema, GraphEditStageInputV3Schema, GraphEditReadResultV3Schema,
  GraphEditAdvanceInputV3Schema, GraphEditDiscardInputV3Schema, CurrentWorkflowSaveInputSchema, CurrentWorkflowValidateInputSchema, CURRENT_WORKFLOW_CAPABILITIES, sameExecutableWorkflow,
  RunStartV3InputSchema, RepeatGraphCurrentV3Schema, repeatGraphTopologyV3, sameWorkflowValue,
  preserveWorkflowGeometry, RunActivitiesPageSchema,
  type WorkflowDefinitionV3, type WorkflowVersionV3, type GraphDraftV3,
  type GraphEditReadResultV3, type CurrentRunDetails, type RepeatGraphCurrentV3,
} from '@foreman-code/contracts/wave25'

const copy = <T,>(value: T): T => structuredClone(value)
const hash = `sha256:${'b'.repeat(64)}`
const at = '2026-09-25T00:00:00.000Z'
const pageInfo = { nextCursor: null }
const emptyIntent = (): GraphEditReadResultV3 => ({ intent: null, current: [], affectedSetChanged: false, canStop: true })
const failure = (code: string, message: string, status = 409) => HttpResponse.json({ error: { code, message } }, { status })

/** Reusable MSW-only service family for the REGISTERED current Board. Nothing in
 * this module launches a provider or proves SQL/native qualification. The default
 * capability is false. Only a test-owned factory can simulate accepted Start. */
type CurrentBoardMockOptions = {
  workspaceId?: string
  allowSimulatedStart?: boolean
  agents?: Agent[]
  initialWorkflow?: WorkflowDefinitionV3
  onSaved?: (graph: WorkflowDefinitionV3) => void
}

export function createCurrentBoardMock(options: CurrentBoardMockOptions = {}) {
  const state = createCurrentBoardState(options)
  const { workspaceId, agents, configurations, workflows, drafts, versions, runs, currents, calls, controls,
    receipts, install, details, managed, catalog, settle, record, inspection, history, managedWorkspace, workspace } = state
  const dispatch = (request: Request) => dispatchCurrentBoardRequest(request, state)
  const capabilities = () => CurrentWorkflowCapabilitiesSchema.parse({ ...CURRENT_WORKFLOW_CAPABILITIES,
    runtimeAdmission: controls.start, stopAvailable: controls.start, meaningfulEdit: controls.start,
    editIntents: { ...CURRENT_WORKFLOW_CAPABILITIES.editIntents, stopUnsettled: controls.start },
    reasons: controls.start ? [] : ['NATIVE_START_NOT_READY', 'NATIVE_STOP_CLEANUP_NOT_READY'] })
  const handlers: RequestHandler[] = [
    http.get('/api/local-human', () => HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
      id: 'principal-current-mock', name: 'Synthetic current Board', expiresAt: '2099-01-01T00:00:00.000Z', grants: [{
        actions: ['workspaces:read', 'workflows:read', 'workflows:create', 'workflows:update', 'workflows:archive', 'agents:read', 'agents:create', 'agents:update', 'graph:read', 'graph:edit', 'graph:save', 'interactions:read', 'runs:read',
          ...(!controls.deniedStart ? ['runs:start'] : []), ...(!controls.deniedStop ? ['runs:stop'] : [])], scope: { workspaceIds: [workspaceId] },
      }] } }))),
    http.get('/api/management/workflows/capabilities/v3', () => HttpResponse.json(capabilities())),
    http.get('/api/workspaces', () => HttpResponse.json({ workspaces: [workspace()] })),
    http.get('/api/management/workspaces', () => HttpResponse.json({ items: [managedWorkspace()], pageInfo })),
    http.all(new RegExp(`/api/(?:management/)?workspaces/${workspaceId}(?:/|$)`), ({ request }) => dispatch(request)),
  ]
  return { workspaceId, agents, configurations, workflows, drafts, versions, runs, currents, calls, controls, receipts,
    handlers, dispatch, install, details, managed, catalog, capabilities, settle, record, inspection, history }
}

function createCurrentBoardState(options: CurrentBoardMockOptions) {
  const workspaceId = options.workspaceId ?? 'ws-board-current'
  const agents = (options.agents ?? Array.from({ length: 5 }, (_, i) => ({ id: `agent-current-${i}`, name: `Worker ${i + 1}`,
    productRole: 'coder' as const, configurationVersionId: `cfg-current-${i}`, harness: 'codex' as const,
    harnessConfiguration: { harness: 'codex' as const, model: 'synthetic-no-native-call', reasoningEffort: 'low' as const,
      sandbox: 'read-only' as const, serviceTier: 'standard' as const }, prompt: {}, assignedSkills: [] }))).map((agent) => AgentSchema.parse(agent))
  const configurations = agents.map((agent) => AgentConfigurationVersionSchema.parse({ id: agent.configurationVersionId,
    agentId: agent.id, workspaceId, version: 1, productRole: agent.productRole,
    harness: agent.harnessConfiguration ?? { harness: 'codex', model: 'synthetic-no-native-call', reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' },
    prompt: agent.prompt ?? {}, assignedSkills: agent.assignedSkills ?? [], contentHash: hash, createdAt: at }))
  const catalog = agents.map((agent) => ({ agent, metadataRevision: 1, archivedAt: null }))
  const drafts = new Map<string, GraphDraftV3>(), versions = new Map<string, WorkflowVersionV3>()
  const revisions = new Map<string, number>(), workflows = new Map<string, WorkflowDefinitionV3>()
  const archivedWorkflows = new Set<string>()
  const intents = new Map<string, GraphEditReadResultV3>(), runs = new Map<string, CurrentRunDetails>()
  const currents = new Map<string, RepeatGraphCurrentV3>()
  const inspection = new Map<string, RunInspectionFixture[]>()
  const history = new Map<string, RunInspectionActivity[]>()
  const receipts = new Map<string, { input: unknown; value: unknown }>()
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const controls = { start: options.allowSimulatedStart === true, deniedStart: false, deniedStop: false, deniedRead: false,
    staleStart: false, unsupportedStart: false, loseStartReply: false, loseStageReply: false, loseStopReply: false,
    notOwner: false, affectedSetChanged: false, locationRevision: 1, stopCalls: 0 }
  let nextWorkflow = 0, nextRun = 0
  const workspace = () => ({ id: workspaceId, name: 'Current Board MSW (synthetic)', agentIds: agents.map((a) => a.id), workflowIds: [...workflows.keys()].filter((id) => !archivedWorkflows.has(id)), createdAt: at, updatedAt: at })
  const managedWorkspace = () => ManagedWorkspaceSchema.parse({ workspace: workspace(), revision: 1, archivedAt: null,
    executionLocation: { runnerId: 'runner-synthetic', rootPath: '/synthetic/board' }, locationRevision: controls.locationRevision,
    locationValidation: { status: 'ready', checkedAt: at } })
  const managed = (id: string) => CurrentManagedWorkflowSchema.parse({ workflow: workflows.get(id), revision: revisions.get(id),
    currentVersionId: drafts.get(id)?.baseWorkflowVersionId ?? null, archivedAt: archivedWorkflows.has(id) ? at : null })
  const summaries = () => [...runs.values()].map(({ run, cleanupPending }) => WorkflowRunSummarySchema.parse({ id: run.id,
    workspaceId, workflowId: run.workflowId, executionCondition: run.executionCondition, executionState: run.executionState,
    outcome: run.outcome, authRequired: false, browserWait: null, runnerHealth: { status: 'healthy', checkedAt: at }, cleanupPending,
    ...(run.startedAt ? { startedAt: run.startedAt } : {}), ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}) }))
  const details = () => CurrentWorkspaceDetailsSchema.parse({ workspace: workspace(), agents, workflows: [...workflows.values()].filter((graph) => !archivedWorkflows.has(graph.id)), runs: summaries(),
    resources: [], browserProfiles: [], runners: [{ id: 'runner-synthetic', name: 'Synthetic only', health: { status: 'healthy', checkedAt: at } }] })
  function install(raw: WorkflowDefinitionV3, saved = false) {
    const graph = WorkflowDefinitionV3Schema.parse(raw)
    if (graph.workspaceId !== workspaceId) throw new Error('Out-of-scope MSW fixture')
    workflows.set(graph.id, graph); revisions.set(graph.id, 1)
    const draft = GraphDraftV3Schema.parse({ id: `draft-${graph.id}`, workspaceId, workflowId: graph.id,
      revision: 1, publishedRevision: 1, layoutRevision: 0, baseWorkflowVersionId: null, graph, stagedAgents: [],
      sourceAgentPins: catalog.map((item) => ({ agentId: item.agent.id, metadataRevision: item.metadataRevision, configurationVersionId: item.agent.configurationVersionId })),
      updatedAt: at, updatedByPrincipalId: 'principal-current-mock' })
    drafts.set(graph.id, draft)
    if (saved) publish(draft)
    return managed(graph.id)
  }
  function publish(staged: { workflowId: string; graph: WorkflowDefinitionV3 }) {
    const id = staged.workflowId, revision = (revisions.get(id) ?? 0) + 1
    const number = [...versions.values()].filter((v) => v.workflowId === id).length + 1
    const graph = { ...staged.graph, version: number }
    const pins = Object.fromEntries(graph.nodes.filter(node=>node.kind!=='job').map((node) => { const config = configurations.find((c) => c.agentId === nativeNode(node).agentId
      && c.id === catalog.find((item) => item.agent.id === nativeNode(node).agentId)?.agent.configurationVersionId)
      if (!config) throw new Error('Missing exact configuration'); return [nativeNode(node).agentId, config.id] }))
    const { version } = ExecutableWorkflowV3Schema.parse({ version: { id: `version-${id}-${number}`, workspaceId, workflowId: id,
      version: number, definition: graph, entryNodeId: graph.entryNodeId, executionSemanticsVersion: 3, approval: graph.approval,
      agentConfigurationVersionIds: pins, contentHash: hash, createdAt: at }, configurations: configurations.filter((c) => pins[c.agentId] === c.id) })
    const draft = GraphDraftV3Schema.parse({ ...drafts.get(id), graph: version.definition, revision, publishedRevision: revision,
      baseWorkflowVersionId: version.id, stagedAgents: [] })
    versions.set(version.id, copy(version)); drafts.set(id, draft); workflows.set(id, draft.graph)
    revisions.set(id, (revisions.get(id) ?? 0) + 1); options.onSaved?.(copy(draft.graph))
    return { workspaceId, workflowId: id, revision, currentVersionId: version.id, version, agents: catalog }
  }
  function savePresentation(workflowId: string, graph: WorkflowDefinitionV3) {
    const version = versions.get(drafts.get(workflowId)!.baseWorkflowVersionId!)!
    workflows.set(workflowId, copy(graph))
    options.onSaved?.(copy(graph))
    return { workspaceId, workflowId, revision: revisions.get(workflowId)!,
      currentVersionId: version.id, version, presentation: graph }
  }
  if (options.initialWorkflow) install(options.initialWorkflow, options.initialWorkflow.nodes.length > 0)
  const record = (id: string): GraphEditReadResultV3 => {
    const current = copy(intents.get(id) ?? emptyIntent())
    current.canStop = !controls.deniedStop; current.affectedSetChanged = controls.affectedSetChanged
    current.current = (current.intent?.affected ?? []).map((pin) => { const detail = runs.get(pin.runId)
      const terminal = detail?.run.executionState === 'completed', pending = detail?.cleanupPending !== false
      return { pin, terminal, settled: terminal && !pending, outcome: detail?.run.outcome ?? 'pending',
        cleanupPending: pending, nativePending: pending, interactionPending: false, reviewPending: false } })
    return GraphEditReadResultV3Schema.parse(current)
  }
  function journal<T>(key: string, input: unknown, work: () => T): { value: T; replayed: boolean } {
    const receipt = receipts.get(key)
    if (receipt) { if (!sameWorkflowValue(receipt.input, input)) throw new Error('COMMAND_CONFLICT')
      return { value: copy(receipt.value as T), replayed: true } }
    const value = work(); receipts.set(key, { input: copy(input), value: copy(value) }); return { value, replayed: false }
  }
  function markStop(runId: string) {
    const current = currents.get(runId)
    if (current && !current.state.run.stopRequested) {
      current.state.run.stopRequested = true
      current.asOfSequence = String(BigInt(current.asOfSequence) + 1n)
    }
  }
  function settle(runId: string, cleanup = false) { const detail = runs.get(runId), current = currents.get(runId)
    if (!detail || !current) throw new Error('Run not found')
    detail.run = { ...detail.run, executionState: 'completed', outcome: 'canceled', result: { outcome: 'canceled' }, finishedAt: at }; detail.cleanupPending = cleanup
    current.state.run = { executionState: 'completed', outcome: 'canceled', stopRequested: true, cleanupPending: cleanup, unsettledReviewCount: 0, pendingInteractionCount: 0 }
    current.asOfSequence = String(BigInt(current.asOfSequence) + 1n)
  }
  return { options, workspaceId, agents, configurations, workflows, revisions, archivedWorkflows, drafts, versions, runs, currents, intents,
    calls, controls, receipts, install, details, managed, catalog, settle, record, inspection, history,
    workspace, managedWorkspace, journal, markStop, publish, savePresentation,
    nextWorkflow: () => ++nextWorkflow, nextRun: () => ++nextRun }
}

type CurrentBoardMockState = ReturnType<typeof createCurrentBoardState>
type CurrentBoardMockRequest = {
  url: URL
  path: string
  method: string
  prefix: string
  publicPrefix: string
  body: unknown
}

async function dispatchCurrentBoardRequest(request: Request, state: CurrentBoardMockState): Promise<Response | undefined> {
  const { workspaceId, controls, calls, details, agents, managedWorkspace, runs, versions, inspection,
    history, currents, journal, markStop } = state
    const url = new URL(request.url), path = decodeURIComponent(url.pathname), method = request.method
    const prefix = `/api/management/workspaces/${workspaceId}`
    const publicPrefix = `/api/workspaces/${workspaceId}`
    if (!path.startsWith(prefix) && !path.startsWith(publicPrefix)) return undefined
    if (controls.deniedRead && method === 'GET') return failure('FORBIDDEN', 'Private fixture read denied', 403)
    const body: unknown = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? await request.clone().json().catch(() => ({})) : undefined
    calls.push({ method, path, ...(body ? { body: copy(body) } : {}) })
    try {
      if (method === 'GET' && path === publicPrefix) return HttpResponse.json(details())
      if (method === 'GET' && path === `${publicPrefix}/agents`) return HttpResponse.json({ agents })
      const hierarchy = path.match(/^\/api\/management\/workspaces\/[^/]+\/workflows\/([^/]+)\/hierarchy$/)
      if (method === 'GET' && hierarchy) {
        // Fixture workflows carry no Master hierarchy; the Board reads this saved fact for every selected Run.
        const runId = url.searchParams.get('runId'), run = runId ? runs.get(runId) : undefined
        return HttpResponse.json({ workspaceId, workflowId: hierarchy[1], hierarchy: null, agents: [], revision: 1,
          workflowVersionId: run?.run.workflowVersionId ?? url.searchParams.get('workflowVersionId'),
          ...(runId ? { run: { runId, state: run?.run.executionState ?? 'completed' } } : {}) })
      }
      const selectedChat = path.match(/^\/api\/workspaces\/[^/]+\/agent-chat\/workflows\/([^/]+)\/runs\/([^/]+)\/nodes\/([^/]+)$/)
      if (method === 'GET' && selectedChat) {
        // This Board fixture has Run facts but no selected-chat backing state.
        // Answer the mounted history panel explicitly instead of leaving its read unhandled.
        return HttpResponse.json(ReadSelectedRunChatResponseSchema.parse({ kind: 'unavailable',
          target: { workspaceId, workflowId: selectedChat[1], runId: selectedChat[2], workflowNodeId: selectedChat[3] },
          reason: 'execution_missing' }))
      }
      if (method === 'GET' && path === prefix) return HttpResponse.json(managedWorkspace())
      const agentResponse = dispatchCurrentBoardAgents({ url, path, method, prefix, publicPrefix, body }, state)
      if (agentResponse) return agentResponse
      const workflowResponse = dispatchCurrentBoardWorkflows({ url, path, method, prefix, publicPrefix, body }, state)
      if (workflowResponse) return workflowResponse
      if (path === `${prefix}/runs` && method === 'GET') return HttpResponse.json(inspectionFixturePage(
        [...runs.values()].map((r) => r.run).filter((run) => run.workflowId === url.searchParams.get('workflowId')),
        (run) => run.id, [workspaceId, url.searchParams.get('workflowId'), 'runs'], url.searchParams, 20, 100))
      const match = path.match(/\/runs\/([^/]+)(.*)$/)
      if (match) {
        const runId = match[1]!, tail = match[2]!, detail = runs.get(runId)
        if (!detail) return failure('NOT_FOUND', 'Run not found', 404)
        if (tail === '/snapshot' && method === 'GET') return HttpResponse.json(RunBoardSnapshotGetResultSchema.parse({
          snapshot: savedRunSnapshot(workspaceId, detail, versions.get(detail.run.workflowVersionId)),
        }))
        if (!tail && method === 'GET') return HttpResponse.json(detail)
        if (tail === '/subagents' && method === 'GET') {
          return HttpResponse.json({ items: [], nextCursor: null, projection: 'caught-up' })
        }
        if (tail === '/activities' && method === 'GET') {
          // The mounted Run Activities feed reads this route; answer an empty, caught-up feed
          // instead of letting the request fall through MSW to the real network.
          return HttpResponse.json(RunActivitiesPageSchema.parse({
            scope: { workspaceId, workflowId: detail.run.workflowId, runId, workflowVersionId: detail.run.workflowVersionId,
              executionSemanticsVersion: 3 },
            mode: url.searchParams.has('cursor') ? 'newer' : 'initial', items: [], highWater: '0', retainedFrom: '0',
            nextCursor: `activities-${runId}-0`, olderCursor: null, hasMore: false }))
        }
        if (tail.includes('/graph') && tail.endsWith('/current') && method === 'GET') return HttpResponse.json(currents.get(runId))
        if (method === 'GET' && path.startsWith(prefix)) {
          const inspected = runInspectionFixtureResponse(url, tail, detail, versions.get(detail.run.workflowVersionId), inspection.get(runId) ?? [])
          if (inspected) return inspected
        }
        if (tail === '/events' && method === 'GET') return HttpResponse.json(inspectionFixturePage(
          history.get(runId) ?? [], (item) => item.id, [workspaceId, runId, 'activity'], url.searchParams, 50, 500))
        if (tail === '/stop' && method === 'POST') {
          const input = RunStopInputSchema.parse(body)
          if (controls.deniedStop) return failure('FORBIDDEN', 'Stop denied', 403)
          const response = journal(`stop:${input.commandId}`, input, () => {
            controls.stopCalls++
            if (!controls.notOwner && detail.run.executionState !== 'completed') { detail.cleanupPending = true; markStop(runId) }
            return { runId, status: controls.notOwner ? 'not_owner' as const : detail.run.executionState === 'completed' ? 'already_terminal' as const : 'accepted' as const, processStopped: false }
          })
          if (controls.loseStopReply) { controls.loseStopReply = false; return HttpResponse.error() }
          return HttpResponse.json({ ...response.value, replayed: response.replayed })
        }
      }
      return undefined
    } catch (error) {
      const code = errorMessage(error, 'INVALID_INPUT')
      return failure(code.length < 100 ? code : 'INVALID_INPUT', 'Current V3 mock rejected the exact request; no fallback occurred.')
    }
  }

/** The admission-time Board a Run would persist: the pinned version's Agents, geometry and relationships. */
function savedRunSnapshot(workspaceId: string, detail: CurrentRunDetails, version: WorkflowVersionV3 | undefined) {
  const run = detail.run
  if (!version) return { kind: 'unavailable' as const, reason: 'legacy_run' as const, workspaceId, workflowId: run.workflowId, runId: run.id }
  return { kind: 'available' as const, workspaceId, workflowId: run.workflowId, runId: run.id, workflowVersionId: version.id,
    capturedAt: run.startedAt ?? version.createdAt,
    nodes: version.definition.nodes.map(node => {
      const agent = nativeNode(node)
      return { id: agent.id, name: agent.name ?? agent.label ?? agent.id, agentId: agent.agentId,
        agentConfigurationVersionId: version.agentConfigurationVersionIds[agent.agentId]!,
        position: { x: agent.position?.x ?? 0, y: agent.position?.y ?? 0 },
        size: { width: agent.width ?? 156, height: agent.height ?? 156 } }
    }),
    edges: version.definition.edges }
}

function dispatchCurrentBoardAgents({ path, method, prefix, body }: CurrentBoardMockRequest, state: CurrentBoardMockState): Response | undefined {
  const { catalog, workspaceId, configurations, agents, workflows, archivedWorkflows, journal } = state
  if (method === 'GET' && path === `${prefix}/agents`) return HttpResponse.json({ items: catalog, pageInfo })
  if (method === 'POST' && path === `${prefix}/agents`) {
    const input = AgentCreateInputSchema.parse({ ...(body as object), workspaceId })
    const result = journal(`agent-create:${input.commandId}`, input, () => {
      if (catalog.some((item) => item.agent.id === input.agentId)) throw new Error('AGENT_CONFLICT')
      const configuration = input.configuration ?? { harness: 'codex', model: 'synthetic-no-native-call',
        reasoningEffort: 'low', sandbox: 'read-only', serviceTier: 'standard' }
      const version = AgentConfigurationVersionSchema.parse({ id: `cfg-${input.agentId}-1`,
        agentId: input.agentId, workspaceId, version: 1, productRole: input.productRole,
        harness: configuration, prompt: input.prompt ?? {}, assignedSkills: input.assignedSkills ?? [], contentHash: hash, createdAt: at })
      const agent = AgentSchema.parse({ id: input.agentId, name: input.name, productRole: input.productRole,
        harness: version.harness.harness, harnessConfiguration: version.harness, configurationVersionId: version.id,
        description: input.description, role: input.role, prompt: version.prompt, assignedSkills: version.assignedSkills,
        createdAt: at, updatedAt: at })
      configurations.push(version); agents.push(agent); catalog.push({ agent, metadataRevision: 1, archivedAt: null })
      return { agent, metadataRevision: 1 }
    })
    return HttpResponse.json(AgentMutationResultSchema.parse(result), { status: 201 })
  }
  const agentMatch = path.match(/\/agents\/([^/]+)$/)
  if (method === 'GET' && agentMatch) {
    const item = catalog.find((item) => item.agent.id === agentMatch[1])
    return item ? HttpResponse.json({ ...item, workflowIds: [...workflows.values()].filter((graph) => !archivedWorkflows.has(graph.id)
      && graph.nodes.some((node) => nativeNode(node).agentId === item.agent.id)).map((graph) => graph.id) })
      : failure('NOT_FOUND', 'Agent not found', 404)
  }
  if (method === 'PATCH' && agentMatch) {
    const input = AgentUpdateInputSchema.parse({ ...(body as object), workspaceId, agentId: agentMatch[1] })
    const result = journal(`agent-update:${input.commandId}`, input, () => {
      const item = catalog.find((item) => item.agent.id === input.agentId)
      if (!item) throw new Error('AGENT_NOT_FOUND')
      if (input.expectedRevision !== item.metadataRevision) throw new Error('REVISION_CONFLICT')
      if (input.expectedConfigurationVersionId !== item.agent.configurationVersionId) throw new Error('CONFIGURATION_CONFLICT')
      const previous = configurations.find((version) => version.id === input.expectedConfigurationVersionId)!
      const changesConfiguration = input.configuration !== undefined || input.prompt !== undefined || input.assignedSkills !== undefined
      const version = changesConfiguration ? AgentConfigurationVersionSchema.parse({ ...previous,
        id: `cfg-${input.agentId}-${previous.version + 1}`, version: previous.version + 1,
        harness: input.configuration ?? previous.harness, prompt: input.prompt ?? previous.prompt,
        assignedSkills: input.assignedSkills ?? previous.assignedSkills, createdAt: at }) : previous
      const agent = AgentSchema.parse({ ...item.agent, name: input.name ?? item.agent.name,
        description: input.description === null ? undefined : input.description ?? item.agent.description,
        role: input.role === null ? undefined : input.role ?? item.agent.role,
        harness: version.harness.harness, harnessConfiguration: version.harness, configurationVersionId: version.id,
        prompt: version.prompt, assignedSkills: version.assignedSkills, updatedAt: at })
      if (changesConfiguration) configurations.push(version)
      agents[agents.findIndex((agent) => agent.id === input.agentId)] = agent
      item.agent = agent; item.metadataRevision++
      return { agent, metadataRevision: item.metadataRevision }
    })
    return HttpResponse.json(AgentMutationResultSchema.parse(result))
  }
  const configMatch = path.match(/\/agents\/([^/]+)\/versions\/([^/]+)$/)
  if (method === 'GET' && configMatch) { const version = configurations.find((c) => c.agentId === configMatch[1] && c.id === configMatch[2])
    return version ? HttpResponse.json({ version }) : failure('NOT_FOUND', 'Pinned configuration not found', 404) }
  return undefined
}

function dispatchCurrentBoardWorkflows({ url, path, method, prefix, publicPrefix, body }: CurrentBoardMockRequest, state: CurrentBoardMockState): Response | undefined {
  const { options, workspaceId, catalog, workflows, revisions, archivedWorkflows, managed, journal, install,
    drafts, versions, runs, currents, controls, intents, record, markStop, savePresentation, publish, nextWorkflow, nextRun } = state
  if (path === `${prefix}/workflows`) {
    if (method === 'GET') return HttpResponse.json({ items: [...workflows.keys()].filter((id) => url.searchParams.get('includeArchived') === 'true' || !archivedWorkflows.has(id)).map(managed), pageInfo })
    if (method === 'POST') { const input = CurrentWorkflowCreateInputSchema.parse(body)
      if (input.workspaceId !== workspaceId) return failure('SCOPE_MISMATCH', 'Out of scope')
      return HttpResponse.json(journal(`create:${input.commandId}`, input, () => install({ id: `workflow-current-${nextWorkflow()}`,
        workspaceId, name: input.name, ...(input.description ? { description: input.description } : {}), executionSemanticsVersion: 3,
        entryNodeId: null, nodes: [], edges: [], executionCondition: { kind: 'manual' },
        approval: { handler: DEFAULT_WORKFLOW_APPROVAL_HANDLER },
        executionPolicy: { maxParallelism: 4, maxNodeExecutions: 40 } })), { status: 201 }) }
  }
  if (path === `${prefix}/workflows/batch-archive` && method === 'POST') {
    const input = WorkflowBatchArchiveInputSchema.parse({ ...(body as object), workspaceId })
    return HttpResponse.json(journal(`workflow-batch:${input.commandId}`, input, () => {
      for (const item of input.workflows) {
        if (!workflows.has(item.workflowId)) throw new Error('WORKFLOW_NOT_FOUND')
        if (revisions.get(item.workflowId) !== item.expectedRevision) throw new Error('REVISION_CONFLICT')
        if ([...runs.values()].some(({ run }) => run.workflowId === item.workflowId && run.executionState !== 'completed')) throw new Error('ARCHIVE_BLOCKED_BY_ACTIVE_RUN')
      }
      for (const item of input.workflows) {
        archivedWorkflows.add(item.workflowId)
        revisions.set(item.workflowId, revisions.get(item.workflowId)! + 1)
      }
      return { workflowIds: input.workflows.map((item) => item.workflowId).sort() }
    }))
  }
  const workflowMatch = path.match(/\/workflows\/([^/]+)(.*)$/)
  if (workflowMatch) {
    const id = workflowMatch[1]!, tail = workflowMatch[2]!, draft = drafts.get(id)
    if (!draft) return failure('NOT_FOUND', 'Workflow not found', 404)
    if (!tail && method === 'GET') return HttpResponse.json(path.startsWith(publicPrefix) ? { workflow: workflows.get(id) } : managed(id))
    if (!tail && (method === 'PATCH' || method === 'DELETE')) {
      const input = (method === 'PATCH' ? WorkflowUpdateInputSchema : WorkflowArchiveInputSchema)
        .parse({ ...(body as object), workspaceId, workflowId: id })
      return HttpResponse.json(journal(`workflow-${method}:${input.commandId}`, input, () => {
        if (input.expectedRevision !== revisions.get(id)) throw new Error('REVISION_CONFLICT')
        if (method === 'DELETE') archivedWorkflows.add(id)
        else {
          const update = WorkflowUpdateInputSchema.parse(input), graph = workflows.get(id)!
          workflows.set(id, WorkflowDefinitionV3Schema.parse({ ...graph, name: update.name ?? graph.name,
            description: update.description === null ? undefined : update.description ?? graph.description, updatedAt: at }))
          options.onSaved?.(copy(workflows.get(id)!))
        }
        const revision = revisions.get(id)! + 1
        revisions.set(id, revision)
        drafts.set(id, { ...draft, graph: workflows.get(id)!, revision, publishedRevision: revision })
        return managed(id)
      }))
    }
    if (method === 'GET' && tail.startsWith('/versions/')) { const version = versions.get(tail.slice('/versions/'.length))
      return version?.workflowId === id ? HttpResponse.json({ version }) : failure('NOT_FOUND', 'Version not found', 404) }
    if (method === 'GET' && tail === '/versions') return HttpResponse.json({ items: [...versions.values()].filter((v) => v.workflowId === id), pageInfo })
    if (tail === '/runs' && method === 'POST') {
      const input = RunStartV3InputSchema.parse(body)
      if (controls.deniedStart) return failure('FORBIDDEN', 'Start denied for exact workflow', 403)
      if (controls.unsupportedStart || !controls.start) return failure('EXECUTION_SEMANTICS_UNSUPPORTED', 'Synthetic runtime admission is disabled', 409)
      const response = journal(`start:${input.commandId}`, input, () => {
        if (controls.staleStart || input.expectedWorkflowRevision !== revisions.get(id) || input.workflowVersionId !== draft.baseWorkflowVersionId
          || input.expectedLocationRevision !== controls.locationRevision) throw new Error('REVISION_CONFLICT')
        const version = versions.get(input.workflowVersionId)!
        if (!sameWorkflowValue(input.expectedAgentConfigurationVersionIds, version.agentConfigurationVersionIds)) throw new Error('CONFIGURATION_CONFLICT')
        const run = AcceptedWorkflowRunV3Schema.parse({ id: `run-current-${nextRun()}`, workspaceId, workflowId: id,
          workflowVersionId: version.id, agentConfigurationVersionIds: version.agentConfigurationVersionIds, executionSemanticsVersion: 3,
          authorizationPrincipalId: 'principal-current-mock', approval: version.approval, executionCondition: version.definition.executionCondition,
          executionLocation: { runnerId: 'runner-synthetic', rootPath: '/synthetic/board', locationRevision: controls.locationRevision, identityHash: hash },
          input: input.input, executionState: 'queued', outcome: 'pending', createdAt: at })
        runs.set(run.id, { run, executions: [], activity: [], cleanupPending: false })
        currents.set(run.id, RepeatGraphCurrentV3Schema.parse({ kind: 'current', protocolVersion: 1,
          scope: { workspaceId, workflowId: id, runId: run.id, workflowVersionId: version.id, executionSemanticsVersion: 3 },
          topology: repeatGraphTopologyV3(version), asOfSequence: '0', retentionFloor: '0', historyCoverage: 'from_admission',
          state: { run: { executionState: 'queued', outcome: 'pending', stopRequested: false, cleanupPending: false, unsettledReviewCount: 0, pendingInteractionCount: 0 }, nodes: [], inputBindings: [], interactions: [], reviews: [], occurrences: [], executions: [], resolutions: [], results: [], bindings: [], decisions: [] } }))
        return { run, accepted: true as const }
      })
      if (controls.loseStartReply) { controls.loseStartReply = false; return HttpResponse.error() }
      return HttpResponse.json({ ...response.value, replayed: response.replayed })
    }
    if (tail === '/definition' && method === 'GET') {
      const version = versions.get(draft.baseWorkflowVersionId!)
      return version ? HttpResponse.json({ workspaceId, workflowId: id, revision: revisions.get(id), currentVersionId: version.id, version }) : failure('NOT_FOUND', 'No saved definition', 404)
    }
    if (tail === '/definition' && method === 'PUT' || tail === '/definition/validate' && method === 'POST') {
      const input = (method === 'PUT' ? CurrentWorkflowSaveInputSchema : CurrentWorkflowValidateInputSchema).parse({ ...(body as object), workspaceId, workflowId: id })
      const check = () => {
        if (input.expectedRevision !== revisions.get(id) || input.expectedWorkflowVersionId !== draft.baseWorkflowVersionId) throw new Error('REVISION_CONFLICT')
        for (const node of input.graph.nodes.filter(node=>node.kind!=='job')) if (!catalog.some((a) => a.agent.id === nativeNode(node).agentId)) throw new Error('CONFIGURATION_CONFLICT')
      }
      if (method === 'POST') { check(); return HttpResponse.json({ valid: true, executionSemanticsVersion: 3, expectedRevision: input.expectedRevision, expectedWorkflowVersionId: input.expectedWorkflowVersionId, expectedAgentConfigurationVersionIds: input.expectedAgentConfigurationVersionIds, runtimeAdmission: controls.start, stopAvailable: controls.start }) }
      const save = CurrentWorkflowSaveInputSchema.parse(input)
      return HttpResponse.json(journal(`save:${save.commandId}`, save, () => {
        check()
        const version = versions.get(draft.baseWorkflowVersionId!)
        if (version && sameExecutableWorkflow(workflows.get(id)!, save.graph)
          && sameWorkflowValue(version.agentConfigurationVersionIds, save.expectedAgentConfigurationVersionIds)) {
          return savePresentation(id, save.graph)
        }
        // Mirror currentAuthoring.prepare -> assertMeaningfulSaveAdmitted.
        // A stale Board summary cannot authorize publication or an implicit Stop.
        const unsettled = [...runs.values()].some((detail) => detail.run.workflowId === id
          && (detail.run.executionState !== 'completed' || detail.cleanupPending !== false
            || (currents.get(detail.run.id)?.state.run.pendingInteractionCount ?? 0) > 0
            || (currents.get(detail.run.id)?.state.run.unsettledReviewCount ?? 0) > 0))
        if (unsettled) throw new Error('WORKFLOW_RUNS_UNSETTLED')
        return publish({ workflowId: id, graph: save.graph })
      }))
    }
    if (tail === '/definition/edits') {

        if (method === 'GET') return HttpResponse.json(record(id))
        if (method === 'POST' && (body as { action?: string }).action === 'stage_edits') {
          const input = GraphEditStageInputV3Schema.parse(body)
          const response = journal(`stage:${input.commandId}`, input, () => {
            if (input.expectedRevision !== revisions.get(id) || input.expectedWorkflowVersionId !== draft.baseWorkflowVersionId) throw new Error('REVISION_CONFLICT')
            const version = versions.get(draft.baseWorkflowVersionId!)
            const presentationOnly = !!version && !input.stagedAgents?.length
              && sameExecutableWorkflow(workflows.get(id)!, input.graph)
              && sameWorkflowValue(version.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)
            const stagedDraft = { id: input.draftId, workspaceId, workflowId: id, revision: input.expectedRevision,
              baseWorkflowVersionId: input.expectedWorkflowVersionId, graph: input.graph,
              ...(presentationOnly ? { presentationOnly: true as const } : {}),
              agentConfigurationVersionIds: input.expectedAgentConfigurationVersionIds }
            const affected = (presentationOnly ? [] : [...runs.values()]).filter((r) => r.run.executionState !== 'completed' || r.cleanupPending).map(({ run }) => ({
              workspaceId, workflowId: run.workflowId, runId: run.id, workflowVersionId: run.workflowVersionId,
              executionSemanticsVersion: 3 as const, agentConfigurationVersionIds: run.agentConfigurationVersionIds }))
            const intentId = `intent-${input.commandId}`
            const intent = { kind: 'current', id: intentId, ownerPrincipalId: 'principal-current-mock', workspaceId, workflowId: id, draftId: input.draftId,
              stageCommandId: input.commandId, stageInputHash: hash, expectedRevision: input.expectedRevision,
              expectedWorkflowVersionId: input.expectedWorkflowVersionId, savedWorkflowRevision: revisions.get(id)!, stagedDraft, agentPins: input.graph.nodes.filter(node=>node.kind!=='job').map((node) => ({ agentId: nativeNode(node).agentId, metadataRevision: catalog.find((a) => a.agent.id === nativeNode(node).agentId)!.metadataRevision, configurationVersionId: input.expectedAgentConfigurationVersionIds[nativeNode(node).agentId] })), affected,
              advanceCommandId: `advance-${input.commandId}`, advanceInputHash: hash, discardCommandId: `discard-${input.commandId}`, discardInputHash: hash,
              stops: affected.map((pin) => ({ input: { workspaceId, runId: pin.runId, commandId: `stop-${intentId}-${pin.runId}` } })),
              saveInput: { workspaceId, workflowId: id, commandId: `save-${input.commandId}`, executionSemanticsVersion: 3 as const, expectedRevision: input.expectedRevision, expectedWorkflowVersionId: input.expectedWorkflowVersionId, expectedAgentConfigurationVersionIds: input.expectedAgentConfigurationVersionIds, graph: input.graph },
              saveInputHash: hash, state: 'staged' as const, saveAttempted: false, createdAt: at, updatedAt: at }
            intents.set(id, GraphEditReadResultV3Schema.parse({ ...emptyIntent(), intent })); return record(id)
          })
          if (controls.loseStageReply) { controls.loseStageReply = false; return HttpResponse.error() }
          return HttpResponse.json(response.replayed ? record(id) : response.value)
        }
        if (method === 'POST' && (body as { action?: string }).action === 'stop_and_save') {
          const input = GraphEditAdvanceInputV3Schema.parse(body), read = record(id), intent = read.intent
          if (!intent || input.intentId !== intent.id || input.commandId !== intent.advanceCommandId) return failure('INTENT_CONFLICT', 'Wrong exact intent')
          if (intent.state === 'saved') return HttpResponse.json(read)
          if (read.affectedSetChanged || !read.canStop && read.current.some((r) => !r.settled)) return failure('FORBIDDEN', 'Affected runs cannot be stopped', 403)
          if (read.current.some((r) => !r.settled)) {
            if (!['waiting', 'stopping'].includes(intent.state)) controls.stopCalls += intent.stops.length
            intent.state = 'waiting'; for (const pin of intent.affected) { const detail = runs.get(pin.runId)
              if (detail) detail.cleanupPending = true; markStop(pin.runId) }
          } else {
            intent.result = intent.stagedDraft.presentationOnly
              ? savePresentation(id, preserveWorkflowGeometry(intent.stagedDraft.graph, workflows.get(id)!))
              : publish(intent.stagedDraft)
            intent.saveAttempted = true
            intent.state = 'saved'
          }
          intents.set(id, read); return HttpResponse.json(record(id))
        }
        if (method === 'POST' && (body as { action?: string }).action === 'discard_edits') {
          const input = GraphEditDiscardInputV3Schema.parse(body), read = record(id)
          if (!read.intent || input.intentId !== read.intent.id || input.commandId !== read.intent.discardCommandId) return failure('INTENT_CONFLICT', 'Wrong exact intent')
          if (read.intent.state === 'saved') return failure('ALREADY_SAVED', 'Cannot discard a saved version')
          read.intent.state = 'discarded'; intents.set(id, read); return HttpResponse.json(record(id))
        }
    }
  }
  return undefined
}
