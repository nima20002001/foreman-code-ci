import { WorkflowDefinitionV3Schema } from '@foreman-code/contracts/wave25'
import { fixture } from '../../graph/nextDraft/core.cases'
import { describe, expect, it } from 'vitest'
import type { CiRunJob } from '@foreman-code/contracts'
import { ciGroupStates, ciNodeActivities, ciServerSummary, ciTransfers, ciServerFlowNode } from './ciServer'

let sequence = 0
function job(nodeId: string, groupId: string, state: CiRunJob['ci']['state'], placement: CiRunJob['placement'] = 'host'): CiRunJob {
  const id = `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`
  return { ticketId: id, scope: 'affected', placement, message: null, tests: null,
    requester: { executionId: `exec-${nodeId}`, agentId: `agent-${nodeId}`, nodeId, nodeName: nodeId },
    ci: { id, groupId, suite: 'unit', part: 'unit-api', partition: null, state, exitCode: null, computer: null, step: null,
      queuedAt: '2026-10-01T00:00:00.000Z', startedAt: null, finishedAt: null } }
}
const group = (index: number) => `00000000-0000-4000-9000-${String(index).padStart(12, '0')}`

describe('CI server lights', () => {
  it('replays nothing on the first read, then sends one light per request and per finished request', () => {
    const first = ciGroupStates([job('coder', group(1), 'running')])
    expect(ciTransfers(undefined, first)).toEqual([])
    // Two Agents use CI at once: each request gets its own light, and parts of one request share one.
    const both = ciGroupStates([job('coder', group(1), 'running'), job('reviewer', group(2), 'queued'),
      job('reviewer', group(2), 'running')])
    expect(ciTransfers(first, both)).toEqual([{ key: `${group(2)}:request`, nodeId: 'reviewer', direction: 'request' }])
    const finished = ciGroupStates([job('coder', group(1), 'passed'), job('reviewer', group(2), 'failed'),
      job('reviewer', group(2), 'passed')])
    expect(ciTransfers(both, finished)).toEqual([
      { key: `${group(1)}:result`, nodeId: 'coder', direction: 'result', outcome: 'passed' },
      { key: `${group(2)}:result`, nodeId: 'reviewer', direction: 'result', outcome: 'failed' }])
    expect(ciTransfers(finished, finished)).toEqual([])
  })

  it('reports a request with a canceled part and no failure as canceled', () => {
    const states = ciGroupStates([job('coder', group(8), 'canceled'), job('coder', group(8), 'passed')])
    expect(states.get(group(8))).toEqual({ nodeId: 'coder', outcome: 'canceled' })
    expect(ciServerSummary([job('coder', group(8), 'canceled'), job('coder', group(8), 'passed')]))
      .toMatchObject({ state: 'idle', label: 'Last CI canceled' })
    expect(ciGroupStates([job('coder', group(9), 'canceled'), job('coder', group(9), 'failed')]).get(group(9))?.outcome).toBe('failed')
  })

  it('sends a request that finished between reads out and back', () => {
    expect(ciTransfers(new Map(), ciGroupStates([job('coder', group(3), 'passed')]))).toEqual([
      { key: `${group(3)}:request`, nodeId: 'coder', direction: 'request' },
      { key: `${group(3)}:result`, nodeId: 'coder', direction: 'result', outcome: 'passed' }])
  })
})

describe('CI server activity', () => {
  it('shows running parts ahead of newer completed or queued parts, then retains the latest result per Agent', () => {
    const passed = job('a', group(4), 'passed')
    const queued = job('a', group(4), 'queued')
    const starting = job('a', group(4), 'starting')
    const running = job('a', group(4), 'running')
    const olderRunning = job('a', group(3), 'running')
    const other = job('b', group(5), 'failed')
    expect(ciNodeActivities([passed, queued, starting, running, olderRunning, other]))
      .toEqual(new Map([['a', running.ci], ['b', other.ci]]))
    expect(ciNodeActivities([passed, job('a', group(3), 'failed'), other]))
      .toEqual(new Map([['a', passed.ci], ['b', other.ci]]))
  })

  it('is idle without CI, active while any ticket runs, then shows how the latest request ended', () => {
    expect(ciServerSummary([])).toMatchObject({ state: 'idle', label: 'Idle', total: 0 })
    expect(ciServerSummary([job('a', group(4), 'running', 'github'), job('b', group(5), 'queued', null)]))
      .toMatchObject({ state: 'running', label: '1 running · 1 queued', placements: ['github'] })
    expect(ciServerSummary([job('a', group(4), 'queued', null)])).toMatchObject({ state: 'queued', label: '1 queued' })
    // Newest first: the latest request failed although an older one passed.
    expect(ciServerSummary([job('a', group(6), 'lost'), job('a', group(6), 'passed'), job('b', group(5), 'passed')]))
      .toMatchObject({ state: 'failed', label: 'Last CI failed', failed: 1, total: 3 })
    expect(ciServerSummary([job('a', group(7), 'passed', 'circleci'), job('b', group(5), 'failed')]))
      .toMatchObject({ state: 'completed', label: 'Last CI passed', placements: ['circleci', 'host'] })
  })
})

it('places the CI tower outside every valid authored node identity', () => {
  const graph = fixture().draft.graph
  const owner = { ...graph.nodes[0]!, id: 'ci-server', position: { x: 0, y: 0 } }
  const tower = ciServerFlowNode([owner], ciServerSummary([]), () => undefined)
  expect(tower.id).not.toBe(owner.id)
  expect(WorkflowDefinitionV3Schema.safeParse({ ...graph, nodes: [owner], edges: [], entryNodeId: owner.id }).success).toBe(true)
  expect(WorkflowDefinitionV3Schema.safeParse({ ...graph, nodes: [{ ...owner, id: tower.id }], edges: [], entryNodeId: tower.id }).success).toBe(false)
  expect(tower).toMatchObject({ type: 'ciServer', selectable: false, draggable: false })
})
