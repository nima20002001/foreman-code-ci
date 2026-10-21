import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { runInspectionKey } from '@foreman-code/contracts/wave25'
import { installFlowLayout } from '../run-board/testFlowLayout'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftKey } from '../graph/nextDraft/state'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { useInspectionPresentation } from './inspect/presentation'
import { boardHref, installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard, openRunDetails } from './eng05D.testSupport'
import { eng07BoardFixture, scenarioIds } from './eng07B.testSupport'

installBoardTestLifecycle()
beforeEach(() => { installFlowLayout(1000, 720) })
let serial = 0
const inspector = () => screen.getByRole('region', { name: 'Exact execution inputs and results' })
const canvas = () => screen.getByRole('region', { name: 'Selected Run board' })
// The retained editor stays mounted but hidden while a saved Run is shown.
const editor = () => screen.getByRole('region', { name: 'Workflow authoring', hidden: true })

// The registered router, Board, React Flow, Query hooks, detail clients, schemas
// and presentation stores are real. Only HTTP and JSDOM layout APIs are fixtures.
describe('ENG07-B S3 scenarios on the one mounted Board', () => {
  it.each(scenarioIds)('%s deep-links and reopens exact pinned execution results without inventing rounds', async (id) => {
    const f = await eng07BoardFixture(id, `eng07-board-${++serial}`), wire = measureBoardWire(f.mock)
    const selected = f.at(f.scenario.executedIndexes.at(-1)!, f.scenario.occurrences)
    const execution = selected.detail.execution, executionId = execution.executionId
    const href = boardHref(f.scope, { runNodeId: execution.workflowNodeId,
      runExchangeKey: runInspectionKey({ executionId, ...(execution.occurrence ? { occurrenceId: execution.occurrence.occurrenceId } : {}) }) })
    const mounted = await mountMeasuredBoard(href), user = userEvent.setup()
    // The linked execution opens its exact accepted input and result in the shared rail.
    const rail = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    const linked = await within(rail).findByRole('article', { name: `Execution ${executionId}` })
    expect(JSON.parse(within(linked).getByLabelText(`Input ${executionId}`).textContent!)).toEqual(selected.detail.acceptedInput.value)
    expect(JSON.parse(within(linked).getByLabelText(`Accepted result ${executionId}`).textContent!)).toEqual(f.scenario.result(
      f.scenario.executedIndexes.at(-1)!, f.scenario.occurrences))
    expect(canvas()).toHaveAttribute('data-run-id', f.run.id)
    expect(within(canvas()).getAllByRole('button', { name: /^Inspect / })).toHaveLength(f.scenario.nodes.length)
    // Rounds, bindings and the saved node configuration open from the Run's Activities.
    const details = await openRunDetails()
    await user.selectOptions(within(details).getByRole('combobox', { name: 'Run node' }), execution.workflowNodeId)
    if (execution.occurrence) await user.selectOptions(within(details).getByRole('combobox', { name: 'Business repetition' }), execution.occurrence.occurrenceId)
    await user.click(await within(details).findByRole('button', { name: new RegExp(executionId) }))
    const article = await within(details).findByRole('article', { name: `Execution ${executionId}` })
    expect(JSON.parse(within(article).getByLabelText(`Input ${executionId}`).textContent!)).toEqual(selected.detail.acceptedInput.value)
    expect(within(inspector()).getByRole('combobox', { name: 'Run node' })).toHaveValue(execution.workflowNodeId)
    if (f.scenario.repeat) {
      expect(within(inspector()).getByRole('combobox', { name: 'Business repetition' })).toHaveValue(execution.occurrence!.occurrenceId)
      expect(new Set(f.rows.map((row) => row.detail.execution.occurrence!.occurrenceIndex)))
        .toEqual(new Set(id === 'S3-05-early' ? [1, 2] : [1, 2, 3]))
      const exit = f.scenario.result(1, f.scenario.occurrences).output as { text: string }
      expect(JSON.parse(exit.text).routing.outcome).toBe(id === 'S3-05-early' ? 'pass' : 'issues')
      expect(f.version.definition.repeat!.blocks[0]!.maxOccurrences).toBe(3)
    } else {
      expect(within(inspector()).queryByRole('combobox', { name: 'Business repetition' })).not.toBeInTheDocument()
      expect(selected.detail.acceptedInput.value.occurrence).toBeNull()
      expect(selected.detail.acceptedInput.value.entry).toBeNull()
      for (const row of f.rows) expect(row.detail.execution).not.toHaveProperty('occurrence')
    }
    if (id === 'S3-02' || id === 'S3-03') {
      expect(selected.detail.acceptedInput.value.predecessors).toHaveLength(2)
      if (id === 'S3-03') expect(selected.detail.acceptedInput.value.predecessors.map((source) => source.execution.workflowNodeId))
        .toEqual([nativeNode(f.scenario.nodes[1]!).id, nativeNode(f.scenario.nodes[3]!).id])
    }
    expect(wire.samples.some((sample) => sample.path.endsWith('/bindings'))).toBe(false)
    fireEvent.click(within(article).getByText('Exact predecessor/result bindings'))
    for (const binding of selected.bindings) {
      const shown = await within(article).findByLabelText(`Binding ${binding.bindingId}`)
      expect(JSON.parse(shown.textContent!)).toEqual(binding)
    }
    fireEvent.click(within(inspector()).getByText('Saved node configuration (this Run)'))
    const pinned = await within(inspector()).findByLabelText(`Saved Run node ${execution.workflowNodeId}`)
    expect(JSON.parse(pinned.textContent!).node).toEqual(f.scenario.nodes.find((node) => node.id === execution.workflowNodeId))
    expect(pinned).not.toHaveTextContent('Current directory name')
    const detailPath = `/runs/${f.run.id}/executions/${executionId}`
    expect(wire.samples.filter((sample) => sample.path.endsWith(detailPath)).map((sample) => sample.body))
      .toContainEqual(selected.detail)
    const savedHref = mounted.router.state.location.href, before = wire.samples.length
    mounted.unmount(); mounted.cache.clear()
    act(() => useInspectionPresentation.setState({ open: {} }))
    await mountMeasuredBoard(savedHref)
    const reopenedRail = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    const reopened = await within(reopenedRail).findByRole('article', { name: `Execution ${executionId}` })
    expect(JSON.parse(within(reopened).getByLabelText(`Input ${executionId}`).textContent!)).toEqual(selected.detail.acceptedInput.value)
    expect(JSON.parse(within(reopened).getByLabelText(`Accepted result ${executionId}`).textContent!)).toEqual(selected.detail.reportedResult)
    await waitFor(() => expect(wire.samples.slice(before).some((sample) => sample.path.endsWith(detailPath))).toBe(true))
    expect(wire.writes()).toEqual([])
  }, 20000)

  it('switches ordinary / repeat / ordinary saved Runs in place and never substitutes the current draft for history', async () => {
    const f = await inspectionBoardFixture(`eng07-versions-${++serial}`), wire = measureBoardWire(f.mock), user = userEvent.setup()
    const mounted = await mountMeasuredBoard(boardHref(f.runs.before.scope))
    const key = nextDraftKey(f.mock.workspaceId, f.after.workflowId)
    await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
    const board = screen.getByTestId('unified-workflow-board'), authoring = editor()
    const instanceId = useGraphDraftStore.getState().nextDrafts[key]!.instanceId
    act(() => useGraphDraftStore.getState().changeNextDraft(key, (graph) => ({ ...graph,
      nodes: graph.nodes.map((node) => ({ ...node, initialPrompt: 'Unpublished ENG07 input is not historical fact' })) })))
    await openRunDetails()
    for (const owner of [f.runs.before, f.runs.repeated, f.runs.after, f.runs.before]) {
      if (mounted.router.state.location.search.runId !== owner.run.id) {
        await user.click(await screen.findByRole('button', { name: `Open Run ${owner.run.id} · completed · succeeded` }))
      }
      await waitFor(() => expect(canvas()).toHaveAttribute('data-run-id', owner.run.id))
      expect(mounted.router.state.location.search).toMatchObject({ runId: owner.run.id, workflowVersionId: owner.version.id,
        executionSemanticsVersion: 3 })
      const repeated = owner.run.id === f.runs.repeated.run.id
      await waitFor(() => expect(!!within(inspector()).queryByRole('combobox', { name: 'Business repetition' })).toBe(repeated))
      const expected = f.mock.inspection.get(owner.run.id)!.find((row) => row.detail.acceptedResult.status === 'accepted')!
      await user.selectOptions(within(inspector()).getByRole('combobox', { name: 'Run node' }), expected.detail.execution.workflowNodeId)
      await user.click(await within(inspector()).findByRole('button', { name: new RegExp(expected.detail.execution.executionId) }))
      const article = await within(inspector()).findByRole('article', { name: `Execution ${expected.detail.execution.executionId}` })
      expect(JSON.parse(within(article).getByLabelText(`Input ${expected.detail.execution.executionId}`).textContent!)).toEqual(expected.detail.acceptedInput.value)
      if (expected.detail.acceptedResult.status !== 'accepted') throw new Error('Expected a successful historical execution')
      expect(JSON.parse(within(article).getByLabelText(`Accepted result ${expected.detail.execution.executionId}`).textContent!)).toEqual(expected.detail.acceptedResult.value)
      expect(article).not.toHaveTextContent('Unpublished ENG07 input')
      expect(screen.getByTestId('unified-workflow-board')).toBe(board)
      expect(editor()).toBe(authoring)
      expect(useGraphDraftStore.getState().nextDrafts[key]!.instanceId).toBe(instanceId)
    }
    expect(nativeNode(useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes[0]!).initialPrompt).toBe('Unpublished ENG07 input is not historical fact')
    expect(wire.writes()).toEqual([])
  }, 20000)
})
