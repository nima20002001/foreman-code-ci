import { AgentConfigurationVersionSchema, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { HttpResponse } from 'msw'
import { GraphEditStageInputV3Schema, GraphEditAdvanceInputV3Schema, GraphEditDiscardInputV3Schema,
  GraphEditReadResultV3Schema, RunStartV3InputSchema, ExecutableWorkflowV3Schema, sameWorkflowValue,
  type GraphEditIntentV3, type GraphEditStageInputV3, type GraphEditAdvanceInputV3 } from '@foreman-code/contracts/wave25'
import { createCurrentBoardMock } from '../../shared/mocks/currentBoard'
import { fixture } from '../graph/nextDraft/core.cases'
import { journalIntent, savedJournal } from '../graph/nextDraft/nim2644Journal.fixture'
import { nextDraftKey } from '../graph/nextDraft/state'

const copy = <T,>(value: T): T => structuredClone(value)
const failure = (code: string, status = 409) => HttpResponse.json({ error: { code, message: code } }, { status })
let serial = 0

/** Stateful HTTP-only fault fixture. Board, routing, transport, schemas, Query,
 * local forms and outboxes remain real. This models the existing atomic edit
 * service; it does not qualify PostgreSQL transactions or native Stop. Direct
 * Agent POST/PATCH deliberately remain accepted by createCurrentBoardMock. */
export async function meaningfulSaveFixture(otherActive = false, source = fixture()) {
  const workspaceId = `ws-meaningful-save-${++serial}`, workflowId = source.draft.workflowId
  const graph = { ...source.draft.graph, workspaceId }
  const mock = createCurrentBoardMock({ workspaceId, allowSimulatedStart: true, initialWorkflow: graph,
    agents: source.agents.map(({ agent }) => ({ ...agent, harness: 'codex' as const,
      harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex, prompt: {}, assignedSkills: [] })) })
  const other = mock.install({ ...graph, id: 'shared-workflow', name: 'Other workflow sharing the Agent' }, true)
  if (otherActive) {
    const version = mock.versions.get(other.currentVersionId!)!
    const input = RunStartV3InputSchema.parse({ workspaceId, workflowId: other.workflow.id,
      executionSemanticsVersion: 3, commandId: 'fixture-start-other', workflowVersionId: version.id,
      expectedWorkflowRevision: other.revision, expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
      expectedLocationRevision: 1, input: {} })
    // Fixture setup only. No browser Start is invoked by these Save tests.
    const response = await mock.dispatch(new Request(`http://localhost/api/management/workspaces/${workspaceId}/workflows/${other.workflow.id}/runs`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }))
    if (!response?.ok) throw new Error(`Other-workflow fixture Start failed: ${await response?.text()}`)
    const detail = [...mock.runs.values()][0]!
    detail.run.executionState = 'running'
    mock.currents.get(detail.run.id)!.state.run.executionState = 'running'
  }
  mock.calls.length = 0
  const path = `/api/management/workspaces/${workspaceId}/workflows/${workflowId}`
  const initial = mock.managed(workflowId), initialVersion = mock.versions.get(initial.currentVersionId!)!
  const controls = { rejectPublish: false, loseSaveReply: false, holdSaveReply: undefined as Promise<void> | undefined }
  const requests = { stages: [] as GraphEditStageInputV3[], advances: [] as GraphEditAdvanceInputV3[], publications: 0 }
  const stops = new Set<string>()
  let intent: GraphEditIntentV3 | null = null, submitted: GraphEditStageInputV3 | undefined
  let saved: NonNullable<GraphEditIntentV3['result']> | undefined
  const read = () => GraphEditReadResultV3Schema.parse({ intent, canStop: !mock.controls.deniedStop,
    affectedSetChanged: mock.controls.affectedSetChanged,
    current: (intent?.affected ?? []).map((pin) => {
      const detail = mock.runs.get(pin.runId)!, terminal = detail.run.executionState === 'completed'
      const cleanupPending = detail.cleanupPending !== false
      return { pin, terminal, settled: terminal && !cleanupPending, outcome: detail.run.outcome,
        cleanupPending, nativePending: !terminal || cleanupPending, interactionPending: false, reviewPending: false }
    }) })
  const managed = () => saved ? { ...initial, workflow: saved.version.definition, revision: saved.revision, currentVersionId: saved.currentVersionId } : initial
  const definition = () => {
    const value = saved ?? { workspaceId, workflowId, revision: initial.revision, currentVersionId: initial.currentVersionId!, version: initialVersion }
    return { workspaceId, workflowId, revision: value.revision, currentVersionId: value.currentVersionId, version: value.version }
  }
  async function reply(request: Request): Promise<Response | undefined> {
    const url = new URL(request.url)
    if (request.method === 'PATCH' && url.pathname.startsWith(`/api/management/workspaces/${workspaceId}/agents/`)) {
      const agentId = decodeURIComponent(url.pathname.split('/').at(-1)!)
      if ([...mock.runs.values()].some(({ run }) => run.executionState !== 'completed' && agentId in run.agentConfigurationVersionIds)) {
        return failure('AGENT_BUSY')
      }
    }
    if (request.method === 'GET' && url.pathname === path) return HttpResponse.json(managed())
    if (request.method === 'GET' && url.pathname === `${path}/definition`) return HttpResponse.json(definition())
    if (request.method === 'GET' && saved && url.pathname === `${path}/versions/${saved.currentVersionId}`) return HttpResponse.json({ version: saved.version })
    if (request.method === 'PUT' && url.pathname === `${path}/definition`) {
      // An old non-staged Board would already have committed its Agent mutation.
      requests.publications++; return failure('REVISION_CONFLICT')
    }
    if (url.pathname !== `${path}/definition/edits`) return undefined
    if (request.method === 'GET') return HttpResponse.json(read())
    const body: unknown = await request.json()
    const action = (body as { action?: string }).action
    if (action === 'stage_edits') {
      const input = GraphEditStageInputV3Schema.parse(body)
      requests.stages.push(copy(input))
      if (submitted) {
        if (!sameWorkflowValue(submitted, input)) return failure('COMMAND_CONFLICT')
        return HttpResponse.json(read())
      }
      if (input.workspaceId !== workspaceId || input.workflowId !== workflowId || input.expectedRevision !== initial.revision
        || input.expectedWorkflowVersionId !== initial.currentVersionId) return failure('REVISION_CONFLICT')
      const editedAgents = new Set(input.stagedAgents?.map(({ agent }) => agent.id))
      const affected = [...mock.runs.values()].filter(({ run, cleanupPending }) =>
        (run.executionState !== 'completed' || cleanupPending !== false)
        && (run.workflowId === workflowId || Object.keys(run.agentConfigurationVersionIds).some((id) => editedAgents.has(id))))
        .map(({ run }) => ({ workspaceId, workflowId: run.workflowId, runId: run.id, workflowVersionId: run.workflowVersionId,
          executionSemanticsVersion: 3 as const, agentConfigurationVersionIds: run.agentConfigurationVersionIds }))
      submitted = copy(input)
      intent = { ...journalIntent(input, { draft: mock.drafts.get(workflowId)!, agents: mock.catalog }, affected),
        ownerPrincipalId: 'principal-current-mock' }
      return HttpResponse.json(read())
    }
    if (action === 'discard_edits') {
      const input = GraphEditDiscardInputV3Schema.parse(body)
      if (!intent || input.intentId !== intent.id || input.commandId !== intent.discardCommandId) return failure('INTENT_CONFLICT')
      if (intent.state === 'saved') return failure('ALREADY_SAVED')
      intent.state = 'discarded'; return HttpResponse.json(read())
    }
    if (action !== 'stop_and_save') return failure('INVALID_INPUT', 400)
    const input = GraphEditAdvanceInputV3Schema.parse(body)
    requests.advances.push(copy(input))
    if (!intent || input.intentId !== intent.id || input.commandId !== intent.advanceCommandId) return failure('INTENT_CONFLICT')
    if (intent.state === 'saved') return HttpResponse.json(read())
    const facts = read()
    if (facts.affectedSetChanged || !facts.canStop && facts.current.some((item) => !item.settled)) return failure('FORBIDDEN', 403)
    if (facts.current.some((item) => !item.settled)) {
      for (const item of facts.current.filter((item) => !item.settled)) {
        if (!stops.has(item.pin.runId)) { stops.add(item.pin.runId); mock.controls.stopCalls++ }
        mock.runs.get(item.pin.runId)!.cleanupPending = true
        mock.currents.get(item.pin.runId)!.state.run.stopRequested = true
      }
      intent.state = 'waiting'; return HttpResponse.json(read())
    }
    requests.publications++
    if (controls.rejectPublish) {
      intent = { ...intent, state: 'blocked', saveAttempted: true,
        error: { code: 'REVISION_CONFLICT', message: 'Publication rejected: the saved workflow revision changed.', uncertain: false } }
      return HttpResponse.json(read())
    }
    // Validate the complete publication before atomically exposing its heads.
    const completed = savedJournal(intent, initialVersion.version + 1), publication = completed.result!
    const configurations = (publication.agents ?? []).map(({ agent }) => AgentConfigurationVersionSchema.parse({
      id: agent.configurationVersionId, agentId: agent.id, workspaceId,
      version: mock.configurations.filter((item) => item.agentId === agent.id).length + 1,
      productRole: agent.productRole, harness: agent.harnessConfiguration, prompt: agent.prompt ?? {},
      assignedSkills: agent.assignedSkills ?? [], contentHash: publication.version.contentHash, createdAt: publication.version.createdAt,
    }))
    ExecutableWorkflowV3Schema.parse({ version: publication.version, configurations: [...mock.configurations, ...configurations]
      .filter((item) => publication.version.agentConfigurationVersionIds[item.agentId] === item.id) })
    for (const item of publication.agents ?? []) {
      const index = mock.catalog.findIndex(({ agent }) => agent.id === item.agent.id)
      if (index >= 0) { mock.catalog[index] = { ...item, archivedAt: null }; mock.agents[index] = item.agent }
      else { mock.catalog.push({ ...item, archivedAt: null }); mock.agents.push(item.agent) }
    }
    mock.configurations.push(...configurations)
    mock.workflows.set(workflowId, publication.version.definition); mock.versions.set(publication.currentVersionId, publication.version)
    intent = completed; saved = publication
    if (controls.holdSaveReply) await controls.holdSaveReply
    if (controls.loseSaveReply) { controls.loseSaveReply = false; return HttpResponse.error() }
    return HttpResponse.json(read())
  }
  return { mock, controls, requests, stops, read, reply, definition, workspaceId, workflowId, path,
    key: nextDraftKey(workspaceId, workflowId), href: `/workspaces/${workspaceId}?workflowId=${workflowId}` }
}
