import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { installFlowLayout } from '../../run-board/testFlowLayout'
import { useChatWindowsStore } from '../../conversations/agentChat/agentChatWindows'
import { GraphPresentationProvider } from '../GraphPresentation'
import { useGraphDraftStore } from '../store'
import { fixture } from './core.cases'
import { DraftCanvas } from './DraftCanvas'
import { nextDraftKey } from './state'

const key = nextDraftKey('workspace', 'workflow')
// Three Agents with no edges between them, so every connection in these tests is made by the person.
const context = fixture(['coder', 'coder', 'coder'])
context.draft.graph.edges = []

beforeEach(() => {
  installFlowLayout(1000, 720)
  useGraphDraftStore.getState().installNextDraft(key, structuredClone(context))
})
afterEach(() => {
  cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals()
  useGraphDraftStore.getState().clearAllDrafts(); useChatWindowsStore.setState({ open: {}, frames: {}, focus: {} })
})

function mount() {
  const change = vi.fn(), geometry = vi.fn()
  render(<QueryClientProvider client={new QueryClient()}><GraphPresentationProvider><ReactFlowProvider><DraftCanvas draftKey={key} graph={context.draft.graph}
    agents={context.agents.map((item) => item.agent)} kind="execution" change={change} geometry={geometry}
    pending={vi.fn()} report={vi.fn()}
    panels={(nodeId) => ({ chat: <p>{`Chat of ${nodeId}`}</p>, chatHasHeader: false, settings: null, info: null })} /></ReactFlowProvider></GraphPresentationProvider></QueryClientProvider>)
  return { change, geometry }
}
const connected = (change: ReturnType<typeof vi.fn>): WorkflowDefinitionV3['edges'] =>
  change.mock.calls.reduce((graph: WorkflowDefinitionV3, [update]) => update(graph), context.draft.graph).edges

/** A real pointer drag from one Agent's connection port to another Agent, hit-tested on the other Agent's handle. */
function dragConnection(source: HTMLElement, target: HTMLElement) {
  const descriptor = Object.getOwnPropertyDescriptor(document, 'elementFromPoint')
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => target })
  try {
    const at = (x: number, y: number) => ({ clientX: x, clientY: y, button: 0, buttons: 1 })
    act(() => { fireEvent.mouseDown(source, at(300, 200)) })
    act(() => { fireEvent.mouseMove(document, at(400, 260)) })
    act(() => { fireEvent.mouseMove(document, at(520, 300)) })
    act(() => { fireEvent.mouseUp(document, at(520, 300)) })
  } finally {
    if (descriptor) Object.defineProperty(document, 'elementFromPoint', descriptor)
    else Reflect.deleteProperty(document, 'elementFromPoint')
  }
}
function dragNode(id: string) {
  const core = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"] .n-agent-core`)!
  const view = core.ownerDocument.defaultView!
  const pointer = (type: string, x: number, y: number) => {
    const event = new view.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 })
    Object.defineProperty(event, 'view', { value: view }) // jsdom leaves it null; d3-drag listens on it.
    return event
  }
  act(() => { core.dispatchEvent(pointer('mousedown', 100, 100)) })
  act(() => { view.dispatchEvent(pointer('mousemove', 160, 150)) })
  act(() => { view.dispatchEvent(pointer('mousemove', 220, 200)) })
  act(() => { view.dispatchEvent(pointer('mouseup', 220, 200)) })
}

it('connects one Agent to another by dragging from its connection port', async () => {
  const { change } = mount()
  const port = await screen.findByLabelText('Connect Node 0 to another agent')
  dragConnection(port, screen.getByLabelText('Connect to Node 2'))
  await waitFor(() => expect(change).toHaveBeenCalledTimes(1))
  expect(connected(change)).toEqual([expect.objectContaining({ kind: 'execution', source: 'node-0', target: 'node-2' })])
})

it('still connects Agents after one of them was dragged to a new place', async () => {
  const { change, geometry } = mount()
  await screen.findByLabelText('Connect Node 0 to another agent')
  dragNode('node-2')
  await waitFor(() => expect(geometry).toHaveBeenCalledTimes(1))
  dragConnection(screen.getByLabelText('Connect Node 0 to another agent'), screen.getByLabelText('Connect to Node 2'))
  await waitFor(() => expect(change).toHaveBeenCalledTimes(1))
  expect(connected(change)).toEqual([expect.objectContaining({ source: 'node-0', target: 'node-2' })])
})

it('does not open a chat when an Agent or its connection handle is clicked, only from the chat action', async () => {
  mount()
  const core = await screen.findByRole('button', { name: /^Node 1, / })
  fireEvent.click(core)
  fireEvent.click(screen.getByLabelText('Connect Node 1 to another agent'))
  expect(screen.queryByRole('dialog', { name: /chat$/ })).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Open Node 1 chat' }))
  const chat = await screen.findByRole('dialog', { name: 'Node 1 chat' })
  expect(chat).toHaveTextContent('Chat of node-1')
  expect(screen.queryByRole('dialog', { name: 'Node 2 chat' })).not.toBeInTheDocument()
})
