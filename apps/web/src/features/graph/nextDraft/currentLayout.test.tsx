import { nativeNode } from '../../../shared/mocks/nativeFixtureTypes'
import { act, cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useGraphDraftStore } from '../store'
import { apiClient } from '../../../shared/api/client'
import { fixture } from './core.cases'
import { nextDraftKey } from './state'
import { nextDraftDirty } from './state'
import { nextDraftApi } from './transport'
import { clearCurrentLayoutJournals, useDraftLayout } from './useDraftLayout'

const key = nextDraftKey('workspace', 'workflow')
const context = fixture()
const pins = { 'agent-0': 'configuration-0', 'agent-1': 'configuration-1' }
const clients: QueryClient[] = []
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return renderHook(() => useDraftLayout(key), { wrapper: ({ children }) =>
    <QueryClientProvider client={client}>{children}</QueryClientProvider> })
}
function move(x: number, initialPrompt = 'private executable edit') {
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node, index) => index ? node : { ...node, initialPrompt, position: { x, y: 20 } }) })))
}
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); useGraphDraftStore.getState().clearAllDrafts()
  useGraphDraftStore.getState().installNextDraft(key, structuredClone(context))
  vi.stubGlobal('navigator', { ...navigator, locks: { request: async (_key: string, work: (() => Promise<unknown>) | LockOptions, claim?: (lock: { name: string }) => unknown) => typeof work === 'function' ? work() : claim!({ name: _key }) } })
  vi.spyOn(nextDraftApi, 'layoutBase').mockResolvedValue({ draft: context.draft,
    expectedAgentConfigurationVersionIds: pins })
})
afterEach(() => {
  cleanup(); clients.splice(0).forEach((client) => client.clear()); clearCurrentLayoutJournals()
  useGraphDraftStore.getState().clearAllDrafts(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
const acknowledged = { value: { workspaceId: 'workspace', workflowId: 'workflow', revision: 7,
  currentVersionId: 'workflow-version-1' }, replayed: false }
it('writes positions through current Save while keeping private executable edits and exact saved pins', async () => {
  const send = vi.spyOn(apiClient, 'request').mockResolvedValue(acknowledged)
  const { result } = mount(); move(500)
  await act(async () => { await result.current.mutateAsync() })
  expect(send).toHaveBeenCalledOnce()
  const [url, , options] = send.mock.calls[0]!
  expect(url).toBe('/api/management/workspaces/workspace/workflows/workflow/definition')
  expect(options?.method).toBe('PUT')
  expect(options?.body).toMatchObject({ expectedRevision: 7, expectedWorkflowVersionId: 'workflow-version-1',
    expectedAgentConfigurationVersionIds: pins, graph: { nodes: [{ id: 'node-0', position: { x: 500, y: 20 } }, expect.anything()] } })
  expect(JSON.stringify(options?.body)).not.toContain('private executable edit')
  const edit = useGraphDraftStore.getState().nextDrafts[key]!
  expect(nativeNode(edit.graph.nodes[0])?.initialPrompt).toBe('private executable edit')
  expect(edit.context.draft.revision).toBe(7)
  expect(nativeNode(edit.context.draft.graph.nodes[0])?.position).toEqual({ x: 500, y: 20 })
})
it('persists a size-only resize and reloads it without a semantic revision or dirty Save', async () => {
  const send = vi.spyOn(apiClient, 'request').mockResolvedValue(acknowledged)
  const { result } = mount()
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node, index) => index ? node : { ...node, width: 360, height: 280 }) })))
  await act(async () => { await result.current.mutateAsync() })
  expect(send).toHaveBeenCalledOnce()
  expect(send.mock.calls[0]![2]?.body).toMatchObject({ expectedRevision: 7,
    graph: { nodes: [{ id: 'node-0', width: 360, height: 280 }, expect.anything()] } })
  const edit = useGraphDraftStore.getState().nextDrafts[key]!
  expect(edit.context.draft.graph.nodes[0]).toMatchObject({ width: 360, height: 280 })
  expect(nextDraftDirty(edit)).toBe(false)
  act(() => useGraphDraftStore.getState().installNextDraft(key, structuredClone(edit.context), true))
  expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]).toMatchObject({ width: 360, height: 280 })
})

