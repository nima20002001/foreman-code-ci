import { agentChatHandlers, resetAgentChatFixtures } from './agentChatHandlers'
import { createCurrentBoardMock } from './currentBoard'
import { ComputerAccountsReadInputSchema } from '@foreman-code/contracts/computer-accounts'
import { ComputerMaintenanceReadInputSchema } from '@foreman-code/contracts/computer-maintenance'
import { http, HttpResponse, type RequestHandler } from 'msw'
import { settingsExperienceHandlers, resetSettingsExperienceFixtures, getMockWorkspaceCreationDefaults } from './settingsExperienceHandlers'
import { resetSkillFixtures, skillsHandlers } from './skillsHandlers'
import { ApiErrorResponseSchema, SessionControlStateSchema, unavailableSessionControls } from '@foreman-code/contracts'
import { CURRENT_WORKFLOW_CAPABILITIES, type WorkflowDefinitionV3 as WorkflowDefinition, type WorkflowRunV3 as WorkflowRun } from '@foreman-code/contracts/wave25'
import {
  AgentDefaultsUpdateInputSchema,
  GeneralSettingsUpdateInputSchema,
  type ManagedGeneralSettings,
  HarnessConfigurationCheckInputSchema,
  HarnessDefaultsUpdateInputSchema,
  WorkflowDefaultsUpdateInputSchema,
  WorkspaceLocationSetInputSchema,
  WorkspaceLocationValidateInputSchema,
  type ManagedWorkspace,
} from '@foreman-code/contracts/management'

import {
  getMockFixture,
  getMockAgentDefaults,
  getMockHarnessCatalog,
  getMockScenarioRevision,
  getMockScenarioState,
  getMockWorkflowDefaults,
  resetMockFixtures as resetExistingMockFixtures,
  serializeAgent,
  shouldFailMutation,
  updateMockWorkflow,
  updateMockAgentDefaults,
  updateMockManagedHarnessDefaults,
  updateMockWorkflowDefaults,
} from './scenarios'

const currentAuthoringMocks = new Map<string, ReturnType<typeof createCurrentBoardMock>>()
const managedWorkspaceNames = new Map<string, string>()
const managedWorkspaceDescriptions = new Map<string, string | undefined>()
const managedWorkspaceArchives = new Set<string>()
const managedWorkspaces = new Map<string, ManagedWorkspace>()
let managedScenarioRevision = getMockScenarioRevision()
let generalSettings: ManagedGeneralSettings = { value: { theme: 'dark' }, revision: 0, versionId: null }

function syncManagedFixtures() {
  const revision = getMockScenarioRevision()
  if (revision === managedScenarioRevision) return
  managedScenarioRevision = revision
  managedWorkspaceNames.clear()
  managedWorkspaceDescriptions.clear()
  managedWorkspaceArchives.clear()
  managedWorkspaces.clear()
  currentAuthoringMocks.clear()
}

export function resetTestFixtures() {
  generalSettings = { value: { theme: 'dark' }, revision: 0, versionId: null }
  resetAgentChatFixtures()
  resetExistingMockFixtures()
  resetSettingsExperienceFixtures()
  resetSkillFixtures()
  managedWorkspaceNames.clear()
  managedWorkspaceDescriptions.clear()
  managedWorkspaceArchives.clear()
  managedWorkspaces.clear()
  currentAuthoringMocks.clear()
  mockLocations.clear()
  managedScenarioRevision = getMockScenarioRevision()
}

const errorSchema = ApiErrorResponseSchema

function apiError(
  code: string,
  message: string,
  status: number,
  details?: Record<string, unknown>,
) {
  const body = { error: { code, message, ...(details ? { details } : {}) } }
  // Keep fixture failures contract-shaped too; this catches accidental drift
  // while the handlers are authored.
  errorSchema.parse(body)
  return HttpResponse.json(body, { status })
}

function readFailure() {
  if (getMockScenarioState().scenarioId !== 'error') return undefined
  return apiError('MOCK_READ_FAILED', 'The selected mock scenario fails read requests.', 503)
}

function fixtureNotFound(kind: string, id: string) {
  return apiError(
    kind === 'workspace' ? 'WORKSPACE_NOT_FOUND' : 'NOT_FOUND',
    `${kind} '${id}' was not found.`,
    404,
  )
}

