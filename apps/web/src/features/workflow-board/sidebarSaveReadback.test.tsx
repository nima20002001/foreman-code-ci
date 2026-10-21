import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse } from 'msw'
import { describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { createCurrentBoardMock } from '../../shared/mocks/currentBoard'
import { queryKeys } from '../../shared/api/query'
import { useGraphDraftStore } from '../graph/store'
import { fixture } from '../graph/nextDraft/core.cases'
import { nextDraftDirty, nextDraftKey } from '../graph/nextDraft/state'
import { graphEditIntentKey } from '../graph/nextDraft/useGraphEditIntent'
import { installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard, type ReplyOverride } from './eng05D.testSupport'

installBoardTestLifecycle()
let serial = 0
async function mount(reply?: ReplyOverride) {
  const source = fixture(), workspaceId = `sidebar-save-${++serial}`, workflowId = source.draft.workflowId
  const mock = createCurrentBoardMock({ workspaceId, agents: source.agents.map(({ agent }) => ({ ...agent,
    harness: 'codex' as const, harnessConfiguration: DEFAULT_HARNESS_DEFAULTS.codex })) })
  mock.install({ ...source.draft.graph, workspaceId, name: 'First Board' }, false)
  mock.install({ ...source.draft.graph, workspaceId, id: 'other-workflow', name: 'Other Board' }, false)
  const key = nextDraftKey(workspaceId, workflowId)
  const wire = measureBoardWire(mock, reply)
  const view = await mountMeasuredBoard(`/workspaces/${workspaceId}?workflowId=${workflowId}`)
  await screen.findByRole('region', { name: 'Workflow authoring' })
  await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
  await waitFor(() => expect(view.cache.getQueryState(graphEditIntentKey(workspaceId, workflowId,
    useGraphDraftStore.getState().nextDrafts[key]!.context.draft.id))).toMatchObject({ status: 'success', fetchStatus: 'idle' }))
  expect(await sidebar().findByRole('button', { name: /^First Board/ })).toHaveTextContent('Draft')
  return { ...view, wire, mock, key, workspaceId, workflowId }
}
const board = () => within(screen.getByRole('region', { name: 'Workflow authoring' }))
const sidebar = () => within(screen.getByRole('complementary', { name: 'Primary navigation' }))
function change(key: string, name = 'First Board') {
  act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph, name,
    nodes: graph.nodes.map((node, index) => index ? node : { ...node, initialPrompt: `${name} instructions` }) })))
}
const advance = async (request: Request) => request.method === 'POST' && new URL(request.url).pathname.endsWith('/definition/edits')
  && (await request.clone().json()).action === 'stop_and_save'

