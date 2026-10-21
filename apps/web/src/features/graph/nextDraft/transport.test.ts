import { createBoardStartClient } from '../../workflow-board/startClient'
import { describe, expect, it, vi } from 'vitest'
import { ApiClient } from '../../../shared/api/client'
import { createNextDraftApi } from './transport'
import { createCurrentBoardMock } from '../../../shared/mocks/currentBoard'
import { CurrentWorkflowSaveResultSchema } from '@foreman-code/contracts/wave25'
import { currentWorkflowFixture as makeWave25Fixture } from '../../../shared/mocks/currentWorkflow'
import type { DraftRequest } from './state'
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('workflow HTTP client boundary', () => {
  function harness() {
    const saved = makeWave25Fixture('transport')
    const mock = createCurrentBoardMock({ workspaceId: saved.scope.workspaceId, initialWorkflow: saved.version.definition,
      agents: saved.configurations.map((c) => ({ id: c.agentId, name: c.agentId, productRole: c.productRole, configurationVersionId: c.id,
        harness: c.harness.harness, harnessConfiguration: c.harness, prompt: c.prompt, assignedSkills: c.assignedSkills })) })
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async (url, init) => {
      const reply = await mock.dispatch(new Request(new URL(String(url), 'http://localhost'), init))
      if (!reply) throw new Error(`Unimplemented fixture route ${String(url)}`)
      return reply
    })
    return { saved, mock, fetch, api: createNextDraftApi(new ApiClient({ fetch })) }
  }
  it('acknowledges graph edits locally then sends the complete pinned definition without browser credentials', async () => {
    const { saved, mock, fetch, api } = harness()
    const draft = await api.open(saved.scope.workspaceId, saved.scope.workflowId)
    const target = { ...draft.graph, nodes: draft.graph.nodes.map((node) => ({ ...node, initialPrompt: 'Edited' })) }
    const request: DraftRequest = { kind: 'apply', executionSemanticsVersion: 3, workspaceId: draft.workspaceId,
      workflowId: draft.workflowId, draftId: draft.id, commandId: 'local-apply', expectedRevision: draft.revision,
      operations: target.nodes.map((node) => ({ type: 'node.replace_v3', node })) }
    const before = fetch.mock.calls.length
    const applied = await api.write(request, target)
    expect(fetch.mock.calls).toHaveLength(before)
    await api.write({ ...request, kind: 'save', commandId: 'shared-save', expectedRevision: applied.draft.revision, operations: undefined })
    const [url, init] = fetch.mock.calls.at(-1)!
    expect(String(url)).toMatch(/\/definition$/)
    expect(init!.credentials).toBe('omit')
    expect(new Headers(init!.headers).has('Authorization')).toBe(false)
    // Optional undefined form fields are absent on the JSON wire, not lost edits.
    expect(JSON.parse(String(init!.body))).toEqual({ graph: JSON.parse(JSON.stringify(target)), expectedRevision: draft.revision,
      expectedWorkflowVersionId: draft.baseWorkflowVersionId, commandId: 'shared-save', executionSemanticsVersion: 3,
      expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds })
    expect(mock.versions.size).toBe(2)
    expect(mock.calls.some((call) => call.path.includes('/drafts'))).toBe(false)
  })
  it('surfaces denied permission without alternate endpoints or credentials', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ error: { code: 'FORBIDDEN', message: 'Denied' } }, 403))
    await expect(createNextDraftApi(new ApiClient({ fetch })).open('workspace', 'workflow')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect(fetch).toHaveBeenCalledOnce()
    expect(new Headers(fetch.mock.calls[0]![1]!.headers).has('Authorization')).toBe(false)
  })
  it('reloads persisted node names on reopen and preserves them through the next layout save', async () => {
    const { saved, mock, fetch, api } = harness()
    const original = await api.context(saved.scope.workspaceId, saved.scope.workflowId)
    const graph = { ...original.draft.graph, nodes: original.draft.graph.nodes.map((node) => ({ ...node, name: 'Persisted rename' })) }
    const client = new ApiClient({ fetch })
    await client.request(`/api/management/workspaces/${saved.scope.workspaceId}/workflows/${saved.scope.workflowId}/definition`,
      CurrentWorkflowSaveResultSchema, { method: 'PUT', body: {
        commandId: 'operator-rename', executionSemanticsVersion: 3, expectedRevision: original.draft.publishedRevision,
        expectedWorkflowVersionId: original.draft.baseWorkflowVersionId,
        expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
        graph } })
    const reopened = await api.context(saved.scope.workspaceId, saved.scope.workflowId)
    expect(reopened.draft.graph.nodes.map((node) => node.name)).toEqual(graph.nodes.map((node) => node.name))
    const layout = await api.layoutBase(saved.scope.workspaceId, saved.scope.workflowId)
    const moved = { ...layout.draft.graph, nodes: layout.draft.graph.nodes.map((node, index) =>
      index ? node : { ...node, position: { x: 700, y: 80 } }) }
    await client.request(`/api/management/workspaces/${saved.scope.workspaceId}/workflows/${saved.scope.workflowId}/definition`,
      CurrentWorkflowSaveResultSchema, { method: 'PUT', body: {
        commandId: 'board-drag', executionSemanticsVersion: 3, expectedRevision: layout.draft.publishedRevision,
        expectedWorkflowVersionId: layout.draft.baseWorkflowVersionId,
        expectedAgentConfigurationVersionIds: layout.expectedAgentConfigurationVersionIds,
        graph: moved } })
    expect(mock.managed(saved.scope.workflowId).workflow.nodes).toEqual(moved.nodes)
    expect(mock.versions.size).toBe(1)
  })
  it('rejects mismatched saved revision while opening the local Board draft', async () => {
    const { saved, mock, fetch, api } = harness()
    const managed = mock.managed(saved.scope.workflowId)
    fetch.mockResolvedValueOnce(response({ ...managed, revision: managed.revision + 1 }))
    await expect(api.open(saved.scope.workspaceId, saved.scope.workflowId)).rejects.toMatchObject({ code: 'GRAPH_CHANGING' })
  })
  it('does not reinterpret unknown execution semantics as legacy or idle', async () => {
    const { saved, mock, fetch, api } = harness()
    const managed = mock.managed(saved.scope.workflowId)
    fetch.mockResolvedValueOnce(response({ ...managed, workflow: { ...managed.workflow, executionSemanticsVersion: 99 } }))
    await expect(api.open(saved.scope.workspaceId, saved.scope.workflowId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('reads the catalog between matching saved revisions before exposing role pins', async () => {
    const { saved, fetch, api } = harness()
    const result = await api.context(saved.scope.workspaceId, saved.scope.workflowId)
    expect(result.agents[0]!.agent.configurationVersionId).toBe(saved.configurations[0]!.id)
    expect(fetch.mock.calls.map(([url]) => new URL(String(url), 'http://localhost').pathname.split('/').at(-1))).toEqual([
      saved.scope.workflowId, 'definition', 'agents', saved.scope.workflowId, 'definition'])
  })
  it('starts the saved V3 version through local HTTP and rejects mismatched admission', async () => {
    const saved = makeWave25Fixture('web-start')
    const input = { workspaceId: saved.scope.workspaceId, workflowId: saved.scope.workflowId,
      workflowVersionId: saved.scope.workflowVersionId, executionSemanticsVersion: 3 as const,
      expectedWorkflowRevision: 1, expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
      expectedLocationRevision: 1, commandId: 'start-web-start', input: {} }
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response({ run: saved.run, accepted: true, replayed: false }))
    const api = createBoardStartClient(new ApiClient({ fetch }))
    expect((await api.start(input)).run.id).toBe(saved.scope.runId)
    const [url, init] = fetch.mock.calls[0]!
    expect(String(url)).toContain(`/workspaces/${saved.scope.workspaceId}/workflows/${saved.scope.workflowId}/runs`)
    expect(init!.credentials).toBe('omit')
    expect(new Headers(init!.headers).has('Authorization')).toBe(false)
    const sent = JSON.parse(String(init!.body))
    expect(sent).toEqual(input)
    expect(sent).not.toHaveProperty('draftId')
    expect(sent).not.toHaveProperty('expectedDraftRevision')
    fetch.mockResolvedValue(response({ run: { ...saved.run, workflowId: 'other-workflow' }, accepted: true, replayed: false }))
    await expect(api.start(input)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
  it('requests bounded Run pages by cursor and rejects an out-of-scope list row', async () => {
    const saved = makeWave25Fixture('web-pages')
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(async () => response({ items: [saved.run], pageInfo: { nextCursor: 'run-next' } }))
    const api = createNextDraftApi(new ApiClient({ fetch }))
    const first = await api.runs(saved.scope.workspaceId, saved.scope.workflowId)
    expect(first.pageInfo.nextCursor).toBe('run-next')
    await api.runs(saved.scope.workspaceId, saved.scope.workflowId, first.pageInfo.nextCursor)
    expect(String(fetch.mock.calls[0]![0])).toContain('limit=20')
    expect(String(fetch.mock.calls[1]![0])).toContain('cursor=run-next')
    fetch.mockResolvedValue(response({ items: [{ ...saved.run, workflowId: 'wrong' }], pageInfo: { nextCursor: null } }))
    await expect(api.runs(saved.scope.workspaceId, saved.scope.workflowId)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })
})
