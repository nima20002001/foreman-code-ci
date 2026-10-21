import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
// @vitest-environment jsdom
import { createHash } from 'node:crypto'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { boardSearchForRun, canonicalGraphJson, RunExecutionDetailSchema, readRunInspectionKey, runInspectionKey } from '@foreman-code/contracts/wave25'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftKey } from '../graph/nextDraft/state'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import {
  boardHref, installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard, openRunDetails,
  type InspectionFixture,
} from './eng05D.testSupport'

installBoardTestLifecycle()
let fixture: InspectionFixture, serial = 0
beforeEach(async () => { fixture = await inspectionBoardFixture(`eng05d-inspect-${++serial}`) })

const pinned = () => screen.getByRole('region', { name: 'Selected Run board' })

describe('mounted historical identity and keyboard regressions', () => {
  it.each(['before', 'repeated', 'after'] as const)('keeps the %s Run’s exact configuration and result while the draft is edited', async (which) => {
    const owner = fixture.runs[which]
    const expected = fixture.mock.inspection.get(owner.run.id)!.slice().reverse().find((item) => item.detail.acceptedResult.status === 'accepted')!.detail
    const id = expected.execution.executionId, nodeId = expected.execution.workflowNodeId
    const wire = measureBoardWire(fixture.mock)
    const { cache } = await mountMeasuredBoard(boardHref(owner.scope, {
      runNodeId: nodeId, runExchangeKey: runInspectionKey({ executionId: id }),
    }))
    const inspector = await openRunDetails()
    const article = await within(inspector).findByRole('article', { name: `Execution ${id}` })
    expect(article).toHaveTextContent(nativeNode(expected.execution).agentConfigurationVersionId)
    expect(await within(article).findByLabelText(`Accepted result ${id}`)).toHaveTextContent(id)
    expect(pinned()).toHaveAttribute('data-run-id', owner.run.id)
    expect(!!within(inspector).queryByRole('combobox', { name: 'Business repetition' })).toBe(which === 'repeated')
    const key = nextDraftKey(fixture.mock.workspaceId, fixture.after.workflowId)
    await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
    const instanceId = useGraphDraftStore.getState().nextDrafts[key]!.instanceId
    const body = within(article).getByLabelText(`Accepted result ${id}`).textContent
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, initialPrompt: 'UNPUBLISHED-ENG05D-PRIVATE-DRAFT' })),
    })))
    fireEvent.click(within(inspector).getByText('Saved node configuration (this Run)'))
    expect(await within(inspector).findByLabelText(`Saved Run node ${nodeId}`)).toHaveTextContent(nativeNode(expected.execution).agentConfigurationVersionId)
    expect(within(inspector).getByLabelText(`Saved Run node ${nodeId}`)).not.toHaveTextContent('UNPUBLISHED-ENG05D-PRIVATE-DRAFT')
    expect(within(article).getByLabelText(`Accepted result ${id}`).textContent).toBe(body)
    expect(useGraphDraftStore.getState().nextDrafts[key]!.instanceId).toBe(instanceId)
    expect(cache.getQueryCache().getAll().some((query) => query.queryKey[1] === 'run-inspection')).toBe(true)
    expect(wire.writes()).toHaveLength(0)
    wire.report(`exact-${which}-version-draft-isolation`)
  }, 15_000)

  it.each([
    { exit: 'early', last: 2, outcome: 'pass' },
    { exit: 'limit', last: 3, outcome: 'issues' },
  ] as const)('renders the recorded $exit exit without inventing a next repetition or merging its technical attempts', async ({ exit, last, outcome }) => {
    const owner = fixture.runs.repeated
    const histories = fixture.repeatedExecutions.filter((item) => item.detail.execution.occurrence!.occurrenceIndex <= last)
    const final = histories.slice().reverse().find((item) => item.detail.execution.occurrence!.occurrenceIndex === last
      && item.detail.acceptedResult.status === 'accepted')!
    const result = { outcome: 'succeeded' as const, output: { text: JSON.stringify({ routing: { outcome },
      data: { latestDeliverable: { exit, occurrence: last }, remainingFindings: outcome === 'pass' ? [] : [{ id: 'remaining' }] } }) } }
    final.detail = RunExecutionDetailSchema.parse({ ...final.detail, acceptedResult: { status: 'accepted', value: result,
      digest: `sha256:${createHash('sha256').update(canonicalGraphJson(result, 64 * 1024)).digest('hex')}` } })
    fixture.mock.inspection.set(owner.run.id, histories)
    const wire = measureBoardWire(fixture.mock)
    const id = final.detail.execution.executionId
    await mountMeasuredBoard(boardHref(owner.scope, { runNodeId: fixture.second.id, runExchangeKey: runInspectionKey({ executionId: id }) }))
    const inspector = await openRunDetails()
    const article = await within(inspector).findByRole('article', { name: `Execution ${id}` })
    expect(await within(article).findByLabelText(`Accepted result ${id}`)).toHaveTextContent(outcome)
    const repetitions = within(inspector).getByRole('combobox', { name: 'Business repetition' })
    // The optional repeat block has a maximum of three in BOTH fixtures. An
    // early exit at two exposes two actual occurrences, not three planned rows.
    expect(owner.version.definition.repeat!.blocks[0]!.maxOccurrences).toBe(3)
    expect(within(repetitions).getAllByRole('option')).toHaveLength(last + 1)
    expect(within(repetitions).queryByRole('option', { name: new RegExp(`repetition ${last + 1}`) })).not.toBeInTheDocument()
    expect(within(inspector).getAllByRole('listitem')).toHaveLength(histories.length)
    expect(histories.filter((item) => item.detail.execution.occurrence!.occurrenceIndex === 2)).toHaveLength(2)
    expect(wire.writes()).toHaveLength(0)
    wire.report(`mounted-recorded-${exit}-exit`)
  }, 15000)

  it('separates attempts within one repetition and restores the exact result through Back', async () => {
    const scope = fixture.runs.repeated.scope
    const failed = fixture.repeatedExecutions[1]!.detail, accepted = fixture.repeatedExecutions[2]!.detail
    const occurrenceId = accepted.execution.occurrence!.occurrenceId
    const wire = measureBoardWire(fixture.mock)
    const { router, history } = await mountMeasuredBoard(boardHref(scope, {
      runNodeId: fixture.second.id, runExchangeKey: runInspectionKey({ occurrenceId }),
    }))
    const inspector = await openRunDetails(), user = userEvent.setup()
    const button = await within(inspector).findByRole('button', { name: new RegExp(accepted.execution.executionId) })
    button.focus(); await user.keyboard('{Enter}')
    await within(inspector).findByRole('article', { name: `Execution ${accepted.execution.executionId}` })
    expect(readRunInspectionKey(router.state.location.search.runExchangeKey)).toEqual({ occurrenceId, executionId: accepted.execution.executionId })
    const attemptOne = within(inspector).getByRole('button', { name: new RegExp(failed.execution.executionId) })
    attemptOne.focus(); await user.keyboard('{Enter}')
    const failedArticle = await within(inspector).findByRole('article', { name: `Execution ${failed.execution.executionId}` })
    expect(failedArticle).toHaveTextContent('No accepted result is recorded for this exact execution')
    expect(within(inspector).queryByLabelText(`Accepted result ${accepted.execution.executionId}`)).not.toBeInTheDocument()
    expect(within(inspector).getByRole('combobox', { name: 'Business repetition' })).toHaveValue(occurrenceId)
    await act(async () => { history.back() })
    expect(await within(inspector).findByLabelText(`Accepted result ${accepted.execution.executionId}`)).toHaveTextContent(accepted.execution.executionId)
    expect(router.state.location.pathname).toBe(`/workspaces/${scope.workspaceId}`)
    expect(screen.getAllByTestId('unified-workflow-board')).toHaveLength(1)
    expect(wire.executions().every((sample) => sample.query.get('occurrenceId') === occurrenceId)).toBe(true)
    expect(wire.writes()).toHaveLength(0)
  }, 15_000)

  it('allows keyboard entry, traversal and Escape exit, returning focus after a Run switch removes the original target', async () => {
    const wire = measureBoardWire(fixture.mock), user = userEvent.setup()
    const { router } = await mountMeasuredBoard(boardHref(fixture.runs.repeated.scope))
    const trigger = await screen.findByRole('button', { name: 'Activities' })
    trigger.focus(); await user.keyboard('{Enter}')
    const close = await screen.findByRole('button', { name: 'Close Activities' })
    close.focus(); await user.tab()
    expect(document.activeElement).not.toBe(document.body)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Close Activities' })).not.toBeInTheDocument())
    await waitFor(() => expect(trigger).toHaveFocus())
    // Open from a node that is not present in the next selected Run. The drawer
    // may trap focus while open; Escape and its named Close must always exit.
    // Activities opens from the toolbar; an agent card itself only opens its own rim panels.
    const node = await within(pinned()).findByRole('button', { name: 'Inspect Worker 1' })
    node.focus(); await user.keyboard('{Enter}')
    expect(screen.queryByRole('button', { name: 'Close Activities' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Activities' }))
    await screen.findByRole('button', { name: 'Close Activities' })
    await act(async () => { await router.navigate({ to: '/workspaces/$workspaceId', params: { workspaceId: fixture.mock.workspaceId },
      search: boardSearchForRun({}, fixture.after.workflowId, fixture.runs.after.scope) }) })
    await waitFor(() => expect(pinned()).toHaveAttribute('data-run-id', fixture.runs.after.run.id))
    await user.click(screen.getByRole('button', { name: 'Close Activities' }))
    // Stable Details survives all Run selections even if the original node's DOM does not.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Activities' })).toHaveFocus())
    expect(wire.writes()).toHaveLength(0)
  }, 15_000)
})
