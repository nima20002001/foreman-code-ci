import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type RunNodeLiveActivity } from '@foreman-code/contracts'
import { type CurrentRunDetails as GetRunResponse } from '@foreman-code/contracts/wave25'
import type { NodeProps } from '@xyflow/react'
import { describe, expect, it, vi } from 'vitest'
import { AgentNode } from './GraphElements'
import { GraphPresentationProvider } from './GraphPresentation'
import { GraphRuntimeProvider } from './GraphRuntime'
import { useGraphPresentationStore } from './useGraphPresentation'
import type { GraphPresentationState, GraphPresentationStore } from './presentationStore'
import { createGraphTopologyProjector } from './topology'
import { makeScaleGraph, makeSyntheticRun } from './fixtures/scaleData'
import type { AgentGraphNode } from './types'
import type { GraphRuntimeScope } from './runtimeIndex'
import { queryKeys } from '../../shared/api/query'
import { shareRunResponseOrSelection } from '../../shared/api/runLiveCache'

// These tests exercise the actual node, Query cache, selectors and presentation
// store. Only geometry/handle widgets are omitted; this is not a browser profile.
vi.mock('@xyflow/react', async () => ({
  ...await vi.importActual<typeof import('@xyflow/react')>('@xyflow/react'),
  Handle: () => null, NodeResizer: () => null,
}))

const scope: GraphRuntimeScope = { workspaceId: 'synthetic-workspace', workflowId: 'synthetic-workflow',
  runId: 'synthetic-run', workflowVersionId: 'synthetic-version', overlayAllowed: true }
const key = queryKeys.run(scope.workspaceId, scope.runId!)
const source = makeScaleGraph(1)
const topology = createGraphTopologyProjector()(source.workflow, source.agents)
const props = { id: 'synthetic-node-0', type: 'agent', data: nativeNode(topology.nodes[0]).data,
  selected: false, isConnectable: false, dragging: false, draggable: false, selectable: true,
  deletable: false, zIndex: 0, positionAbsoluteX: 0, positionAbsoluteY: 0 } as NodeProps<AgentGraphNode>

function Capture({ capture }: { capture: (store: GraphPresentationStore) => void }) {
  capture(useGraphPresentationStore())
  return null
}

function mount(response?: GetRunResponse, data = props.data, initialScope: GraphRuntimeScope = scope) {
  const client = new QueryClient({ defaultOptions: { queries: {
    retry: false, gcTime: Infinity, structuralSharing: shareRunResponseOrSelection,
  } } })
  if (response) client.setQueryData(key, response)
  let store!: GraphPresentationStore
  const view = (runtimeScope: GraphRuntimeScope) => <QueryClientProvider client={client}>
    <GraphPresentationProvider><Capture capture={(value) => { store = value }} />
      <GraphRuntimeProvider scope={runtimeScope}><AgentNode {...props} data={data} /></GraphRuntimeProvider>
    </GraphPresentationProvider>
  </QueryClientProvider>
  const mounted = render(view(initialScope))
  return { client, get store() { return store }, rerenderScope: (value: GraphRuntimeScope) => mounted.rerender(view(value)),
    dispose: () => { mounted.unmount(); client.clear() } }
}

function expectUnavailable() {
  const node = screen.getByTestId('agent-node-synthetic-agent-0')
  expect(node).toHaveAttribute('data-execution-state', 'unavailable')
  expect(node).toHaveAttribute('data-run-state', 'unavailable')
  expect(node).toHaveAttribute('data-live-event', '')
  expect(node).not.toHaveClass('workflow-agent-node-active')
  expect(screen.getByRole('button', { name: /Worker 1 agent, Step 1, Activity unavailable/ })).toBeVisible()
  expect(node).not.toHaveTextContent(/Idle|Succeeded|Failed|Working|Reviewing/)
}

