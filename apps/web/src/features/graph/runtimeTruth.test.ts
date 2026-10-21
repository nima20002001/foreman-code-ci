import { type RunNodeLiveActivity } from '@foreman-code/contracts'
import { type CurrentRunDetails as GetRunResponse } from '@foreman-code/contracts/wave25'
import { describe, expect, it } from 'vitest'
import { makeScaleGraph, makeSyntheticRun } from './fixtures/scaleData'
import { graphRuntimeIndex, selectGraphNodeActivity } from './runtimeIndex'
import { presentGraphNodeRuntime } from './nodePresentation'
import { createGraphTopologyProjector } from './topology'
import { workflowToGraph } from './mapper'
import { shareRunResponseOrSelection } from '../../shared/api/runLiveCache'

const scope = { workspaceId: 'synthetic-workspace', workflowId: 'synthetic-workflow', runId: 'synthetic-run',
  workflowVersionId: 'synthetic-version', overlayAllowed: true }
const read = (response: unknown, index = 0) => selectGraphNodeActivity(response as GetRunResponse, scope,
  `synthetic-node-${index}`, `synthetic-agent-${index}`)
const unavailable = { state: 'unavailable', label: 'Activity unavailable', working: false, eventId: '' }

describe('S0 runtime truth narrowing', () => {
  it.each(['unknown', 'disconnected', 'interrupted', 'uncertain', 'succeeded', 'failed', 'reviewing', 'future-state'])(
    'does not invent a known node state from %s', (state) => {
      const response = makeSyntheticRun(2)
      const node = { ...response.liveActivity!.nodes[0], state }
      response.liveActivity!.nodes[0] = node as RunNodeLiveActivity
      expect(read(response)).toBeUndefined()
      expect(presentGraphNodeRuntime(node, false)).toMatchObject(unavailable)
      expect(read(response, 1)).toBe(response.liveActivity!.nodes[1])
    },
  )

  it.each(['unknown', 'disconnected', 'interrupted', 'uncertain', 'completed', 'succeeded', 'failed', 'future-state'])(
    'does not infer activity or outcome from a Run in %s', (executionState) => {
      const response = makeSyntheticRun(1)
      Object.assign(response.run, { executionState })
      expect(read(response)).toBeUndefined()
      expect(presentGraphNodeRuntime(read(response), true)).toMatchObject(unavailable)
    },
  )

  it.each([null, undefined, {}, { run: null }, { run: 'connected' }, { connected: true, ping: 1 }])(
    'handles an incomplete response without throwing or inventing work: %j', (response) => {
      expect(() => read(response)).not.toThrow()
      expect(read(response)).toBeUndefined()
    },
  )

  it.each([
    null, 'keepalive', {}, { state: 'working' },
    { state: 'working', action: null, event: null },
    { state: 'working', action: { kind: 'ping', label: 'Connected' }, event: { id: 'ping', sequence: '1' } },
    { state: 'waiting', action: { kind: 'waiting_approval', label: 123 }, event: { id: 'event', sequence: '1' } },
    { state: 'working', action: { kind: 'reading_file', label: 'x'.repeat(181) }, event: { id: 'event', sequence: '1' } },
    { state: 'working', action: null, event: { id: '', sequence: '1' } },
    { state: 'working', action: null, event: { id: 'event', sequence: 'not-a-sequence' } },
    { state: 'working', action: null, event: { id: 'event', sequence: '9223372036854775808' } },
    { state: 'idle', action: { kind: 'reading_file', label: 'Reading' }, event: null },
    { state: 'working', action: null, event: { id: 'event', sequence: '1' }, connected: true },
  ])('keeps malformed or unsupported node evidence unavailable: %j', (payload) => {
    const response = makeSyntheticRun(2)
    const node = payload && typeof payload === 'object'
      ? { workflowNodeId: 'synthetic-node-0', agentId: 'synthetic-agent-0', ...payload } : payload
    response.liveActivity!.nodes[0] = node as RunNodeLiveActivity
    expect(() => read(response)).not.toThrow()
    expect(read(response)).toBeUndefined()
    expect(presentGraphNodeRuntime(node, false)).toMatchObject(unavailable)
    expect(read(response, 1)).toBe(response.liveActivity!.nodes[1])
  })

  it.each([
    { nodes: null }, { nodes: {} }, { sequence: 'bad' }, { eventCount: 1 },
    { active: 'connected' }, { connected: true },
  ])('fails a malformed/future activity envelope closed: %j', (patch) => {
    const response = makeSyntheticRun(1)
    Object.assign(response.liveActivity!, patch)
    expect(() => read(response)).not.toThrow()
    expect(read(response)).toBeUndefined()
  })

  it('rejects ambiguous duplicate identities and evidence beyond the captured sequence', () => {
    const response = makeSyntheticRun(2)
    response.liveActivity!.nodes.push({ ...response.liveActivity!.nodes[0] })
    expect(read(response)).toBeUndefined()
    expect(read(response, 1)).toBe(response.liveActivity!.nodes[1])
    const future = makeSyntheticRun(1)
    future.liveActivity!.nodes[0] = { ...future.liveActivity!.nodes[0], state: 'working',
      action: null, event: { id: 'future-event', sequence: '2' } }
    expect(read(future)).toBeUndefined()
  })

  it('does not let a connection, poll, or reconnect establish a scoped fact', () => {
    for (const health of [{ connected: true }, { reconnecting: true }, { ping: 1 }, { keepalive: true }, { fetching: true }]) {
      const response = { ...makeSyntheticRun(1), liveActivity: undefined, transport: health }
      expect(read(response)).toBeUndefined()
      expect(selectGraphNodeActivity(response as GetRunResponse, { ...scope, unavailable: false },
        'synthetic-node-0', 'synthetic-agent-0')).toBeUndefined()
    }
  })

  it('needs a supported persisted event for work; a label or health flag is insufficient', () => {
    const node = makeSyntheticRun(1).liveActivity!.nodes[0]
    expect(presentGraphNodeRuntime({ ...node, state: 'working', action: null }, false)).toMatchObject(unavailable)
    const working = { ...node, state: 'working', action: { kind: 'reading_file', label: 'Reading file…' },
      event: { id: 'native-event-1', sequence: '1' } }
    expect(presentGraphNodeRuntime(working, false)).toMatchObject({ state: 'working', working: true, eventId: 'native-event-1' })
    expect(presentGraphNodeRuntime(working, true)).toMatchObject(unavailable)
    expect(presentGraphNodeRuntime({ ...node, state: 'idle' }, false).state).toBe('idle')
    expect(presentGraphNodeRuntime(undefined, true)).toMatchObject(unavailable)
  })

  it('localizes one malformed leaf and recovers on later valid evidence without topology projection', () => {
    const source = makeScaleGraph(300)
    let projections = 0
    const project = createGraphTopologyProjector((...args) => { projections++; return workflowToGraph(...args) })
    const topology = project(source.workflow, source.agents)
    const before = makeSyntheticRun(300)
    const incoming = makeSyntheticRun(300, '2')
    Object.assign(incoming.liveActivity!.nodes[17], { state: 'unknown' })
    const accepted = shareRunResponseOrSelection(before, incoming)
    expect(read(accepted, 17)).toBeUndefined()
    expect(graphRuntimeIndex(accepted.liveActivity!)).toBe(graphRuntimeIndex(accepted.liveActivity!))
    for (let index = 0; index < 300; index++) {
      if (index !== 17) expect(read(accepted, index)).toBe(before.liveActivity!.nodes[index])
    }
    expect(project(source.workflow, source.agents)).toBe(topology)
    expect(projections).toBe(1)
    const recovered = shareRunResponseOrSelection(accepted, makeSyntheticRun(300, '3'))
    expect(read(recovered, 17)?.state).toBe('idle') // An explicit new S0 fact, not a reconnect inference.
    expect(read(recovered, 18)).toBe(read(accepted, 18))
    expect(project(source.workflow, source.agents).edges).toBe(topology.edges)
  })
})
