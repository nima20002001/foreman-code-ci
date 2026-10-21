// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it, vi } from 'vitest'
import type { WorkflowKanbanLayout } from '@foreman-code/contracts'
import { server } from '../../../mocks/server'
import { createCurrentBoardMock } from '../../../shared/mocks/currentBoard'
import { fixture } from '../../graph/nextDraft/core.cases'
import { createMemoryBoardHandlers } from '../../memory-boards/mocks'
import { createMemoryTestPort, memoryTestCard, memoryTestIds, memoryTestTime } from '../../memory-boards/testing'
import type { MemoryChange } from '../../memory-boards/ports'
import { installFlowLayout } from '../../run-board/testFlowLayout'
import { installBoardTestLifecycle, mountMeasuredBoard } from '../eng05D.testSupport'

installBoardTestLifecycle()

class MemorySource extends EventTarget {
  static instances: MemorySource[] = []
  constructor(readonly url: string) { super(); MemorySource.instances.push(this) }
  close() {}
}

/** A two-Agent workflow Board with its memory board and a server-kept Kanban layout. */
function install(suffix: string, layout: WorkflowKanbanLayout = { visible: false, frame: null }) {
  installFlowLayout(1000, 720)
  MemorySource.instances = []
  vi.stubGlobal('EventSource', MemorySource)
  const context = fixture(['coder', 'coder'])
  const graph = { ...context.draft.graph, workspaceId: `workspace-${suffix}` }
  const mock = createCurrentBoardMock({ workspaceId: graph.workspaceId, agents: context.agents.map((item) => item.agent), initialWorkflow: graph })
  const release = memoryTestCard({ id: 'card-release', title: 'Prepare release notes', status: 'doing' })
  const docs = memoryTestCard({ id: 'card-docs', title: 'Update the docs' })
  const memory = createMemoryTestPort({ cards: [release, docs], scope: { kind: 'workflow', workspaceId: graph.workspaceId, workflowId: graph.id } })
  const stored = { layout }
  const saves: WorkflowKanbanLayout[] = []
  const path = `*/api/management/workspaces/${graph.workspaceId}/workflows/${graph.id}/kanban-layout`
  const scope = { workspaceId: graph.workspaceId, workflowId: graph.id }
  server.use(http.get(path, () => HttpResponse.json({ ...scope, layout: stored.layout })),
    http.put(path, async ({ request }) => {
      stored.layout = (await request.json() as { layout: WorkflowKanbanLayout }).layout
      saves.push(stored.layout)
      return HttpResponse.json({ ...scope, layout: stored.layout })
    }), ...mock.handlers, ...createMemoryBoardHandlers(memory.port))
  return { graph, memory, stored, saves, release, docs, href: `/workspaces/${graph.workspaceId}?workflowId=${graph.id}` }
}
const canvas = () => document.querySelector<HTMLElement>('[aria-label="Editable workflow graph"]')!
function placed(id: string) {
  const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(node.style.transform)!
  return { x: Number(match[1]), y: Number(match[2]) }
}
/** Opens the newest memory stream created after `after` earlier streams. */
async function streamOpened(after = 0) {
  let source: MemorySource | undefined
  await waitFor(() => {
    source = MemorySource.instances.slice(after).find((item) => item.url.includes(memoryTestIds.board))
    expect(source).toBeDefined()
  })
  act(() => { source!.dispatchEvent(new Event('open')) })
  return source!
}