// Real registered Board + sidebar + Query caches; only HTTP and jsdom are doubled.
describe('sidebar classification after confirmed Board publication', () => {
  it('keeps Draft while saving and clears it from authoritative list readback without a reload', async () => {
    let release!: () => void, submitted = 0
    const gate = new Promise<void>((resolve) => { release = resolve })
    const f = await mount(async (request) => { if (await advance(request)) { submitted++; await gate } return undefined })
    const user = userEvent.setup()
    change(f.key, 'Published first Board')
    const reads = () => f.wire.matching((sample) => sample.method === 'GET'
      && sample.path === `/api/management/workspaces/${f.workspaceId}/workflows`).length
    const before = reads()
    const save = board().getByRole('button', { name: 'Save workflow' })
    await user.click(save)
    try {
      await waitFor(() => expect(submitted).toBe(1))
      const reconcile = board().getByRole('button', { name: 'Reconcile Save' })
      expect(reconcile).toBeDisabled()
      await user.click(reconcile)
      expect(submitted).toBe(1)
      expect(sidebar().getByRole('button', { name: /^First Board/ })).toHaveTextContent('Draft')
      expect(f.mock.managed(f.workflowId).currentVersionId).toBeNull()
      expect(reads()).toBe(before)
    } finally { release() }
    await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[f.key]!.context.draft.baseWorkflowVersionId).not.toBeNull())
    expect(await sidebar().findByRole('button', { name: 'Published first Board' })).toBeVisible()
    expect(sidebar().queryByRole('button', { name: /^First Board/ })).not.toBeInTheDocument()
    expect(sidebar().getByRole('button', { name: /^Other Board/ })).toHaveTextContent('Draft')
    expect(reads()).toBeGreaterThan(before)
    expect(f.mock.versions.size).toBe(1)
    expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[f.key]!)).toBe(false)
    expect(board().getByRole('button', { name: 'Start saved version' })).toBeVisible()
  }, 20000)

  it('keeps a failed first save classified as Draft with unsaved edits retained', async () => {
    const f = await mount(async (request) => await advance(request)
      ? HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Publication rejected.' } }, { status: 409 }) : undefined)
    change(f.key)
    await userEvent.click(board().getByRole('button', { name: 'Save workflow' }))
    await screen.findByText('The workflow changed.')
    expect(sidebar().getByRole('button', { name: /^First Board/ })).toHaveTextContent('Draft')
    expect(f.mock.managed(f.workflowId).currentVersionId).toBeNull()
    expect(f.mock.versions.size).toBe(0)
    expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[f.key]!)).toBe(true)
  }, 20000)

  it('refreshes saved classification without replacing a newer unsaved form', async () => {
    let release!: () => void, submitted = false
    const gate = new Promise<void>((resolve) => { release = resolve })
    const f = await mount(async (request) => { if (await advance(request)) { submitted = true; await gate } return undefined })
    change(f.key)
    await userEvent.click(board().getByRole('button', { name: 'Save workflow' }))
    try {
      await waitFor(() => expect(submitted).toBe(true))
      // A retained newer local form is independent of the acknowledged payload.
      act(() => useGraphDraftStore.getState().changeNextDraft(f.key, (graph) => ({ ...graph,
        nodes: graph.nodes.map((node, index) => index ? node : { ...node, initialPrompt: 'Keep the newer unsaved instructions' }) })))
    } finally { release() }
    await waitFor(() => expect(sidebar().getByRole('button', { name: /^First Board/ })).not.toHaveTextContent('Draft'))
    const edit = useGraphDraftStore.getState().nextDrafts[f.key]!
    expect(edit.graph.nodes[0]).toMatchObject({ initialPrompt: 'Keep the newer unsaved instructions' })
    expect(nextDraftDirty(edit)).toBe(true)
    expect(edit.context.draft.baseWorkflowVersionId).toBe(f.mock.managed(f.workflowId).currentVersionId)
    expect(f.mock.versions.size).toBe(1)
    expect(sidebar().getByRole('button', { name: /^Other Board/ })).toHaveTextContent('Draft')
  }, 20000)

  it('refreshes the saved head after repeated saves and retains classification across workflow navigation', async () => {
    const f = await mount(), user = userEvent.setup()
    change(f.key)
    await user.click(board().getByRole('button', { name: 'Save workflow' }))
    await waitFor(() => expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[f.key]!)).toBe(false))
    const firstVersion = f.mock.managed(f.workflowId).currentVersionId
    change(f.key, 'Second saved Board')
    await user.click(board().getByRole('button', { name: 'Save workflow' }))
    await waitFor(() => expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[f.key]!)).toBe(false))
    expect(f.mock.managed(f.workflowId).currentVersionId).not.toBe(firstVersion)
    expect(await sidebar().findByRole('button', { name: 'Second saved Board' })).toBeVisible()
    await user.click(sidebar().getByRole('button', { name: /^Other Board/ }))
    await waitFor(() => expect(f.router.state.location.search.workflowId).toBe('other-workflow'))
    await user.click(sidebar().getByRole('button', { name: 'Second saved Board' }))
    await waitFor(() => expect(f.router.state.location.search.workflowId).toBe(f.workflowId))
    expect(sidebar().getByRole('button', { name: 'Second saved Board' })).toHaveAttribute('aria-current', 'page')
    expect(sidebar().getByRole('button', { name: /^Other Board/ })).toHaveTextContent('Draft')
    expect(f.mock.versions.size).toBe(2)
    expect(f.cache.getQueryData<{ currentVersionId: string }>(queryKeys.managedWorkflow(f.workspaceId, f.workflowId))?.currentVersionId)
      .toBe(f.mock.managed(f.workflowId).currentVersionId)
  }, 20000)
})