const operatorConversations: Array<Record<string, unknown>> = []
const operatorMessages = new Map<string, Array<Record<string, unknown>>>()

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return undefined
  }
}

const mockStartedRun: WorkflowRun = {
  executionSemanticsVersion: 3,
  id: 'run-mock-started',
  workspaceId: 'workspace-1',
  workflowId: 'workflow-editor-test',
  approval: { handler: 'user' },
  workflowVersionId: 'workflow-editor-test-v1',
  agentConfigurationVersionIds: {},
  executionCondition: { kind: 'manual' },
  executionState: 'completed',
  outcome: 'succeeded',
  input: {},
  result: { outcome: 'succeeded', output: { text: 'Mock test result' } },
  createdAt: '2026-01-01T00:00:00.000Z',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z',
}

const mockLocations = new Map<string, { rootPath: string; revision: number }>()

function managedWorkspace(workspaceId: string) {
  const fixture = getMockFixture(workspaceId)
  if (!fixture) return undefined
  const location = mockLocations.get(workspaceId)
  return {
    workspace: fixture.workspace,
    revision: 1,
    archivedAt: null,
    executionLocation: location ? { runnerId: 'runner-local', rootPath: location.rootPath } : null,
    locationRevision: location?.revision ?? 0,
    locationValidation: location
      ? { status: 'ready' as const, checkedAt: new Date().toISOString() }
      : { status: 'unconfigured' as const },
  }
}

function visibleManagedWorkspace(workspaceId: string) {
  syncManagedFixtures()
  const stored = managedWorkspaces.get(workspaceId)
  const base = stored ?? managedWorkspace(workspaceId)
  if (!base) return undefined
  return {
    ...base,
    workspace: {
      ...base.workspace,
      name: managedWorkspaceNames.get(workspaceId) ?? base.workspace.name,
      description: managedWorkspaceDescriptions.has(workspaceId)
        ? managedWorkspaceDescriptions.get(workspaceId)
        : base.workspace.description,
    },
    archivedAt: managedWorkspaceArchives.has(workspaceId) ? new Date().toISOString() : null,
  }
}

/** All ordinary/repeat authoring uses this same stateful CURRENT V3 MSW
 * service. Capabilities never claim native Start. Scenario reset, not a GET,
 * clears its command journal and saved versions. */
function currentAuthoringMock(workspaceId: string) {
  syncManagedFixtures()
  const fixture = getMockFixture(workspaceId)
  if (!fixture) return undefined
  let service = currentAuthoringMocks.get(workspaceId)
  if (!service) {
    service = createCurrentBoardMock({ workspaceId, agents: fixture.agents,
      onSaved: (graph) => { updateMockWorkflow(workspaceId, graph) } })
    for (const graph of fixture.workflows) service.install(graph, graph.nodes.length > 0)
    currentAuthoringMocks.set(workspaceId, service)
  }
  // The definition service sees the same persisted location revision as management reads.
  service.controls.locationRevision = visibleManagedWorkspace(workspaceId)?.locationRevision ?? 0
  return service
}
const currentAuthoringHandler = http.all(/\/api\/management\/workspaces\/[^/]+\/(?:workflows|agents)(?:\/|$)/, async ({ request }) => {
  const url = new URL(request.url), path = decodeURIComponent(url.pathname)
  // Definition, journal, metadata and Agent reads share one current mock service.
  // Unrelated settings/location endpoints retain their own handlers.
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return undefined
  const match = path.match(/^\/api\/management\/workspaces\/([^/]+)\/(workflows|agents)(.*)$/)
  if (!match) return undefined
  const [, workspaceId, family, tail] = match
  if (family === 'agents' && !/^(?:|\/[^/]+(?:\/versions\/[^/]+)?)$/.test(tail!)) return undefined
  if (family === 'workflows' && !/^(?:|\/[^/]+(?:\/(?:definition(?:\/(?:validate|edits))?|versions(?:\/[^/]+)?|runs))?)$/.test(tail!)) return undefined
  const failure = readFailure()
  if (failure) return failure
  const service = currentAuthoringMock(workspaceId!)
  if (!service) return fixtureNotFound('workspace', workspaceId!)
  if (family === 'workflows' && request.method !== 'GET' && shouldFailMutation('graph-save')) return apiError('MOCK_GRAPH_SAVE_FAILED', 'Synthetic graph Save failure.', 409)
  const result = await service.dispatch(request)
  for (const graph of service.workflows.values()) updateMockWorkflow(workspaceId!, graph)
  return result
})

