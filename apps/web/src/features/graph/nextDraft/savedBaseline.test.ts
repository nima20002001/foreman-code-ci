import { describe, expect, it, vi } from 'vitest'
import { CURRENT_WORKFLOW_ROUTES, CurrentManagedWorkflowSchema, CurrentWorkflowReadResultSchema } from '@foreman-code/contracts/wave25'
import { ApiClient, ApiError } from '../../../shared/api/client'
import { fixture } from './core.cases'
import { discardMeaningfulChanges } from './model'
import { createNextDraftApi } from './transport'
import { createNextDraftWriter } from './writer'
import { readEditSnapshot, storeEditSnapshot } from './editIntentStorage'
import { newNextDraft, nextDraftDirty, nextDraftKey } from './state'

/** Unit boundary: a definitive PUT conflict leaves the saved server definition unchanged. */
async function rejectedSave() {
  const initial = fixture()
  const client = new ApiClient()
  const request = vi.spyOn(client, 'request')
  const graph = initial.draft.graph
  const saved = CurrentWorkflowReadResultSchema.parse({ workspaceId: graph.workspaceId, workflowId: graph.id,
    revision: 7, currentVersionId: 'workflow-version-1', version: {
      id: 'workflow-version-1', workspaceId: graph.workspaceId, workflowId: graph.id, version: graph.version,
      definition: graph, entryNodeId: graph.entryNodeId, approval: graph.approval, executionSemanticsVersion: 3,
      agentConfigurationVersionIds: Object.fromEntries(initial.agents.map(({ agent }) =>
        [agent.id, agent.configurationVersionId])),
      contentHash: `sha256:${'b'.repeat(64)}`, createdAt: initial.draft.updatedAt,
    } })
  const managed = CurrentManagedWorkflowSchema.parse({ revision: saved.revision,
    currentVersionId: saved.currentVersionId, workflow: graph, archivedAt: null })
  const savedPath = CURRENT_WORKFLOW_ROUTES.saved.replace(':workspaceId', 'workspace').replace(':workflowId', 'workflow')
  request.mockImplementation(async (path, _schema, options) => {
    if (options?.method === 'PUT') throw new ApiError({ code: 'LOCATION_REVISION_CONFLICT', message: 'Location changed.' }, 409)
    if (path === savedPath) return saved as never
    if (path.endsWith('/workflows/workflow')) return managed as never
    return { locationRevision: 1 } as never
  })
  vi.spyOn(client, 'listManagedAgents').mockResolvedValue({ items: initial.agents, pageInfo: { nextCursor: null } })
  const api = createNextDraftApi(client)
  let edit = newNextDraft(await api.context('workspace', 'workflow'), 'instance')
  edit = { ...edit, graph: { ...edit.graph, executionPolicy: { maxParallelism: 3, maxNodeExecutions: 99 },
    nodes: edit.graph.nodes.map((node) => ({ ...node, position: { x: 900, y: 800 } })) } }
  const writer = createNextDraftWriter(api, { get: () => edit, update: (_key, change) => { edit = change(edit) } }, () => undefined)
  await expect(writer.write('test', true)).rejects.toMatchObject({ code: 'LOCATION_REVISION_CONFLICT' })
  expect(edit.pending).toBeUndefined()
  expect(edit.context.draft.graph.executionPolicy?.maxParallelism).toBe(3)
  expect(nextDraftDirty(edit)).toBe(true)
  return { api, edit, initial, request }
}

describe('saved executable baseline after rejected publication', () => {
  it('Discards acknowledged local meaning and keeps independent positions', async () => {
    const { api, edit, initial } = await rejectedSave()
    const scope = nextDraftKey('workspace', 'workflow')
    storeEditSnapshot(scope, edit)
    const snapshot = readEditSnapshot(scope)!
    expect(snapshot.context.savedDraft).toEqual(edit.context.savedDraft)
    const graph = discardMeaningfulChanges(snapshot.context, snapshot.graph)
    expect(graph.executionPolicy).toEqual(initial.draft.graph.executionPolicy)
    expect(graph.nodes[0]?.position).toEqual({ x: 900, y: 800 })
    api.discardLocal('workspace', 'workflow')
    const restored = await api.context('workspace', 'workflow')
    expect(restored.draft.graph).toEqual(initial.draft.graph)
    expect(nextDraftDirty({ ...edit, graph, context: restored })).toBe(false)
  })
  it('explicit Reload replaces a cached local draft even when saved pins have not changed', async () => {
    const { api, initial } = await rejectedSave()
    expect((await api.context('workspace', 'workflow')).draft.graph.executionPolicy?.maxParallelism).toBe(3)
    const fresh = await api.context('workspace', 'workflow', undefined, true)
    expect(fresh.draft.graph).toEqual(initial.draft.graph)
    expect(fresh.draft.revision).toBe(fresh.draft.publishedRevision)
    expect((await api.context('workspace', 'workflow')).draft.graph).toEqual(initial.draft.graph)
  })
})
