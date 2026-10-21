import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
import { vi } from 'vitest'
import { ApiClient } from '../../shared/api/client'
import { createCurrentBoardMock } from '../../shared/mocks/currentBoard'
import { currentWorkflowFixture } from '../../shared/mocks/currentWorkflow'
import { createNextDraftApi } from '../graph/nextDraft/transport'
import type { DraftRequest } from '../graph/nextDraft/state'
import { savedPlacementFixture as placement } from './fixtures'

function harness() {
  const fixture = currentWorkflowFixture('placement-save')
  const mock = createCurrentBoardMock({ workspaceId: fixture.scope.workspaceId, initialWorkflow: fixture.version.definition,
    agents: fixture.configurations.map((item) => ({ id: item.agentId, name: item.agentId, productRole: item.productRole,
      configurationVersionId: item.id, harness: item.harness.harness, harnessConfiguration: item.harness, prompt: item.prompt, assignedSkills: item.assignedSkills })) })
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
    const response = await mock.dispatch(new Request(new URL(String(url), 'http://localhost'), init))
    if (!response) throw new Error(`Unimplemented fixture route ${String(url)}`)
    return response
  })
  const client = new ApiClient({ fetch })
  return { fixture, mock, fetch, client, api: createNextDraftApi(client) }
}
it('Apply does not persist placement; Save and fresh server read preserve exact node pins', async () => {
  const { fixture, fetch, client, api } = harness()
  const draft = await api.open(fixture.scope.workspaceId, fixture.scope.workflowId)
  const graph = { ...draft.graph, nodes: draft.graph.nodes.map((node, index) => index === 0 ? { ...node, placement } : node) }
  const request: DraftRequest = { kind: 'apply', executionSemanticsVersion: 3, workspaceId: draft.workspaceId,
    workflowId: draft.workflowId, draftId: draft.id, commandId: 'apply-placement', expectedRevision: draft.revision,
    operations: [{ type: 'node.replace_v3', node: graph.nodes[0]! }] }
  const before = fetch.mock.calls.length
  const applied = await api.write(request, graph)
  expect(fetch).toHaveBeenCalledTimes(before)
  const freshBeforeSave = await createNextDraftApi(client).open(draft.workspaceId, draft.workflowId)
  expect(freshBeforeSave.graph.nodes[0]).not.toHaveProperty('placement')
  await api.write({ ...request, kind: 'save', commandId: 'save-placement', expectedRevision: applied.draft.revision, operations: undefined })
  const fresh = await createNextDraftApi(client).open(draft.workspaceId, draft.workflowId)
  expect(nativeNode(fresh.graph.nodes[0])?.placement).toEqual(placement)
  expect(fresh.graph.nodes.slice(1).every((node) => !nativeNode(node).placement)).toBe(true)
})
it('placement Save keeps the original revision conflict and local selection', async () => {
  const { fixture, fetch, api } = harness()
  const draft = await api.open(fixture.scope.workspaceId, fixture.scope.workflowId)
  const graph = { ...draft.graph, nodes: draft.graph.nodes.map((node, index) => index === 0 ? { ...node, placement } : node) }
  const request: DraftRequest = { kind: 'apply', executionSemanticsVersion: 3, workspaceId: draft.workspaceId,
    workflowId: draft.workflowId, draftId: draft.id, commandId: 'apply-conflict', expectedRevision: draft.revision, operations: [] }
  const applied = await api.write(request, graph)
  const original = fetch.getMockImplementation()!
  fetch.mockImplementation(async (url, init) => String(url).endsWith('/definition') && init?.method === 'PUT'
    ? new Response(JSON.stringify({ error: { code: 'REVISION_CONFLICT', message: 'Saved Board changed' } }), { status: 409, headers: { 'Content-Type': 'application/json' } })
    : original(url, init))
  await expect(api.write({ ...request, kind: 'save', commandId: 'save-conflict', expectedRevision: applied.draft.revision, operations: undefined })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(nativeNode((await api.get(draft.workspaceId, draft.workflowId, draft.id)).graph.nodes[0])?.placement).toEqual(placement)
})
