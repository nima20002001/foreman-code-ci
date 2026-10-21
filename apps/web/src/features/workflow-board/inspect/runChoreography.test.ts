import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { RepeatGraphCurrentV3 } from '@foreman-code/contracts/wave25'
import { runHandoffs, runNodeDisplays, SETTLE_MS, TRAVEL_MS, useRunChoreography } from './runChoreography'

const edges = [
  { id: 'e-ab', kind: 'execution' as const, source: 'a', target: 'b' },
  { id: 'e-bc', kind: 'execution' as const, source: 'b', target: 'c' },
  { id: 'review-ab', kind: 'approval' as const, source: 'a', target: 'b' },
]
const id = (node: string) => ({ workflowNodeId: node, executionId: `x-${node}`, agentId: `agent-${node}`, agentConfigurationVersionId: `cfg-${node}`, attempt: 1 })
const execution = (node: string, state: string, resultOutcome: string | null = null) => ({ identity: { ...id(node), occurrence: null }, state, resultOutcome })
const binding = (from: string, to: string, relationshipId: string) => ({ bindingId: `bind-${from}-${to}`, kind: 'predecessor', relationshipId, sender: id(from), recipient: id(to) })
const activity = (node: string, action?: string) => ({ state: { workflowNodeId: node }, activity: action
  ? { workflowNodeId: node, status: 'active', action } : { workflowNodeId: node, status: 'none' } })
function record(parts: { executions?: unknown[]; bindings?: unknown[]; interactions?: unknown[]; nodes?: unknown[]; done?: boolean }) {
  const topology = { relationships: edges.map((edge) => ({ relationshipId: edge.id, kind: edge.kind, source: edge.source, target: edge.target })) }
  return { topology, state: { run: { executionState: parts.done ? 'completed' : 'running' }, resolutions: [], executions: parts.executions ?? [],
    bindings: parts.bindings ?? [], interactions: parts.interactions ?? [], nodes: parts.nodes ?? [] } } as unknown as RepeatGraphCurrentV3
}

describe('run choreography facts', () => {
  it('turns bindings and approval exchanges into directed handoffs', () => {
    const cut = record({ bindings: [binding('a', 'b', 'e-ab')], interactions: [
      { interactionId: 'i1', requester: id('b'), reviewer: id('a'), approvalRelationshipId: 'review-ab', status: 'pending' },
      { interactionId: 'i2', requester: id('b'), reviewer: id('a'), approvalRelationshipId: 'review-ab', status: 'delivered', decision: 'approve_once' },
      { interactionId: 'i3', requester: id('b'), reviewer: id('a'), approvalRelationshipId: 'review-ab', status: 'delivered', decision: 'reject' },
    ] })
    expect(runHandoffs(cut, edges).map(({ key, edgeId, signal, reversed, from, to }) => [key, edgeId, signal, reversed, from, to])).toEqual([
      ['bind-a-b', 'e-ab', 'task', false, 'a', 'b'],
      ['ask:i1', 'review-ab', 'approval', true, 'b', 'a'],
      ['ask:i2', 'review-ab', 'approval', true, 'b', 'a'],
      ['answer:i2', 'review-ab', 'grant', false, 'a', 'b'],
      ['ask:i3', 'review-ab', 'approval', true, 'b', 'a'],
      ['answer:i3', 'review-ab', 'error', false, 'a', 'b'],
    ])
  })

  it('names review and approval work from the exact activity', () => {
    const cut = record({ executions: [execution('a', 'completed', 'succeeded'), execution('b', 'waiting'), execution('c', 'running')],
      nodes: [activity('a', 'reviewing'), activity('b', 'waiting_approval'), activity('c', 'writing_file')] })
    const views = runNodeDisplays(cut)
    expect([...views.entries()]).toEqual([['a', { state: 'running', label: 'Reviewing' }],
      ['b', { state: 'waiting', label: 'Needs approval' }], ['c', { state: 'running', label: 'Writing files' }]])
    const answered = (status: string, resumeState = 'not_started') => runNodeDisplays(record({ executions: [execution('b', 'waiting')], interactions: [
      { interactionId: 'old', revision: '3', requester: id('b'), status: 'pending' },
      { interactionId: 'new', revision: '9', requester: id('b'), status, decision: 'approve_once', resumeState }] })).get('b')
    expect(answered('delivery_pending')).toEqual({ state: 'waiting', label: 'Needs approval' })
    const latest = (status: string, resumeState = 'not_started') => runNodeDisplays(record({ executions: [execution('b', 'waiting')], interactions: [
      { interactionId: 'old', revision: '3', requester: id('b'), status: 'delivered', decision: 'approve_once', resumeState: 'acknowledged' },
      { interactionId: 'new', revision: '9', requester: id('b'), status, decision: 'approve_once', resumeState }] })).get('b')
    expect(latest('decided')).toEqual({ state: 'approved', label: 'Approved' })
    expect(latest('delivered', 'pending')).toEqual({ state: 'approved', label: 'Resuming' })
    expect(latest('delivered', 'acknowledged')).toEqual({ state: 'running', label: 'Continuing' })
    const finished = runNodeDisplays(record({ done: true, executions: [execution('a', 'completed', 'succeeded')], nodes: [activity('a', 'reviewing')] }))
    expect(finished.get('a')).toEqual({ state: 'completed', label: 'Completed' })
  })
})