describe('mounted frontend truth boundary', () => {
  it.each(['unknown', 'disconnected', 'interrupted', 'uncertain', 'future-state'])(
    'presents an unsupported node value %s as unavailable, not idle or an outcome', (state) => {
      const response = makeSyntheticRun(1)
      Object.assign(response.liveActivity!.nodes[0], { state })
      const app = mount(response)
      try { expectUnavailable() } finally { app.dispose() }
    },
  )

  it.each(['unknown', 'disconnected', 'interrupted', 'uncertain', 'completed'])(
    'presents %s Run facts without converting absent live telemetry to idle', (executionState) => {
      const response = makeSyntheticRun(1)
      Object.assign(response.run, { executionState })
      const app = mount(response)
      try { expectUnavailable() } finally { app.dispose() }
    },
  )

  it('never resurrects activity carried in legacy/static mapper props', () => {
    const liveActivity: RunNodeLiveActivity = { workflowNodeId: 'synthetic-node-0', agentId: 'synthetic-agent-0',
      state: 'working', action: { kind: 'reviewing_request', label: 'Reviewing request…' },
      event: { id: 'old-static-event', sequence: '1' } }
    const app = mount(undefined, { ...props.data, liveActivity, runActive: true },
      { ...scope, runId: undefined })
    try { expectUnavailable() } finally { app.dispose() }
  })

  it('keeps unsupported detached legacy execution facts unavailable even without a selected Run', () => {
    const app = mount(undefined, { ...props.data,
      runState: 'interrupted' as unknown as AgentGraphNode['data']['runState'] }, { ...scope, runId: undefined })
    try { expectUnavailable() } finally { app.dispose() }
  })

  it('does not interpret a detached harness connection status as workflow Idle or Working', () => {
    const app = mount(undefined, { ...props.data,
      agent: { ...props.data.agent, harnessSummary: { status: 'disconnected' } } }, { ...scope, runId: undefined })
    try { expectUnavailable() } finally { app.dispose() }
  })

  it('does not create activity or edit cues from connection health, keepalives or a fetch in flight', async () => {
    const app = mount()
    let release!: (value: GetRunResponse) => void
    try {
      expectUnavailable()
      app.rerenderScope({ ...scope, unavailable: true })
      app.rerenderScope({ ...scope, unavailable: false })
      expectUnavailable()
      let request!: Promise<GetRunResponse>
      act(() => {
        request = app.client.fetchQuery({ queryKey: key,
          queryFn: () => new Promise<GetRunResponse>((resolve) => { release = resolve }) })
      })
      expect(app.client.isFetching({ queryKey: key })).toBe(1)
      expectUnavailable()
      await act(async () => { release(makeSyntheticRun(1)); await request })
      await waitFor(() => expect(screen.getByTestId('agent-node-synthetic-agent-0'))
        .toHaveAttribute('data-execution-state', 'idle')) // Explicit S0 idle fact.
      for (const health of [{ connected: true }, { reconnecting: true }, { ping: 1 }, { keepalive: true }]) {
        act(() => app.client.setQueryData(key, { ...makeSyntheticRun(1), transport: health }))
      }
      const node = screen.getByTestId('agent-node-synthetic-agent-0')
      expect(node).toHaveAttribute('data-live-event', '')
      expect(node).not.toHaveClass('workflow-agent-node-active')
      expect(node).not.toHaveClass('workflow-agent-node-entering')
      expect(app.store.getState().enteringNodeIds.size).toBe(0)
      expect(app.store.getState().enteringEdgeId).toBeUndefined()
      expect(app.store.getState().epoch).toBe(0)
    } finally { app.dispose() }
  })

  it('keeps the same verified event through no-op polling without replaying a cue', async () => {
    const response = makeSyntheticRun(1)
    response.liveActivity!.nodes[0] = { ...response.liveActivity!.nodes[0], state: 'working',
      action: { kind: 'reading_file', label: 'Reading file…' }, event: { id: 'native-1', sequence: '1' } }
    const app = mount(response)
    try {
      const canonical = app.client.getQueryData<GetRunResponse>(key)!
      await act(async () => {
        await app.client.fetchQuery({ queryKey: key, staleTime: 0,
          queryFn: async () => ({ ...structuredClone(response), transport: { keepalive: true } }) })
      })
      const after = app.client.getQueryData<GetRunResponse>(key)!
      expect(after.liveActivity!.nodes[0]).toBe(canonical.liveActivity!.nodes[0])
      expect(after.run).toBe(canonical.run)
      expect(screen.getByTestId('agent-node-synthetic-agent-0')).toHaveAttribute('data-live-event', 'native-1')
      expect(app.store.getState().enteringNodeIds.size).toBe(0)
      expect(app.store.getState().enteringEdgeId).toBeUndefined()
    } finally { app.dispose() }
  })

  it('does not let stale success or active data visually overwrite newer Stop/terminal facts', async () => {
    const stopped = makeSyntheticRun(1, '20')
    stopped.run.executionState = 'interrupted'
    stopped.cleanupPending = true
    stopped.liveActivity!.active = false
    const app = mount(stopped)
    try {
      expectUnavailable()
      const olderCompletion = makeSyntheticRun(1, '19')
      olderCompletion.run.executionState = 'completed'
      olderCompletion.run.outcome = 'succeeded'
      olderCompletion.liveActivity!.active = false
      const staleWorking = makeSyntheticRun(1, '18')
      staleWorking.liveActivity!.nodes[0] = { ...staleWorking.liveActivity!.nodes[0], state: 'working',
        action: null, event: { id: 'stale', sequence: '18' } }
      await act(async () => {
        app.client.setQueryData(key, olderCompletion)
        app.client.setQueryData(key, staleWorking)
      })
      expect(app.client.getQueryData(key)).toBe(stopped)
      expectUnavailable()
      const terminal = { ...stopped, run: { ...stopped.run, executionState: 'completed' as const, outcome: 'canceled' as const },
        cleanupPending: false, liveActivity: { ...stopped.liveActivity!, sequence: '21', eventCount: '21' } }
      await act(async () => { app.client.setQueryData(key, terminal) })
      const accepted = app.client.getQueryData(key)
      await act(async () => { app.client.setQueryData(key, staleWorking); app.client.setQueryData(key, olderCompletion) })
      expect(app.client.getQueryData(key)).toBe(accepted)
      expectUnavailable()
    } finally { app.dispose() }
  })

  it('can reset and expire presentation without advancing a fact or owning a cursor', async () => {
    const response = makeSyntheticRun(1)
    response.liveActivity!.nodes[0] = { ...response.liveActivity!.nodes[0], state: 'working',
      action: null, event: { id: 'native-1', sequence: '1' } }
    const app = mount(response)
    const snapshot = app.client.getQueryData<GetRunResponse>(key)!
    const cacheWrites = vi.spyOn(app.client, 'setQueryData')
    try {
      act(() => {
        const state = app.store.getState()
        state.setSelectedNodeIds(new Set(['synthetic-node-0']))
        state.setOpenMenuNodeId('synthetic-node-0')
        state.setFocusedNodeId('synthetic-node-0')
        state.setFocusedEdgeId('edge')
        state.setEnteringNodeIds(new Set(['synthetic-node-0']))
        state.setDepartingNodeIds(new Set(['other-node']))
        state.setEnteringEdgeId('edge')
      })
      // A cue expiry uses exactly the same disposable action. No semantic timer
      // is created by this test or by the store.
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(() => { app.store.getState().resetPresentation(); resolve() }, 0))
      })
      fireEvent.focus(screen.getByRole('button', { name: /Worker 1 agent/ }))
      expect(app.client.getQueryData(key)).toBe(snapshot)
      expect(snapshot.liveActivity!.sequence).toBe('1')
      expect(snapshot.run.executionState).toBe('running')
      expect(cacheWrites).not.toHaveBeenCalled()
      expect(screen.getByTestId('agent-node-synthetic-agent-0')).toHaveAttribute('data-live-event', 'native-1')
      const noAuthorityFields: Extract<keyof GraphPresentationState,
        'run' | 'workflow' | 'executionState' | 'lifecycle' | 'cursor' | 'appliedCursor' | 'sequence'> extends never ? true : false = true
      expect(noAuthorityFields).toBe(true)
      for (const name of ['run', 'workflow', 'executionState', 'lifecycle', 'cursor', 'appliedCursor', 'sequence']) {
        expect(app.store.getState()).not.toHaveProperty(name)
      }
    } finally { cacheWrites.mockRestore(); app.dispose() }
  })
  it('remounts a fresh presentation store without replaying a cached runtime event', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } })
    const response = makeSyntheticRun(1)
    response.liveActivity!.nodes[0] = { ...response.liveActivity!.nodes[0], state: 'working',
      action: null, event: { id: 'native-1', sequence: '1' } }
    client.setQueryData(key, response)
    let store!: GraphPresentationStore
    const view = <QueryClientProvider client={client}><GraphPresentationProvider>
      <Capture capture={(value) => { store = value }} />
      <GraphRuntimeProvider scope={scope}><AgentNode {...props} /></GraphRuntimeProvider>
    </GraphPresentationProvider></QueryClientProvider>
    const first = render(view)
    const oldStore = store
    act(() => oldStore.getState().setEnteringNodeIds(new Set(['synthetic-node-0'])))
    first.unmount()
    const second = render(view)
    try {
      expect(store).not.toBe(oldStore)
      expect(store.getState().enteringNodeIds.size).toBe(0)
      expect(store.getState().epoch).toBe(0)
      expect(client.getQueryData(key)).toBe(response)
      const node = screen.getByTestId('agent-node-synthetic-agent-0')
      expect(node).toHaveAttribute('data-live-event', 'native-1')
      expect(node).not.toHaveClass('workflow-agent-node-entering')
    } finally { second.unmount(); client.clear() }
  })

})