export const mockRuntimeIdentity = { installationId: 'd95abeb8-598a-49a4-8c3c-c6e3533053e8', checkoutId: 'a'.repeat(64), databaseId: 'b'.repeat(64) }
/** Ordinary fixtures model an already-bound installation; call again after clearing localStorage. */
export function bindMockInstallation(): void {
  window.localStorage.setItem('graphql.chat-instance-binding', `${mockRuntimeIdentity.checkoutId}:${mockRuntimeIdentity.installationId}`)
}

function sessionControlsResponse(conversationId: string) {
  return HttpResponse.json(SessionControlStateSchema.parse({
    conversationId, revision: 0, profileKey: 'mock-profile', desiredMode: 'regular', appliedMode: null,
    defaults: {}, desired: {}, applied: null, applicability: 'next-turn', context: null,
    nativeSessionId: null, nativeProviderVersion: null, compaction: null, compactions: [], busyReason: null,
    capabilities: unavailableSessionControls('mock-profile'),
  }))
}

export const handlers: RequestHandler[] = [
  // The Board polls each workflow's Run list; tests that need Runs install their own page.
  http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/summaries',
    () => HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })),
  http.get('/api/management/workspaces/:workspaceId/repository', ({ params, request }) => {
    const workspaceId = String(params.workspaceId)
    if (new URL(request.url).searchParams.has('commandId')) {
      return apiError('IMPORT_NOT_FOUND', 'The requested import is not in this fixture.', 404)
    }
    const workspace = visibleManagedWorkspace(workspaceId)
    return HttpResponse.json({ workspaceId, state: workspace?.workspace.repository ? 'metadata-only' : 'unconfigured',
      repository: workspace?.workspace.repository ?? null, revision: workspace?.revision ?? 0 })
  }),
  http.get('/api/management/workspaces/:workspaceId/source-roots', () =>
    HttpResponse.json({ items: [], readiness: 'metadata-only' })),
  http.get('/api/management/workspaces/:workspaceId/root-policies', ({ params }) =>
    HttpResponse.json({ workspaceId: String(params.workspaceId), policies: [], allowlists: [], readiness: 'metadata-only' })),
  http.get('/api/management/workspaces/:workspaceId/root-location', ({ params }) =>
    HttpResponse.json({ evidence: 'unconfigured', workspaceId: String(params.workspaceId), locationRevision: 0, executionLocation: null })),
  http.get('/api/workspaces/:workspaceId/agent-chat/session-controls', () =>
    sessionControlsResponse('mock-conversation')),
  http.get('/api/operator/conversations/:conversationId/session-controls', ({ params }) =>
    sessionControlsResponse(String(params.conversationId))),
  http.get('/api/workspaces/:workspaceId/agent-chat/conversations/:conversationId/session-controls', ({ params }) =>
    sessionControlsResponse(String(params.conversationId))),
  http.get('*/api/management/computers/maintenance', () => HttpResponse.json({ computers: [] })),
  http.post('*/api/management/computers/maintenance/read', async ({ request }) => {
    const { target } = ComputerMaintenanceReadInputSchema.parse(await request.json())
    return HttpResponse.json({ computers: [{ target, status: null }] })
  }),
  http.post('*/api/management/computers/accounts/read', async ({ request }) => {
    const { target } = ComputerAccountsReadInputSchema.parse(await request.json())
    return HttpResponse.json({ computers: [{ target, accounts: null }] })
  }),
  http.post('*/api/management/computers/maintenance/start', () => HttpResponse.json({ computers: [] })),
  http.get('*/api/management/computers/activity', () => HttpResponse.json({
    mainId: '11111111-1111-4111-8111-111111111111', computers: [], cloud: [], truncated: false, activityComplete: true,
  })),
  ...agentChatHandlers,
  currentAuthoringHandler,
  http.get('/api/runtime/identity', () => HttpResponse.json(mockRuntimeIdentity)),
  http.get('/api/runtime/build-identity/v1', () => HttpResponse.json({ version: 1, buildId: 'a'.repeat(64), contractsId: 'b'.repeat(64) })),
  http.get('/api/provider-accounts/targets', () => HttpResponse.json({ targets: [{
    target: { hostRef: { kind: 'main', mainId: mockRuntimeIdentity.installationId },
      applicationInstallationId: mockRuntimeIdentity.installationId, keyRevision: null, authorizationRevision: null },
    label: 'Main', generation: 1, connected: true, canRead: true, canManage: false,
    providers: ['codex', 'claude'].map(provider => ({ provider, qualified: false, actions: [], reason: null })),
  }] })),
  http.get('/api/provider-accounts/page', ({ request }) => HttpResponse.json({
    target: JSON.parse(new URL(request.url).searchParams.get('target')!),
    revision: 1, accounts: [], defaults: [], nextCursor: null,
  })),
  http.get('/api/management/harnesses/registry', () => readFailure() ?? HttpResponse.json({
    instances: [], installations: [], hostMetadata: {
      hostRef: { kind: 'main', mainId: mockRuntimeIdentity.installationId },
      applicationInstallationId: mockRuntimeIdentity.installationId,
      connection: null, platform: null, workspaceRoots: null,
    },
  })),
  ...settingsExperienceHandlers,
  ...skillsHandlers,
  http.get('/api/operator/setup', () => HttpResponse.json({ harness: getMockAgentDefaults().value.operator.harness.harness,
    status: 'configured', configurationVersionId: 'operator-config',
    endpoint: 'http://127.0.0.1:3000/mcp', checkedAt: new Date().toISOString() })),
  http.get('/api/operator/conversations/summaries', () => HttpResponse.json({
    conversations: operatorConversations.map((item) => ({
      conversationId: item.id, title: item.title, turnState: 'idle', revision: 0,
      activeRequestId: null, needsAttention: false,
    })),
  })),
  http.get('/api/operator/conversations', () => HttpResponse.json({ conversations: operatorConversations })),
  http.post('/api/operator/conversations', () => {
    const now = new Date().toISOString()
    const conversation = { id: crypto.randomUUID(), agentId: 'application-operator', scope: 'application', operatorConfigurationVersionId: 'operator-config-v1', title: 'New conversation', status: 'open', createdAt: now, updatedAt: now }
    operatorConversations.unshift(conversation); operatorMessages.set(String(conversation.id), [])
    return HttpResponse.json({ conversation }, { status: 201 })
  }),
  http.get('/api/operator/conversations/:conversationId', ({ params }) => {
    const id = String(params.conversationId); let conversation = operatorConversations.find((item) => item.id === id)
    if (!conversation) {
      const now = new Date().toISOString()
      conversation = { id, agentId: 'application-operator', scope: 'application', operatorConfigurationVersionId: 'operator-config-v1', title: 'New conversation', status: 'open', createdAt: now, updatedAt: now }
      operatorConversations.unshift(conversation); operatorMessages.set(id, [])
    }
    return HttpResponse.json({ conversation, messages: operatorMessages.get(id) ?? [], turnState: 'idle' })
  }),
  http.get('/api/operator/conversations/:conversationId/events', ({ params }) => {
    const body = `event: snapshot\ndata: ${JSON.stringify({ conversationId: String(params.conversationId) })}\n\n`
    return new HttpResponse(body, { headers: { 'content-type': 'text/event-stream' } })
  }),
  http.post('/api/operator/conversations/:conversationId/messages', async ({ params, request }) => {
    const id = String(params.conversationId); const conversation = operatorConversations.find((item) => item.id === id)
    if (!conversation) return fixtureNotFound('conversation', id)
    const body = await readJson(request) as { requestId?: string; content?: string }
    const now = new Date().toISOString(); const messages = operatorMessages.get(id) ?? []
    messages.push({ id: crypto.randomUUID(), conversationId: id, role: 'user', content: body.content ?? '', createdAt: now, updatedAt: now })
    messages.push({ id: crypto.randomUUID(), conversationId: id, role: 'assistant', content: 'Deterministic Operator response.', createdAt: now, updatedAt: now })
    operatorMessages.set(id, messages)
    return HttpResponse.json({ state: { conversation, messages, turnState: 'idle' }, replayed: false }, { status: 202 })
  }),
  http.get('/api/management/interactions', () => HttpResponse.json({
    items: [], nextCursor: null, pendingCount: 0, pendingByWorkflow: {},
  })),
  // The Board's CI server: no Agent of a mock Run has requested CI unless a test says so.
  http.get('/api/management/workspaces/:workspaceId/ci', ({ request }) => HttpResponse.json({
    runId: new URL(request.url).searchParams.get('runId'), jobs: [], truncated: false,
  })),
  http.get('/api/management/harnesses/:harness/execution-readiness', ({ params, request }) => HttpResponse.json({
    harness: params.harness, scope: new URL(request.url).searchParams.get('scope') ?? 'saved-harness-defaults',
    ...(new URL(request.url).searchParams.has('configurationVersionId') ? { configurationVersionId: new URL(request.url).searchParams.get('configurationVersionId') } : {}),
    status: 'unverified', rolloutEnabled: false,
    defaultsRevision: null, checkedAt: new Date().toISOString(),
    reason: { code: 'HARNESS_DISCOVERY_UNAVAILABLE', message: 'Execution qualification has not been checked.' },
    limitation: 'Deterministic fixture; no native execution.',
  })),
  http.get('/api/management/harnesses', () => HttpResponse.json(getMockHarnessCatalog())),
  http.get('/api/management/harnesses/:harness/options', ({ params }) => {
    const harness = String(params.harness)
    if (harness !== 'codex' && harness !== 'claude') return fixtureNotFound('harness', harness)
    return HttpResponse.json({
      harness, providerVersion: 'mock', authenticated: true,
      models: harness === 'codex' ? [
        { id: 'gpt-5.6-luna', name: 'gpt-5.6-luna', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], variants: [], serviceTiers: ['standard', 'priority'] },
        { id: 'gpt-5.6-terra', name: 'gpt-5.6-terra', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], variants: [], serviceTiers: ['standard', 'priority'] },
        { id: 'gpt-5.6-sol', name: 'gpt-5.6-sol', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], variants: [], serviceTiers: ['standard', 'priority'] },
        { id: 'gpt-6-astra', name: 'gpt-6-astra', reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'], variants: [], serviceTiers: ['standard', 'priority'] },
      ] : [{ id: 'claude-haiku-4-5-20251001', name: 'Claude Haiku 4.5', reasoningEfforts: [], variants: [], serviceTiers: [] }],
      nativeAgents: [], settings: [], restrictions: [], checkedAt: new Date().toISOString(),
    })
  }),
  http.post('/api/management/harnesses/:harness/refresh', ({ params }) => HttpResponse.json({
    harness: params.harness, providerVersion: 'mock', authenticated: true, models: [], nativeAgents: [], settings: [], restrictions: [], checkedAt: new Date().toISOString(),
  })),
  http.get('/api/management/harnesses/:harness/mcp', ({ params }) => HttpResponse.json({
    harness: params.harness, revision: `sha256:${'0'.repeat(64)}`, servers: [], checkedAt: new Date().toISOString(), scope: 'native-user',
  })),
  http.get('/api/management/harnesses/:harness/mcp/plans', () => HttpResponse.json({ items: [] })),
  http.post('/api/management/harnesses/validate', async ({ request }) => {
    const parsed = HarnessConfigurationCheckInputSchema.safeParse(await readJson(request))
    if (!parsed.success) return apiError('INVALID_HARNESS_CONFIGURATION', 'Review the Harness configuration.', 400)
    return HttpResponse.json({
      configuration: parsed.data.configuration,
      qualification: {
        harness: parsed.data.configuration.harness,
        version: 'mock',
        authenticated: true,
        ready: true,
        structuredEvents: true,
        supportsResume: true,
        supportsCancellation: true,
        supportsWorkingDirectory: true,
        supportsStartupPrompt: true,
        supportedNativeTools: [],
        supportedSettings: [],
        unsupportedCapabilities: [],
      },
      checkedAt: new Date().toISOString(),
    })
  }),
  http.put('/api/management/harnesses/defaults', async ({ request }) => {
    const parsed = HarnessDefaultsUpdateInputSchema.safeParse(await readJson(request))
    if (!parsed.success) return apiError('INVALID_HARNESS_DEFAULTS', 'Review the Harness defaults.', 400)
    const value = updateMockManagedHarnessDefaults(parsed.data.defaults, parsed.data.expectedRevision)
    return value
      ? HttpResponse.json({ value, replayed: false })
      : apiError('REVISION_CONFLICT', 'Harness defaults changed since they were read.', 409, { currentRevision: getMockHarnessCatalog()[0]?.defaultsRevision ?? 0 })
  }),
  http.get('/api/management/settings/agents', () => HttpResponse.json(getMockAgentDefaults())),
  http.get('/api/management/settings/general', () => HttpResponse.json(generalSettings)),
  http.put('/api/management/settings/general', async ({ request }) => {
    const input = GeneralSettingsUpdateInputSchema.parse(await request.json())
    if (input.expectedRevision !== generalSettings.revision) {
      return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'General settings changed.' } }, { status: 409 })
    }
    generalSettings = { value: input.value, revision: generalSettings.revision + 1, versionId: crypto.randomUUID() }
    return HttpResponse.json({ value: generalSettings, replayed: false })
  }),
  http.put('/api/management/settings/agents', async ({ request }) => {
    const parsed = AgentDefaultsUpdateInputSchema.safeParse(await readJson(request))
    if (!parsed.success) return apiError('INVALID_AGENT_DEFAULTS', 'Review the Agent defaults.', 400)
    const value = updateMockAgentDefaults(parsed.data.value, parsed.data.expectedRevision)
    return value
      ? HttpResponse.json({ value, replayed: false })
      : apiError('REVISION_CONFLICT', 'Agent defaults changed since they were read.', 409, { currentRevision: getMockAgentDefaults().revision })
  }),
  http.get('/api/management/settings/workflows', () => HttpResponse.json(getMockWorkflowDefaults())),
  http.put('/api/management/settings/workflows', async ({ request }) => {
    const parsed = WorkflowDefaultsUpdateInputSchema.safeParse(await readJson(request))
    if (!parsed.success) return apiError('INVALID_WORKFLOW_DEFAULTS', 'Review the Workflow defaults.', 400)
    const value = updateMockWorkflowDefaults(parsed.data.value, parsed.data.expectedRevision)
    return value
      ? HttpResponse.json({ value, replayed: false })
      : apiError('REVISION_CONFLICT', 'Workflow defaults changed since they were read.', 409, { currentRevision: getMockWorkflowDefaults().revision })
  }),
  http.get('/api/management/workspaces/:workspaceId/harnesses/:harness/mcp-detection', ({ params }) => {
    const harness = String(params.harness)
    if (harness !== 'codex' && harness !== 'claude') return fixtureNotFound('harness', harness)
    return HttpResponse.json({
      runnerId: 'runner-local',
      workingDirectory: '/workspace',
      providerVersion: 'mock',
      nativeFilters: {},
      detection: {
        harness,
        serverName: 'graphql',
        state: 'not_detected',
        endpointMatches: null,
        credentialEnvironmentVariable: null,
        checkedAt: '2026-09-16T00:00:00.000Z',
      },
    })
  }),
  http.get('/api/management/workspaces', () => {
    const failure = readFailure()
    if (failure) return failure
    const base = visibleManagedWorkspace('workspace-1')
    const items = [base, ...managedWorkspaces.values()]
      .filter((item): item is NonNullable<typeof item> => Boolean(item && !item.archivedAt))
    return HttpResponse.json({ items, pageInfo: { nextCursor: null } })
  }),
  http.get('/api/management/workspaces/:workspaceId/jobs/runtime-profiles', () => HttpResponse.json({ profiles: [], approvals: [] })),
  http.get('/api/management/workspaces/:workspaceId/jobs/runtime-profiles/:profileId/computer-preparation', ({ params }) => HttpResponse.json({
    profileId: params.profileId, deviceId: null, state: 'idle', commit: null, stage: null, message: null, profiles: [], startedAt: null, updatedAt: null })),
  http.get('/api/management/workspace-storage/folders', () => HttpResponse.json({
    rootPath: '/workspaces', items: [], pageInfo: { nextCursor: null },
  })),

  http.post('/api/management/workspaces', async ({ request }) => {
    const body = await readJson(request) as { name?: string; description?: string; parentPath?: string }
    if (body?.name !== undefined && !body.name.trim()) return apiError('INVALID_REQUEST', 'A workspace name is required.', 400)
    const defaults = getMockWorkspaceCreationDefaults()
    const baseName = body.name?.trim() ?? defaults.suggestedName
    let name = baseName
    if (body.name === undefined) {
      const names = new Set([visibleManagedWorkspace('workspace-1'), ...managedWorkspaces.values()]
        .filter((item) => item && !item.archivedAt).map((item) => item!.workspace.name))
      for (let suffix = 1; names.has(name); suffix++) {
        const ending = ` (${suffix})`
        name = baseName.slice(0, 200 - ending.length).trimEnd() + ending
      }
    }
    const description = body.description ?? defaults.description
    const id = `workspace-${crypto.randomUUID()}`
    const now = new Date().toISOString()
    const value = {
      workspace: {
        id, name, ...(description ? { description } : {}),
        agentIds: [], workflowIds: [], createdAt: now, updatedAt: now,
      },
      revision: 1,
      archivedAt: null,
      executionLocation: body.parentPath ? { runnerId: 'runner-local', rootPath: body.parentPath.replace(/\/$/, '') + '/' + name } : null,
      locationRevision: body.parentPath ? 1 : 0,
      locationValidation: body.parentPath ? { status: 'ready' as const, checkedAt: now } : { status: 'unconfigured' as const },
    }
    managedWorkspaces.set(id, value)
    return HttpResponse.json({ value, replayed: false }, { status: 201 })
  }),
  http.patch('/api/management/workspaces/:workspaceId', async ({ params, request }) => {
    const workspaceId = String(params.workspaceId)
    const current = visibleManagedWorkspace(workspaceId)
    if (!current) return fixtureNotFound('workspace', workspaceId)
    const body = await readJson(request) as { name?: string; description?: string }
    if (body.name !== undefined) managedWorkspaceNames.set(workspaceId, body.name)
    if (body.description !== undefined) managedWorkspaceDescriptions.set(workspaceId, body.description)
    const value = { ...visibleManagedWorkspace(workspaceId)!, revision: current.revision + 1 }
    if (managedWorkspaces.has(workspaceId)) managedWorkspaces.set(workspaceId, value)
    return HttpResponse.json({ value, replayed: false })
  }),
  http.delete('/api/management/workspaces/:workspaceId', ({ params }) => {
    const workspaceId = String(params.workspaceId)
    const current = visibleManagedWorkspace(workspaceId)
    if (!current) return fixtureNotFound('workspace', workspaceId)
    managedWorkspaceArchives.add(workspaceId)
    const value = { ...visibleManagedWorkspace(workspaceId)!, revision: current.revision + 1 }
    if (managedWorkspaces.has(workspaceId)) managedWorkspaces.set(workspaceId, value)
    return HttpResponse.json({ value, replayed: false })
  }),
  http.get('/api/management/workflows/capabilities/v3', () => HttpResponse.json(CURRENT_WORKFLOW_CAPABILITIES)),
  http.get('/api/management/workspaces/:workspaceId/agents', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const fixture = getMockFixture(String(params.workspaceId))
    const items = fixture?.agents.map((agent) => ({ agent: serializeAgent(agent), metadataRevision: 1 })) ?? []
    return HttpResponse.json({ items, pageInfo: { nextCursor: null } })
  }),
  http.get('/api/management/workspaces/:workspaceId/runs', () =>
    HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })),
  http.get('/api/management/workspaces/:workspaceId', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    if (params.workspaceId === 'workspace') return HttpResponse.json({
      workspace: { id: 'workspace', name: 'Fixture', agentIds: [], workflowIds: ['workflow'],
        createdAt: '2026-09-21T00:00:00.000Z', updatedAt: '2026-09-21T00:00:00.000Z' },
      revision: 1, archivedAt: null, executionLocation: { runnerId: 'runner-local', rootPath: '/tmp/project' },
      locationRevision: 1, locationValidation: { status: 'ready', checkedAt: '2026-09-21T00:00:00.000Z' },
    })
    const result = visibleManagedWorkspace(String(params.workspaceId))
    return result ? HttpResponse.json(result) : fixtureNotFound('workspace', String(params.workspaceId))
  }),
  http.post('/api/management/workspaces/:workspaceId/location/validate', async ({ request, params }) => {
    const parsed = WorkspaceLocationValidateInputSchema.safeParse({
      workspaceId: String(params.workspaceId), ...await readJson(request) as object,
    })
    if (!parsed.success || !parsed.data.rootPath.startsWith('/')) {
      return apiError('WORKSPACE_LOCATION_NOT_ABSOLUTE', 'The workspace location must be an absolute runner path.', 400)
    }
    return HttpResponse.json({
      workspaceId: parsed.data.workspaceId,
      location: { runnerId: parsed.data.runnerId, rootPath: parsed.data.rootPath },
      accessMode: parsed.data.accessMode,
      checkedAt: new Date().toISOString(),
    })
  }),
  http.put('/api/management/workspaces/:workspaceId/location', async ({ request, params }) => {
    const parsed = WorkspaceLocationSetInputSchema.safeParse({
      workspaceId: String(params.workspaceId), ...await readJson(request) as object,
    })
    if (!parsed.success) return apiError('INVALID_REQUEST', 'The location request is invalid.', 400)
    const current = mockLocations.get(parsed.data.workspaceId)
    if ((current?.revision ?? 0) !== parsed.data.expectedLocationRevision) {
      return apiError('LOCATION_REVISION_CONFLICT', 'The workspace location changed since it was read.', 409, {
        currentLocationRevision: current?.revision ?? 0,
      })
    }
    const next = { rootPath: parsed.data.rootPath, revision: (current?.revision ?? 0) + 1 }
    mockLocations.set(parsed.data.workspaceId, next)
    const validation = {
      workspaceId: parsed.data.workspaceId,
      location: { runnerId: parsed.data.runnerId, rootPath: parsed.data.rootPath },
      accessMode: 'read-only' as const,
      checkedAt: new Date().toISOString(),
    }
    return HttpResponse.json({
      value: {
        workspaceId: parsed.data.workspaceId,
        executionLocation: validation.location,
        locationRevision: next.revision,
        validation,
      },
      replayed: false,
    })
  }),
  http.post('/api/workspaces/:workspaceId/workflows/:workflowId/runs', () =>
    apiError('EXECUTION_SEMANTICS_UNSUPPORTED', 'Use the current authenticated managed Start service.', 409)),
  http.get('/api/workspaces/:workspaceId/runs/:runId', ({ params }) => HttpResponse.json({
    run: {
      ...mockStartedRun,
      id: String(params.runId),
      workspaceId: String(params.workspaceId),
    },
    executions: [],
    activity: [],
  })),

  http.get('/api/workspaces/:workspaceId', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    if (!fixture) return fixtureNotFound('workspace', workspaceId)
    return HttpResponse.json({
      workspace: fixture.workspace,
      agents: (currentAuthoringMocks.get(workspaceId)?.agents ?? fixture.agents).map(serializeAgent),
      workflows: fixture.workflows.filter((graph) => {
        const service = currentAuthoringMocks.get(workspaceId)
        return !service?.workflows.has(graph.id) || !service.managed(graph.id).archivedAt
      }),
      runs: fixture.runs,
      resources: fixture.resources,
      browserProfiles: fixture.browserProfiles,
      runners: fixture.runners,
    })
  }),
  http.get('/api/workspaces/:workspaceId/agents', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    if (!fixture) return fixtureNotFound('workspace', workspaceId)
    return HttpResponse.json({ agents: (currentAuthoringMocks.get(workspaceId)?.agents ?? fixture.agents).map(serializeAgent) })
  }),
  http.get('/api/workspaces/:workspaceId/workflows/:workflowId', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    if (!fixture) return fixtureNotFound('workspace', workspaceId)
    const workflow = fixture.workflows.find((item) => item.id === String(params.workflowId))
    return workflow ? HttpResponse.json({ workflow }) : fixtureNotFound('workflow', String(params.workflowId))
  }),
  http.put('/api/workspaces/:workspaceId/workflows/:workflowId', () =>
    apiError('EXECUTION_SEMANTICS_UNSUPPORTED', 'Use the current V3 draft/save service.', 409)),
  http.put('/api/workspaces/:workspaceId/graph', () =>
    apiError('EXECUTION_SEMANTICS_UNSUPPORTED', 'Use the current V3 draft/save service.', 409)),
  http.get('/api/workspaces/:workspaceId/resources', ({ params }) => {
    const failure = readFailure()
    if (failure) return failure
    const workspaceId = String(params.workspaceId)
    const fixture = getMockFixture(workspaceId)
    if (!fixture) return fixtureNotFound('workspace', workspaceId)
    return HttpResponse.json({
      resources: fixture.resources,
      browserProfiles: fixture.browserProfiles,
      runners: fixture.runners,
    })
  }),
]

export type { WorkflowDefinition }