describe('run choreography timing', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] }) })
  afterEach(() => { vi.useRealTimers() })

  it('holds the receiver until the pulse lands, then ignites it', () => {
    const first = record({ executions: [execution('a', 'running')] })
    const { result, rerender } = renderHook(({ cut }) => useRunChoreography(cut, edges), { initialProps: { cut: first } })
    expect(result.current.nodes.get('a')).toEqual({ state: 'running', label: 'Running' })
    expect(result.current.pulses.size).toBe(0)

    rerender({ cut: record({ executions: [execution('a', 'completed', 'succeeded'), execution('b', 'running')], bindings: [binding('a', 'b', 'e-ab')] }) })
    expect(result.current.nodes.get('a')).toMatchObject({ state: 'completed', transition: 'complete' })
    expect(result.current.nodes.get('b')).toEqual({ state: 'idle', label: 'Not started' })
    expect(result.current.pulses.get('e-ab')?.map((pulse) => pulse.key)).toEqual(['bind-a-b'])

    act(() => { vi.advanceTimersByTime(TRAVEL_MS + 20) })
    expect(result.current.nodes.get('b')).toMatchObject({ state: 'running', label: 'Running', transition: 'ignite' })
    expect(result.current.pulses.size).toBe(0)

    act(() => { vi.advanceTimersByTime(SETTLE_MS + 20) })
    expect(result.current.nodes.get('b')).toEqual({ state: 'running', label: 'Running' })
  })

  it('orders several handoffs from one poll so each leaves after its input landed', () => {
    const { result, rerender } = renderHook(({ cut }) => useRunChoreography(cut, edges), { initialProps: { cut: record({ executions: [execution('a', 'running')] }) } })
    rerender({ cut: record({ executions: [execution('a', 'completed', 'succeeded'), execution('b', 'completed', 'succeeded'), execution('c', 'running')],
      bindings: [binding('b', 'c', 'e-bc'), binding('a', 'b', 'e-ab')] }) })
    const [ab] = result.current.pulses.get('e-ab')!, [bc] = result.current.pulses.get('e-bc')!
    expect(bc!.startsAt).toBeGreaterThanOrEqual(ab!.startsAt + TRAVEL_MS)
    expect(result.current.nodes.get('b')?.state).toBe('idle')
    expect(result.current.nodes.get('c')?.state).toBe('idle')
    act(() => { vi.advanceTimersByTime(TRAVEL_MS + 20) })
    expect(result.current.nodes.get('b')).toMatchObject({ state: 'completed', transition: 'arrive' })
    expect(result.current.nodes.get('c')?.state).toBe('idle')
    act(() => { vi.advanceTimersByTime(TRAVEL_MS + 400) })
    expect(result.current.nodes.get('c')).toMatchObject({ state: 'running', transition: 'ignite' })
  })

  it('does not replay handoffs that were already history when the Run opened', () => {
    const { result } = renderHook(() => useRunChoreography(record({ done: true,
      executions: [execution('a', 'completed', 'succeeded'), execution('b', 'completed', 'succeeded')], bindings: [binding('a', 'b', 'e-ab')] }), edges))
    expect(result.current.pulses.size).toBe(0)
    expect(result.current.nodes.get('b')).toEqual({ state: 'completed', label: 'Completed' })
  })

  it('plays an approval round trip: request to the reviewer, answer back to the worker', () => {
    const running = record({ executions: [execution('a', 'completed', 'succeeded'), execution('b', 'running')], bindings: [binding('a', 'b', 'e-ab')] })
    const { result, rerender } = renderHook(({ cut }) => useRunChoreography(cut, edges), { initialProps: { cut: running } })
    act(() => { vi.advanceTimersByTime(TRAVEL_MS + SETTLE_MS + 40) })
    const ask = { interactionId: 'i1', requester: id('b'), reviewer: id('a'), approvalRelationshipId: 'review-ab' }
    rerender({ cut: record({ executions: [execution('a', 'completed', 'succeeded'), execution('b', 'waiting')], bindings: [binding('a', 'b', 'e-ab')],
      interactions: [{ ...ask, status: 'pending' }], nodes: [activity('a', 'reviewing'), activity('b', 'waiting_approval')] }) })
    expect(result.current.nodes.get('b')).toMatchObject({ state: 'waiting', label: 'Needs approval', transition: 'wait' })
    expect(result.current.nodes.get('a')).toEqual({ state: 'completed', label: 'Completed' })
    expect(result.current.pulses.get('review-ab')?.[0]).toMatchObject({ signal: 'approval', reversed: true })
    act(() => { vi.advanceTimersByTime(TRAVEL_MS + 20) })
    // The request lands with an amber bang on the reviewer.
    expect(result.current.nodes.get('a')).toMatchObject({ state: 'running', label: 'Reviewing', transition: 'ask' })

    rerender({ cut: record({ executions: [execution('a', 'completed', 'succeeded'), execution('b', 'running')], bindings: [binding('a', 'b', 'e-ab')],
      interactions: [{ ...ask, status: 'delivered', decision: 'approve_once' }] }) })
    expect(result.current.pulses.get('review-ab')?.[0]).toMatchObject({ key: 'answer:i1', signal: 'grant', reversed: false })
    expect(result.current.nodes.get('b')).toMatchObject({ state: 'waiting', label: 'Needs approval' })
    // The reviewer's request landed a moment ago; its answer leaves just after.
    act(() => { vi.advanceTimersByTime(TRAVEL_MS) })
    expect(result.current.nodes.get('b')).toMatchObject({ state: 'waiting' })
    act(() => { vi.advanceTimersByTime(400) })
    expect(result.current.nodes.get('b')).toMatchObject({ state: 'running', label: 'Running', transition: 'grant' })
  })

  it('replays a poll that jumped over a whole approval round trip in causal order', () => {
    const { result, rerender } = renderHook(({ cut }) => useRunChoreography(cut, edges), { initialProps: { cut: record({}) } })
    rerender({ cut: record({ executions: [execution('a', 'completed', 'succeeded'), execution('b', 'running')], bindings: [binding('a', 'b', 'e-ab')],
      interactions: [{ interactionId: 'i1', requester: id('b'), reviewer: id('a'), approvalRelationshipId: 'review-ab', status: 'delivered', decision: 'approve_once' }] }) })
    const [handoff] = result.current.pulses.get('e-ab')!
    const flights = result.current.pulses.get('review-ab')!
    const ask = flights.find((pulse) => pulse.kind === 'ask')!, answer = flights.find((pulse) => pulse.kind === 'answer')!
    expect(ask.startsAt).toBeGreaterThanOrEqual(handoff!.startsAt + TRAVEL_MS)
    expect(answer.startsAt).toBeGreaterThanOrEqual(ask.startsAt + TRAVEL_MS)
    expect(result.current.nodes.get('a')).toMatchObject({ state: 'completed', transition: 'complete' })
    expect(result.current.nodes.get('b')).toMatchObject({ state: 'idle', label: 'Not started' })
    act(() => { vi.advanceTimersByTime(TRAVEL_MS + 20) })
    expect(result.current.nodes.get('b')).toMatchObject({ state: 'waiting', label: 'Needs approval', transition: 'arrive' })
    expect(result.current.nodes.get('a')).toMatchObject({ state: 'completed' })
    act(() => { vi.advanceTimersByTime(answer.startsAt - performance.now() + TRAVEL_MS + 20) })
    expect(result.current.nodes.get('b')).toMatchObject({ state: 'running', label: 'Running', transition: 'grant' })
    expect(result.current.pulses.size).toBe(0)
  })

  it('bangs a receiver the moment a pulse lands, even when its words do not change', () => {
    const { result, rerender } = renderHook(({ cut }) => useRunChoreography(cut, edges), { initialProps: { cut: record({ executions: [execution('a', 'running')] }) } })
    rerender({ cut: record({ executions: [execution('a', 'completed', 'succeeded'), execution('b', 'queued')], bindings: [binding('a', 'b', 'e-ab')] }) })
    expect(result.current.nodes.get('b')).toEqual({ state: 'idle', label: 'Not started' })
    act(() => { vi.advanceTimersByTime(TRAVEL_MS + 20) })
    expect(result.current.nodes.get('b')).toMatchObject({ state: 'queued', transition: 'arrive' })
    const first = result.current.nodes.get('b')!.transitionKey
    act(() => { vi.advanceTimersByTime(300) })
    rerender({ cut: record({ executions: [execution('a', 'completed', 'succeeded'), execution('b', 'running')], bindings: [binding('a', 'b', 'e-ab')] }) })
    expect(result.current.nodes.get('b')).toMatchObject({ state: 'running', transition: 'ignite' })
    expect(result.current.nodes.get('b')!.transitionKey).not.toBe(first)
  })

  it('lands an approval answer with a green bang and a green approved state', () => {
    const ask = { interactionId: 'i1', requester: id('b'), reviewer: id('a'), approvalRelationshipId: 'review-ab', revision: '1' }
    const waiting = { executions: [execution('a', 'completed', 'succeeded'), execution('b', 'waiting')], bindings: [binding('a', 'b', 'e-ab')] }
    const { result, rerender } = renderHook(({ cut }) => useRunChoreography(cut, edges), { initialProps: { cut: record({ ...waiting, interactions: [{ ...ask, status: 'pending' }] }) } })
    act(() => { vi.advanceTimersByTime(TRAVEL_MS + SETTLE_MS + 40) })
    rerender({ cut: record({ ...waiting, interactions: [{ ...ask, status: 'decided', decision: 'approve_once' }] }) })
    expect(result.current.nodes.get('b')).toMatchObject({ state: 'waiting', label: 'Needs approval' })
    act(() => { vi.advanceTimersByTime(TRAVEL_MS + 20) })
    expect(result.current.nodes.get('b')).toMatchObject({ state: 'approved', label: 'Approved', transition: 'grant' })
  })
})
