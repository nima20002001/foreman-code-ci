// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { GraphEditStageInputV3Schema, type GraphEditStageInputV3 } from '@foreman-code/contracts/wave25'
import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftDirty } from '../graph/nextDraft/state'
import { readEditOutbox } from '../graph/nextDraft/editIntentStorage'
import { graphEditIntentKey } from '../graph/nextDraft/useGraphEditIntent'
import { savedPlacementFixture } from '../node-placement/fixtures'
import { installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard } from './eng05D.testSupport'
import { meaningfulSaveFixture } from './meaningfulSave.testSupport'
import { worktreeFixture } from './worktree.fixtures'

installBoardTestLifecycle()
type Fixture = Awaited<ReturnType<typeof recoveryFixture>>
const sharedPrefix = 'foreman/site/shared'
const correctedPrefix = 'foreman/site/coordinator'
const conflictMessage = `Worktree prefix "${sharedPrefix}" is used by Agent One on Main and Agent Two on Worker laptop. `
  + 'Place Agents using this worktree setting on one computer, or choose different branch prefixes.'
const draft = (f: Fixture) => useGraphDraftStore.getState().nextDrafts[f.key]!
const authoring = () => within(screen.getByRole('region', { name: 'Workflow authoring' }))

async function recoveryFixture() {
  const f = await meaningfulSaveFixture()
  const project = worktreeFixture(f.workspaceId)
  const path = `/api/management/workspaces/${f.workspaceId}`
  const attempts: GraphEditStageInputV3[] = []
  const reply = f.reply
  f.reply = async request => {
    const url = new URL(request.url)
    if (request.method === 'GET' && url.pathname === `${path}/source-roots`) {
      return Response.json({ items: [project.root], readiness: 'metadata-only' })
    }
    if (request.method === 'GET' && url.pathname === `${path}/root-policies`) {
      return Response.json({ workspaceId: f.workspaceId, policies: [project.location.binding],
        allowlists: [], readiness: 'metadata-only' })
    }
    if (request.method === 'POST' && url.pathname === `${path}/sources/get`) return Response.json(project.source)
    if (request.method === 'GET' && url.pathname === `${path}/repository`) return Response.json(project.ready)
    if (request.method === 'GET' && url.pathname === path) {
      return Response.json({ workspace: { id: f.workspaceId, name: 'Project', repository: project.repository },
        revision: 2, archivedAt: null, executionLocation: project.location.executionLocation, locationRevision: 1,
        locationValidation: { status: 'ready', checkedAt: project.source.approvedAt } })
    }
    if (request.method === 'POST' && url.pathname === `${f.path}/definition/edits`) {
      const payload: unknown = await request.clone().json()
      if (payload && typeof payload === 'object' && 'action' in payload && payload.action === 'stage_edits') {
        const input = GraphEditStageInputV3Schema.parse(payload)
        attempts.push(input)
        if (input.graph.defaultWorktree?.branchPrefix === sharedPrefix) {
          return Response.json({ error: { code: 'WORKTREE_COMPUTER_CONFLICT', message: conflictMessage } }, { status: 409 })
        }
      }
    }
    return reply(request)
  }
  return { ...f, project, attempts }
}

async function mount(f: Fixture) {
  measureBoardWire(f.mock, f.reply)
  const view = await mountMeasuredBoard(f.href)
  await screen.findByRole('region', { name: 'Workflow authoring' })
  await waitFor(() => expect(draft(f)).toBeDefined())
  await waitFor(() => expect(view.cache.getQueryState(graphEditIntentKey(
    f.workspaceId, f.workflowId, draft(f).context.draft.id,
  ))).toMatchObject({ status: 'success', fetchStatus: 'idle' }))
  return view
}

