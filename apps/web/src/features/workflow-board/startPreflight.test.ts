import { describe, expect, it, vi } from 'vitest'
import { ManagedWorkspaceSchema } from '@foreman-code/contracts/management'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { createCurrentBoardMock } from '../../shared/mocks/currentBoard'
import { fixture } from '../graph/nextDraft/core.cases'
import { savedPlacementFixture as placement } from '../node-placement/fixtures'
import { ApiClient } from '../../shared/api/client'
import { createNextDraftApi } from '../graph/nextDraft/transport'
import { newNextDraft, nextDraftDirty } from '../graph/nextDraft/state'
import { boardStartPins, createBoardPreflightClient, type BoardStartPreflight } from './startPreflight'

function metadataHarness() {
  const context = fixture()
  const graph = { ...context.draft.graph, description: 'Original description' }
  const mock = createCurrentBoardMock({ workspaceId: graph.workspaceId, initialWorkflow: graph,
    allowSimulatedStart: true, agents: context.agents.map(({ agent }) => ({ ...agent,
      harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex })) })
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
    const request = new Request(new URL(String(url), 'http://localhost'), init)
    if (new URL(request.url).pathname === '/api/management/workflows/capabilities/v3') {
      return new Response(JSON.stringify(mock.capabilities()), { headers: { 'Content-Type': 'application/json' } })
    }
    const response = await mock.dispatch(request)
    if (!response) throw new Error(`Unimplemented fixture route ${request.url}`)
    return response
  })
  const client = new ApiClient({ fetch })
  return { graph, mock, client, api: createNextDraftApi(client), preflight: createBoardPreflightClient(client) }
}

describe('Board Start after workflow metadata updates', () => {
  it.each([
    { label: 'rename', name: 'Renamed workflow' },
    { label: 'change description', description: 'Updated description' },
    { label: 'remove description', description: null },
  ])('starts the unchanged saved version after $label and reload', async ({ label, ...metadata }) => {
    const { graph, mock, client, api, preflight } = metadataHarness()
    const original = await api.context(graph.workspaceId, graph.id)
    const version = structuredClone(mock.versions.get(original.draft.baseWorkflowVersionId!)!)
    const updated = await client.updateManagedWorkflow({ workspaceId: graph.workspaceId, workflowId: graph.id,
      commandId: `metadata-${label}`, expectedRevision: original.draft.revision, ...metadata })
    const reopened = await api.context(graph.workspaceId, graph.id)
    expect(reopened.draft.graph.name).toBe(updated.value.workflow.name)
    expect(reopened.draft.graph.description).toBe(updated.value.workflow.description)
    expect(nextDraftDirty(newNextDraft(reopened, 'metadata-board'))).toBe(false)
    expect(mock.versions.get(version.id)).toEqual(version)
    expect(mock.versions.size).toBe(1)
    const facts = await preflight(reopened.draft)
    expect(boardStartPins(reopened.draft, facts)).toEqual({ workflowVersionId: version.id,
      expectedWorkflowRevision: updated.value.revision,
      expectedAgentConfigurationVersionIds: version.agentConfigurationVersionIds,
      expectedLocationRevision: facts.workspace.locationRevision })
  })

  it('still blocks an unsaved executable edit after reloading updated metadata', async () => {
    const { graph, client, api, preflight } = metadataHarness()
    const original = await api.context(graph.workspaceId, graph.id)
    await client.updateManagedWorkflow({ workspaceId: graph.workspaceId, workflowId: graph.id,
      commandId: 'metadata-rename', expectedRevision: original.draft.revision, name: 'Renamed workflow' })
    const reopened = await api.context(graph.workspaceId, graph.id)
    const facts = await preflight(reopened.draft)
    const displayed = structuredClone(reopened.draft)
    displayed.graph.executionPolicy = { ...displayed.graph.executionPolicy!, maxNodeExecutions: 99 }
    expect(() => boardStartPins(displayed, facts)).toThrow('Save or explicitly reload before Start')
  })

  it.each(['name', 'description'] as const)('blocks an unsaved workflow %s edit', async field => {
    const { graph, api, preflight } = metadataHarness()
    const opened = await api.context(graph.workspaceId, graph.id)
    const facts = await preflight(opened.draft)
    const displayed = structuredClone(opened.draft)
    displayed.graph[field] = 'Unsaved metadata'
    expect(() => boardStartPins(displayed, facts)).toThrow('Save or explicitly reload before Start')
  })
})

function savedFacts(placed: boolean) {
  const context = fixture()
  const graph = context.draft.graph
  if (placed) graph.nodes = graph.nodes.map(node => ({ ...node, placement }))
  const mock = createCurrentBoardMock({ workspaceId: graph.workspaceId, initialWorkflow: graph,
    allowSimulatedStart: true, agents: context.agents.map(({ agent }) => ({ ...agent,
      harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex })) })
  const workflow = mock.managed(graph.id)
  const displayed = mock.drafts.get(graph.id)!
  const facts: BoardStartPreflight = {
    workflow,
    workspace: ManagedWorkspaceSchema.parse({ workspace: { id: graph.workspaceId, name: 'Workspace',
      agentIds: [], workflowIds: [graph.id] }, revision: 1, archivedAt: null, locationRevision: 1,
      executionLocation: { runnerId: 'main', rootPath: '/unavailable' },
      locationValidation: { status: 'ready', checkedAt: '2026-10-01T00:00:00Z' } }),
    capabilities: mock.capabilities(),
    version: mock.versions.get(workflow.currentVersionId!)!,
  }
  facts.workspace.locationValidation = { status: 'unavailable', checkedAt: '2026-10-01T00:00:00Z',
    error: { code: 'DIRECTORY_UNAVAILABLE', message: 'The directory is unavailable.' } }
  return { displayed, facts }
}

describe('Board start location checks', () => {
  it('allows saved agent placements when the original workspace directory is unavailable', () => {
    const { displayed, facts } = savedFacts(true)
    expect(boardStartPins(displayed, facts)).toMatchObject({ workflowVersionId: facts.version!.id,
      expectedLocationRevision: facts.workspace.locationRevision })
  })

  it('requires the workspace directory for agents using ordinary Main execution', () => {
    const { displayed, facts } = savedFacts(false)
    expect(() => boardStartPins(displayed, facts)).toThrow('execution folder is unavailable')
  })

  it('requires the workspace directory when a placed workflow contains a job', () => {
    const { displayed, facts } = savedFacts(true)
    const job = { kind: 'job' as const, id: 'job-node', name: 'Build', jobDefinitionId: 'job-definition',
      jobDefinitionRevision: 1, jobDefinitionVersionId: 'job-version' }
    displayed.graph.nodes.push(job)
    facts.version!.definition.nodes.push(job)
    facts.workflow.workflow.nodes.push(job)
    expect(() => boardStartPins(displayed, facts)).toThrow('execution folder is unavailable')
  })

  it.each(['restricted', 'unconfigured'] as const)('keeps the %s workspace selection blocked even with placements', status => {
    const { displayed, facts } = savedFacts(true)
    facts.workspace.locationValidation = { status }
    facts.workspace.executionLocation = null
    expect(() => boardStartPins(displayed, facts)).toThrow('execution folder is unavailable')
  })
})
