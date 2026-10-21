import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { GraphPresentationProvider } from '../GraphPresentation'
import { useGraphDraftStore } from '../store'
import { fixture } from './core.cases'
import { DraftCanvas } from './DraftCanvas'
import { nextDraftKey } from './state'

const key = nextDraftKey('workspace', 'workflow')
const context = fixture()
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly notify: ResizeObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => this.notify([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)) }
    unobserve() {} disconnect() {}
  })
  if (!globalThis.DOMMatrixReadOnly) vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
  useGraphDraftStore.getState().installNextDraft(key, structuredClone(context))
})
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); useGraphDraftStore.getState().clearAllDrafts() })

function mount(graph = context.draft.graph) {
  render(<QueryClientProvider client={new QueryClient()}><GraphPresentationProvider><DraftCanvas draftKey={key} graph={graph} agents={context.agents.map((item) => item.agent)}
    kind="execution" change={vi.fn()} geometry={vi.fn()} pending={vi.fn()} report={vi.fn()} /></GraphPresentationProvider></QueryClientProvider>)
}

it.each([
  ['a Board with Agents', context.draft.graph],
  ['an empty Board', { ...context.draft.graph, nodes: [], edges: [] }],
])('shows the CI server on %s and explains that no Run is selected', async (_name, graph) => {
  mount(graph)
  // fireEvent: a real pointer press would start React Flow's zoom drag, which jsdom cannot host.
  fireEvent.click(await screen.findByRole('button', { name: /^CI server, .*Open CI jobs/ }))
  expect(await screen.findByText('No Run selected')).toBeVisible()
})