function arrangeConflict(f: Fixture) {
  act(() => useGraphDraftStore.getState().updateNextDraft(f.key, current => ({ ...current,
    graph: { ...current.graph, defaultWorktree: { rootBinding: f.project.rootBinding, branchPrefix: sharedPrefix },
      nodes: current.graph.nodes.map((node, index) => index === 1 ? { ...node, name: 'Agent Two',
        placement: { ...savedPlacementFixture,
          hostRef: { ...savedPlacementFixture.hostRef, mainId: f.project.source.mainId },
          source: f.project.root.source,
          rootBinding: { rootId: '20000000-0000-4000-8000-000000000002', bindingRevision: 1 } },
        worktree: { branchPrefix: sharedPrefix } } : { ...node, name: 'Agent One' }) },
  })))
}

it('unlocks a rejected worktree save, preserves edits after reopening, and saves corrected settings', async () => {
  const f = await recoveryFixture()
  const user = userEvent.setup()
  const view = await mount(f)
  const original = structuredClone(f.definition())
  arrangeConflict(f)
  const submitted = structuredClone(draft(f).graph)
  await user.click(authoring().getByRole('button', { name: 'Save workflow' }))
  await screen.findByText(conflictMessage)
  expect(f.read().intent).toBeNull()
  expect(f.requests.publications).toBe(0)
  expect(f.definition()).toEqual(original)
  await waitFor(() => expect(authoring().getByRole('button', { name: /^Worktree:/ })).toBeEnabled())
  expect(readEditOutbox(f.key)).toBeUndefined()
  expect(draft(f).graph).toEqual(submitted)

  view.unmount()
  act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
  await mount(f)
  expect(draft(f).graph).toEqual(submitted)
  await user.click(authoring().getByRole('button', { name: /^Worktree:/ }))
  const dialog = await screen.findByRole('dialog', { name: 'Default worktree' })
  const prefix = within(dialog).getByRole('textbox', { name: 'Agent branch prefix' })
  await user.clear(prefix)
  await user.type(prefix, correctedPrefix)
  await user.click(within(dialog).getByRole('button', { name: 'Apply worktree' }))
  await user.click(authoring().getByRole('button', { name: 'Save workflow' }))
  await waitFor(() => expect(nextDraftDirty(draft(f))).toBe(false))
  expect(f.attempts).toHaveLength(2)
  expect(f.attempts[1]!.commandId).not.toBe(f.attempts[0]!.commandId)
  expect(f.definition().version.definition.defaultWorktree?.branchPrefix).toBe(correctedPrefix)
  expect(nativeNode(f.definition().version.definition.nodes[1]!).worktree?.branchPrefix).toBe(sharedPrefix)
  expect(f.read().intent?.state).toBe('saved')
  expect(f.requests.publications).toBe(1)
  expect(readEditOutbox(f.key)).toBeUndefined()
  expect(f.stops.size).toBe(0)
}, 20_000)

it('discards a rejected worktree save without replaying it or losing the saved workflow', async () => {
  const f = await recoveryFixture()
  const user = userEvent.setup()
  const view = await mount(f)
  const original = structuredClone(f.definition())
  arrangeConflict(f)
  await user.click(authoring().getByRole('button', { name: 'Save workflow' }))
  await screen.findByText(conflictMessage)
  await user.click(authoring().getByRole('button', { name: 'Discard changes' }))
  const dialog = await screen.findByRole('alertdialog', { name: 'Discard your changes?' })
  await user.click(within(dialog).getByRole('button', { name: 'Discard changes' }))
  await waitFor(() => expect(nextDraftDirty(draft(f))).toBe(false))
  expect(f.attempts).toHaveLength(1)
  expect(readEditOutbox(f.key)).toBeUndefined()
  expect(f.definition()).toEqual(original)
  expect(f.read().intent).toBeNull()
  expect(f.requests.publications).toBe(0)
  expect(f.stops.size).toBe(0)
  expect(screen.queryByText(conflictMessage)).not.toBeInTheDocument()

  view.unmount()
  act(() => useGraphDraftStore.setState({ nextDrafts: {} }))
  await mount(f)
  expect(nextDraftDirty(draft(f))).toBe(false)
  expect(draft(f).graph.defaultWorktree).toBeUndefined()
  expect(readEditOutbox(f.key)).toBeUndefined()
  expect(f.definition()).toEqual(original)
}, 20_000)
