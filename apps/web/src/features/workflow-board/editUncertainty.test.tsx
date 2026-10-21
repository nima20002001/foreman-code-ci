import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it } from 'vitest'
import { HttpResponse } from 'msw'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftDirty, nextDraftKey } from '../graph/nextDraft/state'
import { readEditOutbox } from '../graph/nextDraft/editIntentStorage'
import { graphEditIntentKey } from '../graph/nextDraft/useGraphEditIntent'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import {
  boardHref, installBoardTestLifecycle, intervalTick, measureBoardWire, mountMeasuredBoard, setRunState,
} from './eng05D.testSupport'

installBoardTestLifecycle()

describe('Meaningful edit versus layout and uncertain Stop-and-save', () => {
  it('retains the exact staged form after a lost advance reply and publishes only after authenticated cleanup settlement', async () => {
    const fixture = await inspectionBoardFixture('eng05d-lost-edit-reply')
    fixture.mock.controls.start = true // Explicitly opt this task-owned MSW fixture into simulated lifecycle controls.
    const scope = fixture.runs.after.scope, key = nextDraftKey(scope.workspaceId, scope.workflowId)
    setRunState(fixture, scope, 'running')
    let loseReply = true
    const advances: Array<Record<string, unknown>> = []
    const wire = measureBoardWire(fixture.mock, async (request) => {
      if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/definition/edits')) return undefined
      const body = await request.clone().json() as Record<string, unknown>
      if (body.action !== 'stop_and_save') return undefined
      advances.push(structuredClone(body))
      if (!loseReply) return undefined
      loseReply = false
      // Commit through the SAME MSW service first, then lose only its reply.
      // This is an uncertain transport outcome, not a fake cleanup receipt.
      const committed = await fixture.mock.dispatch(request)
      expect(committed?.status).toBeLessThan(300)
      return HttpResponse.json({ error: { code: 'TEST_REPLY_LOST', message: 'Stop-and-save reply was not observed' } }, { status: 503 })
    })
    const { cache } = await mountMeasuredBoard(boardHref(scope))
    const user = userEvent.setup()
    await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
    const initial = useGraphDraftStore.getState().nextDrafts[key]!
    const versionCount = fixture.mock.versions.size, runCount = fixture.mock.runs.size
    const initialVersion = initial.context.draft.baseWorkflowVersionId
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
      nodes: graph.nodes.map((node, index) => ({ ...node, position: { x: 333 + index * 300, y: -44 } })),
    })))
    expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[key]!)).toBe(false)
    expect(fixture.mock.versions.size).toBe(versionCount)
    expect(fixture.mock.controls.stopCalls).toBe(0)
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, initialPrompt: 'ENG05-D retained meaningful instructions' })),
    })))
    expect(nextDraftDirty(useGraphDraftStore.getState().nextDrafts[key]!)).toBe(true)
    // A selected Run is its saved, read-only Board (F4); the retained draft is edited and saved from the workflow.
    await user.click(await screen.findByRole('button', { name: 'Return to workflow' }))
    await user.click(await screen.findByRole('button', { name: 'Save workflow' }))
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Stop runs and save' }))
    await waitFor(() => expect(advances).toHaveLength(1))
    await waitFor(() => expect(fixture.mock.record(scope.workflowId).intent?.state).toBe('waiting'))
    // A lost reply for a pending journal is shown as unconfirmed, not as a failed save.
    await screen.findByText('Save not confirmed.')
    const retained = readEditOutbox(key)
    expect(retained).toBeDefined()
    expect(retained!.request).toMatchObject({ executionSemanticsVersion: 3,
      expectedRevision: initial.context.draft.publishedRevision, expectedWorkflowVersionId: initialVersion })
    const journal = structuredClone(retained!.request)
    const editQueryKey = graphEditIntentKey(scope.workspaceId, scope.workflowId, initial.context.draft.id)
    await act(async () => { await cache.invalidateQueries({ queryKey: editQueryKey, exact: true }) })
    await intervalTick(3000)
    expect(fixture.mock.versions.size).toBe(versionCount)
    expect(fixture.mock.runs.size).toBe(runCount)
    expect(fixture.mock.controls.stopCalls).toBe(1)
    expect(fixture.mock.runs.get(scope.runId)?.cleanupPending).toBe(true)
    expect(readEditOutbox(key)!.request).toEqual(journal)
    expect(advances).toHaveLength(1)
    expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]!).initialPrompt).toBe('ENG05-D retained meaningful instructions')

    fixture.mock.settle(scope.runId)
    await act(async () => { await cache.invalidateQueries({ queryKey: editQueryKey, exact: true }) })
    await waitFor(() => expect(fixture.mock.versions.size).toBe(versionCount + 1))
    await waitFor(() => expect(readEditOutbox(key)).toBeUndefined())
    expect(advances).toHaveLength(2)
    expect(advances[1]).toEqual(advances[0])
    expect(fixture.mock.controls.stopCalls).toBe(1)
    expect(fixture.mock.runs.size).toBe(runCount)
    expect(nativeNode(fixture.mock.versions.get(initialVersion!)!.definition.nodes[0])).not.toHaveProperty('initialPrompt')
    expect(nativeNode([...fixture.mock.versions.values()].at(-1)!.definition.nodes[0]!).initialPrompt).toBe('ENG05-D retained meaningful instructions')
    expect(wire.matching((sample) => sample.method === 'POST' && sample.path.endsWith('/runs'))).toHaveLength(0)
    wire.report('lost-stop-and-save-reply-settlement')
  }, 20000)
})
