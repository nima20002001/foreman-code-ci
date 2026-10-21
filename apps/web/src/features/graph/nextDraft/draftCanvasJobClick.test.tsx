import { WorkflowDefinitionV3Schema } from '@foreman-code/contracts/wave25'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { definition } from '../../jobs/fixtures'
import { clickConnectionHandles } from '../testConnectionHandles'
import { GraphPresentationProvider } from '../GraphPresentation'
import { useGraphDraftStore } from '../store'
import { fixture } from './core.cases'
import { DraftCanvas } from './DraftCanvas'
import { attachJob } from './model'
import { nextDraftKey } from './state'

// Real React Flow node-wrapper bubbling: DraftCanvas is not stubbed.
const key = nextDraftKey('workspace', 'workflow')
const context = fixture()
const graph = attachJob(context.draft.graph, { ...definition, workspaceId: 'workspace' }, 'job-node')
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class {
    constructor(private readonly notify: ResizeObserverCallback) {}
    observe(target: Element) { queueMicrotask(() => this.notify([{ target, contentRect: target.getBoundingClientRect() } as ResizeObserverEntry], this as unknown as ResizeObserver)) }
    unobserve() {} disconnect() {}
  })
  if (!globalThis.DOMMatrixReadOnly) vi.stubGlobal('DOMMatrixReadOnly', class { m11 = 1; m22 = 1; m41 = 0; m42 = 0 })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000)
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(800)
  useGraphDraftStore.getState().installNextDraft(key, structuredClone(context)) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); useGraphDraftStore.getState().clearAllDrafts() })

function mount(canvasGraph = graph) {
  const change = vi.fn()
  render(<GraphPresentationProvider><DraftCanvas draftKey={key} graph={canvasGraph} agents={context.agents.map((item) => item.agent)} kind="execution"
    change={change} geometry={vi.fn()} pending={vi.fn()} report={vi.fn()} /></GraphPresentationProvider>)
  const job = () => screen.getByRole('button', { name: new RegExp(`${definition.name}, job`) })
  const agent = (index: number) => screen.getByRole('button', { name: new RegExp(`^Node ${index}, `) })
  const edges = () => change.mock.calls.map(([update]) => update(graph).edges.at(-1)).map((edge: { source: string; target: string }) => `${edge.source}>${edge.target}`)
  return { change, job, agent, edges }
}

it('selects Job then Agent without changing workflow connections', async () => {
  const { job, agent, change } = mount()
  fireEvent.click(job())
  fireEvent.click(agent(1))
  expect(change).not.toHaveBeenCalled()
})

it('selects Agent then Job without changing workflow connections', async () => {
  const { job, agent, change } = mount()
  fireEvent.click(agent(0))
  fireEvent.click(job())
  fireEvent.click(agent(1))
  expect(change).not.toHaveBeenCalled()
})

it('creates a connection only after the connection handles are activated', async () => {
  const { change, edges } = mount()
  clickConnectionHandles(screen.getByLabelText('Connect Node 0 to another agent'),
    screen.getByLabelText(`Connect to ${definition.name}`))
  expect(change).toHaveBeenCalledOnce()
  expect(edges()).toEqual(['node-0>job-node'])
})

it('shows the CI server on a saved workflow Board without adding it to the graph', async () => {
  const { change } = mount()
  const server = await screen.findByRole('button', { name: /^CI server, Idle/ })
  fireEvent.click(server)
  const dialog = await screen.findByRole('dialog', { name: 'CI server' })
  expect(dialog).toHaveTextContent('No Run selected')
  expect(change).not.toHaveBeenCalled()
})

it('keeps a contract-valid ci-server Agent distinct from the presentation CI server', async () => {
  const authored = { ...graph, entryNodeId: 'ci-server',
    nodes: graph.nodes.map((node) => node.id === 'node-0' ? { ...node, id: 'ci-server' } : node),
    edges: graph.edges.map((edge) => ({ ...edge, source: edge.source === 'node-0' ? 'ci-server' : edge.source })) }
  expect(WorkflowDefinitionV3Schema.parse(authored).nodes[0]!.id).toBe('ci-server')
  const { agent, change } = mount(authored)
  const owner = await screen.findByRole('button', { name: /^Node 0, / })
  fireEvent.click(owner)
  expect(owner.closest('.react-flow__node')).toHaveClass('selected')
  expect(screen.getByLabelText('Connect Node 0 to another agent')).toBeInTheDocument()
  expect(await screen.findByLabelText('Remove handoff from Node 0 to Node 1')).toBeInTheDocument()
  fireEvent.click(await screen.findByRole('button', { name: /^CI server, Idle/ }))
  expect(await screen.findByRole('dialog', { name: 'CI server' })).toHaveTextContent('No Run selected')
  expect(owner.closest('.react-flow__node')).toHaveAttribute('data-id', 'ci-server')
  expect(agent(1)).toBeInTheDocument()
  expect(change).not.toHaveBeenCalled()
})
