// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { createCurrentBoardMock } from '../../shared/mocks/currentBoard'
import { server } from '../../mocks/server'
import { fixture } from '../graph/nextDraft/core.cases'
import { nextDraftKey } from '../graph/nextDraft/state'
import { useGraphDraftStore } from '../graph/store'
import { installFlowLayout } from '../run-board/testFlowLayout'
import { installBoardTestLifecycle, mountMeasuredBoard } from './eng05D.testSupport'

installBoardTestLifecycle()

function boardFixture(suffix: string) {
  const context = fixture(['coder', 'coder', 'coder', 'coder', 'coder'])
  const graph = { ...context.draft.graph, workspaceId: `workspace-${suffix}`,
    nodes: context.draft.graph.nodes.slice(0, 4).map((node, index) => ({
      ...node, position: { x: 320, y: index * 300 },
    })), edges: context.draft.graph.edges.slice(0, 3) }
  const mock = createCurrentBoardMock({ workspaceId: graph.workspaceId,
    agents: context.agents.map((item) => item.agent), initialWorkflow: graph })
  server.use(...mock.handlers)
  return { mock, graph, href: `/workspaces/${graph.workspaceId}?workflowId=${graph.id}` }
}

async function boardShown() {
  // Role queries check styles and ancestors for every candidate and rerun on every DOM mutation.
  // Keep that work out of retries while the Board mounts: React Flow shows a node once it is measured.
  await waitFor(() => expect(document.querySelector<HTMLElement>('.react-flow__node[data-id="node-3"]')
    ?.style.visibility).toBe('visible'))
  await screen.findByRole('button', { name: /^Node 3, / })
}

function placed(id: string) {
  const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(node.style.transform)!
  return { x: Number(match[1]), y: Number(match[2]) }
}

function expectHierarchy() {
  const entry = placed('node-0')
  const children = ['node-1', 'node-2', 'node-3'].map(placed)
  expect(new Set(children.map((point) => point.y)).size).toBe(1)
  expect(new Set(children.map((point) => point.x)).size).toBe(3)
  expect(children[0]!.y).toBeGreaterThan(entry.y)
}

it('renders a legacy workflow with stacked saved positions as a hierarchy without saving it', async () => {
  const { mock, graph, href } = boardFixture('legacy-positions')
  await mountMeasuredBoard(href)
  await boardShown()
  expectHierarchy()
  expect(mock.workflows.get(graph.id)!.nodes).toEqual(graph.nodes)
  expect(mock.calls.filter((call) => call.method !== 'GET')).toEqual([])
})

it('keeps a dragged node after reload while the other nodes stay in the hierarchy', async () => {
  installFlowLayout(1000, 720)
  const { mock, graph, href } = boardFixture('dragged-positions')
  const mounted = await mountMeasuredBoard(href)
  await boardShown()
  const others = ['node-0', 'node-2', 'node-3'].map(placed)
  const before = placed('node-1')
  const core = document.querySelector<HTMLElement>('.react-flow__node[data-id="node-1"] .n-agent-core')!
  const view = core.ownerDocument.defaultView!
  const pointer = (type: string, x: number, y: number) => {
    const event = new view.MouseEvent(type, {
      bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1,
    })
    Object.defineProperty(event, 'view', { value: view })
    return event
  }
  act(() => { core.dispatchEvent(pointer('mousedown', 100, 100)) })
  act(() => { view.dispatchEvent(pointer('mousemove', 160, 150)) })
  act(() => { view.dispatchEvent(pointer('mousemove', 220, 200)) })
  act(() => { view.dispatchEvent(pointer('mouseup', 220, 200)) })
  const moved = placed('node-1')
  expect(moved).not.toEqual(before)
  await waitFor(() => expect(mock.workflows.get(graph.id)!.nodes[1])
    .toMatchObject({ position: { ...moved, manual: true } }))
  expect(mock.versions.size).toBe(1)
  mounted.unmount()
  mounted.cache.clear()
  act(() => useGraphDraftStore.getState().clearAllDrafts())
  await mountMeasuredBoard(href)
  await boardShown()
  expect(placed('node-1')).toEqual(moved)
  expect(['node-0', 'node-2', 'node-3'].map(placed)).toEqual(others)
  expect(placed('node-2').y).toBe(placed('node-3').y)
  expect(placed('node-2').y).toBeGreaterThan(placed('node-0').y)
  expect(placed('node-2').x).not.toBe(placed('node-3').x)
})

it('places a newly added node through the hierarchy while leaving its saved position absent', async () => {
  const { mock, graph, href } = boardFixture('added-positions')
  await mountMeasuredBoard(href)
  await boardShown()
  fireEvent.click(screen.getByRole('button', { name: 'Add agent' }))
  const worker = await within(screen.getByRole('menu', { name: 'Add agent' })).findByRole('menuitem', { name: 'Worker' })
  await waitFor(() => expect(worker).not.toHaveAttribute('aria-disabled'))
  fireEvent.click(worker)
  await screen.findByRole('button', { name: /^Worker 5, / })
  const key = nextDraftKey(mock.workspaceId, graph.id)
  const added = useGraphDraftStore.getState().nextDrafts[key]!.graph.nodes.at(-1)!
  expect(added).not.toHaveProperty('position')
  expect(placed(added.id)).not.toEqual({ x: 0, y: 0 })
  expect(placed(added.id).y).toBe(placed('node-0').y)
  expect(placed(added.id).x).not.toBe(placed('node-0').x)
  expectHierarchy()
})