it('replays a lost resize response exactly before preserving a newer size and position', async () => {
  const send = vi.spyOn(apiClient, 'request').mockRejectedValueOnce(new Error('lost resize reply')).mockResolvedValue(acknowledged)
  const { result } = mount()
  const resize = (width: number, x: number) => act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
    nodes: graph.nodes.map((node, index) => index ? node : { ...node, width, height: 280, position: { x, y: 20 } }) })))
  resize(360, 100)
  await act(async () => { await expect(result.current.mutateAsync()).rejects.toThrow('lost resize reply') })
  const first = structuredClone(send.mock.calls[0]![2]?.body)
  resize(400, 120)
  await act(async () => { await result.current.mutateAsync() })
  expect(send).toHaveBeenCalledTimes(3)
  expect(send.mock.calls[1]![2]?.body).toEqual(first)
  expect(send.mock.calls[2]![2]?.body).toMatchObject({ graph: { nodes: [
    { width: 400, height: 280, position: { x: 120, y: 20 } }, expect.anything(),
  ] } })
  expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]).toMatchObject({ width: 400, height: 280 })
})
it('replays the exact command after a lost reply before sending a newer position', async () => {
  const send = vi.spyOn(apiClient, 'request').mockRejectedValueOnce(new Error('lost reply')).mockResolvedValue(acknowledged)
  const { result } = mount(); move(500)
  await act(async () => { await expect(result.current.mutateAsync()).rejects.toThrow('lost reply') })
  const first = structuredClone(send.mock.calls[0]![2]?.body)
  move(600)
  await act(async () => { await result.current.mutateAsync() })
  expect(send).toHaveBeenCalledTimes(3)
  expect(send.mock.calls[1]![2]?.body).toEqual(first)
  expect(send.mock.calls[2]![2]?.body).toMatchObject({ graph: { nodes: [{ position: { x: 600, y: 20 } }, expect.anything()] } })
})
it('does not send positions against a different saved semantic revision', async () => {
  vi.mocked(nextDraftApi.layoutBase).mockResolvedValue({ draft: { ...context.draft, revision: 8 },
    expectedAgentConfigurationVersionIds: pins })
  const send = vi.spyOn(apiClient, 'request')
  const { result } = mount(); move(500)
  await act(async () => { await expect(result.current.mutateAsync()).rejects.toThrow('saved workflow changed') })
  expect(send).not.toHaveBeenCalled()
})

it('reloads stored geometry and current labels with immutable configuration pins', async () => {
  const { ApiClient } = await import('../../../shared/api/client')
  const { createNextDraftApi } = await import('./transport')
  const { makeCurrentWorkflowFixture } = await import('@foreman-code/contracts/wave25')
  const f = makeCurrentWorkflowFixture('layout-read', 'sequential')
  const stored = { ...f.version.definition, name: 'Current saved label',
    nodes: f.version.definition.nodes.map((node) => ({ ...node, name: 'Current node name',
      position: { x: 81, y: 29 } })) }
  const send = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const path = String(url)
    const value = path.endsWith('/definition') ? { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId,
      revision: 3, currentVersionId: f.version.id, version: f.version }
      : path.endsWith(`/workflows/${f.scope.workflowId}`) ? { workflow: stored, revision: 3, currentVersionId: f.version.id, archivedAt: null }
        : { workspace: { id: f.scope.workspaceId, name: 'Workspace' }, revision: 1, archivedAt: null, executionLocation: null,
          locationRevision: 5, locationValidation: { status: 'unconfigured' } }
    return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  const base = await createNextDraftApi(new ApiClient({ fetch: send })).layoutBase(f.scope.workspaceId, f.scope.workflowId)
  expect(base.draft.graph.name).toBe('Current saved label')
  expect(base.draft.graph.nodes[0]?.name).toBe('Current node name')
  expect(nativeNode(base.draft.graph.nodes[0])?.position).toEqual({ x: 81, y: 29 })
  expect(base.expectedAgentConfigurationVersionIds).toEqual(f.version.agentConfigurationVersionIds)
  expect(send.mock.calls.some(([url]) => String(url).endsWith('/agents'))).toBe(false)
})

it('rebases only a definitively rejected drag onto newer stored geometry after a workflow revision rejection', async () => {
  const { ApiError } = await import('../../../shared/api/client')
  const send = vi.spyOn(apiClient, 'request').mockRejectedValueOnce(new ApiError({ code: 'REVISION_CONFLICT', message: 'Changed' }, 409))
    .mockResolvedValue(acknowledged)
  const { result } = mount(); move(500)
  await act(async () => { await expect(result.current.mutateAsync()).rejects.toMatchObject({ code: 'REVISION_CONFLICT' }) })
  const fresh = { ...context.draft, graph: { ...context.draft.graph, nodes: context.draft.graph.nodes.map((node, index) =>
    index === 1 ? { ...node, position: { x: 1000, y: 900 } } : node) } }
  vi.mocked(nextDraftApi.layoutBase).mockResolvedValue({ draft: fresh, expectedAgentConfigurationVersionIds: pins })
  await act(async () => { await result.current.mutateAsync() })
  expect(send).toHaveBeenCalledTimes(2)
  expect(send.mock.calls[1]![2]?.body).toMatchObject({ graph: { nodes: [
    { id: 'node-0', position: { x: 500, y: 20 } }, { id: 'node-1', position: { x: 1000, y: 900 } },
  ] } })
})