it('adds the workflow Kanban to the Board, keeps its moved place, and only hides it on remove', async () => {
  const board = install('kanban-layout')
  const user = userEvent.setup()
  const first = await mountMeasuredBoard(board.href)
  const button = await screen.findByRole('button', { name: 'Kanban' })
  await waitFor(() => expect(button).toBeEnabled())
  expect(button).toHaveAttribute('aria-pressed', 'false')
  expect(screen.queryByRole('region', { name: 'Kanban' })).not.toBeInTheDocument()

  await user.click(button)
  const kanban = await screen.findByRole('region', { name: 'Kanban' })
  expect(canvas()).toContainElement(kanban)
  await streamOpened()
  expect(await within(kanban).findByRole('button', { name: 'Prepare release notes' })).toBeVisible()
  expect(within(within(kanban).getByRole('region', { name: 'Doing' })).getByRole('button', { name: 'Prepare release notes' })).toBeVisible()
  expect(within(within(kanban).getByRole('region', { name: 'Todo' })).getByRole('button', { name: 'Update the docs' })).toBeVisible()
  expect(board.saves).toEqual([{ visible: true, frame: null }])
  expect(button).toHaveAttribute('aria-pressed', 'true')

  // Dragged by its bar, the Kanban keeps its new place on the server.
  const before = placed('board-kanban')
  const bar = kanban.querySelector<HTMLElement>('.board-kanban-bar h2')!
  const view = bar.ownerDocument.defaultView!
  const pointer = (type: string, x: number, y: number) => {
    const event = new view.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 })
    Object.defineProperty(event, 'view', { value: view })
    return event
  }
  act(() => { bar.dispatchEvent(pointer('mousedown', 100, 100)) })
  act(() => { view.dispatchEvent(pointer('mousemove', 160, 150)) })
  act(() => { view.dispatchEvent(pointer('mousemove', 220, 200)) })
  act(() => { view.dispatchEvent(pointer('mouseup', 220, 200)) })
  const moved = placed('board-kanban')
  expect(moved).not.toEqual(before)
  await waitFor(() => expect(board.saves.at(-1)).toMatchObject({ visible: true, frame: { x: Math.round(moved.x), y: Math.round(moved.y) } }))

  // A card opens the workflow's memory board on that card.
  await user.click(within(kanban).getByRole('button', { name: 'Prepare release notes' }))
  const dialog = await screen.findByRole('dialog', { name: 'Memory board' })
  await user.click(within(dialog).getByRole('button', { name: /close memory board/i }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Memory board' })).not.toBeInTheDocument())

  await user.click(within(screen.getByRole('region', { name: 'Kanban' })).getByRole('button', { name: 'Remove Kanban from Board' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Kanban' })).not.toBeInTheDocument())
  expect(board.saves.at(-1)).toMatchObject({ visible: false, frame: { x: Math.round(moved.x), y: Math.round(moved.y) } })
  expect(board.memory.calls.filter((call) => call.method === 'mutate')).toEqual([])
  expect([...board.memory.cards.keys()].sort()).toEqual(['card-docs', 'card-release'])

  // Shown again after a reload, it comes back at the same place with the same cards.
  await user.click(screen.getByRole('button', { name: 'Kanban' }))
  await waitFor(() => expect(board.stored.layout.visible).toBe(true))
  first.unmount()
  const earlier = MemorySource.instances.length
  await mountMeasuredBoard(board.href)
  const again = await screen.findByRole('region', { name: 'Kanban' })
  expect(placed('board-kanban')).toEqual({ x: Math.round(moved.x), y: Math.round(moved.y) })
  await streamOpened(earlier)
  expect(await within(again).findByRole('button', { name: 'Update the docs' })).toBeVisible()
})

it('shows which Agent just changed a card on that card only, with a light from the Agent node', async () => {
  const board = install('kanban-activity', { visible: true, frame: { x: 700, y: 0, width: 760, height: 460 } })
  await mountMeasuredBoard(board.href)
  const kanban = await screen.findByRole('region', { name: 'Kanban' })
  const source = await streamOpened()
  await within(kanban).findByRole('button', { name: 'Prepare release notes' })
  const change = (id: string, sequence: number, cardId: string, actor: MemoryChange['actor'], subject?: boolean): MemoryChange => ({
    id, boardId: memoryTestIds.board, sequence, boardRevision: sequence, entity: 'card', entityId: cardId, entityRevision: sequence,
    actor, occurredAt: memoryTestTime, ...(subject ? { provenance: { subject: { kind: 'execution', agent: {
      workspaceId: board.graph.workspaceId, workflowId: board.graph.id, workflowNodeId: 'node-1', agentId: 'agent-1',
      productRole: 'coder', displayName: 'Agent 1', configurationVersionId: 'configuration-1' },
    execution: { runId: 'run-1', workflowVersionId: 'workflow-version-1', executionId: 'execution-1', attempt: 1 } } } } : {}),
  })
  const send = (value: MemoryChange) => act(() => { source.dispatchEvent(new MessageEvent('change', { data: JSON.stringify(value) })) })

  // A person's own edit is not announced as Agent activity.
  send(change('change-person', 5, board.docs.id, { kind: 'operator', id: 'user-fixture', displayName: 'Sam Lee' }))
  send(change('change-agent', 6, board.release.id, { kind: 'agent', id: 'agent-1', displayName: 'Agent 1' }, true))
  const updated = await within(kanban).findByText('Updated by Agent 1')
  expect(updated.closest('[data-card-id]')).toHaveAttribute('data-card-id', board.release.id)
  expect(within(kanban).getAllByText(/^Updated by /)).toHaveLength(1)
  expect(within(updated.closest<HTMLElement>('[data-card-id]')!).getByRole('button', { name: 'Prepare release notes' })).toBeVisible()
  expect(await screen.findByText('Card updated')).toBeInTheDocument()
})
