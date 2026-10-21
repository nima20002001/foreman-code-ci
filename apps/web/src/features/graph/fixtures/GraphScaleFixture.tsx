import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type CurrentRunDetails as GetRunResponse } from '@foreman-code/contracts/wave25'
import { GraphCanvas, type GraphCanvasHandle } from '../GraphCanvas'
import { GraphPresentationProvider } from '../GraphPresentation'
import { GraphRuntimeProvider } from '../GraphRuntime'
import { useGraphPresentationStore } from '../useGraphPresentation'
import { createGraphTopologyProjector } from '../topology'
import { applyGraphGeometry, type GraphGeometryChange } from '../geometry'
import { makeScaleGraph, makeSyntheticRun } from './scaleData'
import { queryKeys } from '../../../shared/api/query'
import { shareRunResponseOrSelection } from '../../../shared/api/runLiveCache'
import '../graph.css'

const EMPTY_DEPARTURES = { nodes: [], edges: [] }
const scope = { workspaceId: 'synthetic-workspace', workflowId: 'synthetic-workflow', runId: 'synthetic-run',
  workflowVersionId: 'synthetic-version', overlayAllowed: true }
const runKey = queryKeys.run(scope.workspaceId, scope.runId)
const noOp = () => undefined

/** Local-only, real React Flow. Not a claim of measured renderer capacity. */
export function GraphScaleFixture({ count = 300 }: { count?: number }) {
  const [client] = useState(() => {
    const cache = new QueryClient({ defaultOptions: { queries: {
      retry: false, structuralSharing: shareRunResponseOrSelection, gcTime: Infinity,
    } } })
    cache.setQueryData(runKey, makeSyntheticRun(count))
    return cache
  })
  useEffect(() => () => client.clear(), [client])
  return <QueryClientProvider client={client}><GraphPresentationProvider>
    <SyntheticCanvas count={count} client={client} />
  </GraphPresentationProvider></QueryClientProvider>
}

function SyntheticCanvas({ count, client }: { count: number; client: QueryClient }) {
  const [source, setSource] = useState(() => makeScaleGraph(count))
  const [project] = useState(() => createGraphTopologyProjector())
  const store = useGraphPresentationStore()
  const geometry = useRef<GraphCanvasHandle>(null)
  const [publishing, setPublishing] = useState(false)
  const [publications, setPublications] = useState(0)
  const [commits, setCommits] = useState(0)
  const sequence = useRef(1)
  const select = useCallback((_agentId: string, nodeId: string, additive: boolean) => {
    store.getState().setSelectedNodeIds((previous) => {
      if (!additive) return new Set([nodeId])
      const next = new Set(previous)
      if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId)
      return next
    })
  }, [store])
  const actions = useMemo(() => ({ onSelectAgent: select }), [select])
  const topology = useMemo(() => project(source.workflow, source.agents, actions), [project, source, actions])
  const commit = useCallback((changes: readonly GraphGeometryChange[]) => {
    setSource((current) => ({ ...current, workflow: applyGraphGeometry(current.workflow, changes) }))
    setCommits((current) => current + 1)
  }, [])
  const clearSelection = useCallback(() => store.getState().setSelectedNodeIds(new Set()), [store])
  const publish = useCallback(() => {
    const nextSequence = String(++sequence.current)
    client.setQueryData<GetRunResponse>(runKey, (previous) => {
      if (!previous?.liveActivity) return previous
      const node = previous.liveActivity.nodes[0]
      const working = node.state !== 'working'
      return { ...previous, liveActivity: { ...previous.liveActivity, sequence: nextSequence, eventCount: nextSequence,
        nodes: [{ ...node, state: working ? 'working' : 'idle',
          action: working ? { kind: 'reading_file', label: 'Reading synthetic file…' } : null,
          event: { id: `synthetic-event-${nextSequence}`, sequence: nextSequence } }, ...previous.liveActivity.nodes.slice(1)] } }
    })
    setPublications((current) => current + 1)
  }, [client])
  useEffect(() => {
    if (!publishing) return
    const timer = window.setInterval(publish, 1_000)
    return () => window.clearInterval(timer)
  }, [publish, publishing])

  return <main style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <header style={{ padding: 12, display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }}>
      <strong>Synthetic fixture · {count} nodes · real React Flow</strong>
      <button onClick={() => setPublishing((current) => !current)}>{publishing ? 'Pause synthetic updates' : 'Start 1 Hz synthetic updates'}</button>
      <button onClick={publish}>Change one runtime leaf</button>
      <button onClick={() => geometry.current?.flush()}>Flush geometry</button>
      <output>{publications} publications · {commits} geometry commits</output>
      <span>No API or native model calls. No profile has been recorded by this fixture.</span>
    </header>
    <section className="workflow-graph" aria-label="Synthetic scale graph">
      <div className="workflow-graph-canvas" style={{ position: 'relative', flex: 1 }}>
        <GraphRuntimeProvider scope={scope}><GraphCanvas topology={topology} departing={EMPTY_DEPARTURES}
          geometryRef={geometry} onGeometryStart={noOp} onGeometryCancel={noOp}
          onGeometryCommit={commit} onPaneClick={clearSelection} /></GraphRuntimeProvider>
      </div>
    </section>
  </main>
}
