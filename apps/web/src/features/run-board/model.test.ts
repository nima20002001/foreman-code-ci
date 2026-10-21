import { nativeNode } from '../../shared/mocks/nativeFixtureTypes'
import { describe, expect, it } from 'vitest'
import { Position } from '@xyflow/react'
import { projectRunBoard, READ_ONLY_FLOW_PROPS } from './model'
import { savedEdgeCurve } from './curve'
import { runA, runB } from './testFixtures'

describe('saved board projection', () => {
  it('preserves exact nodes, names, configuration pins and order, and lays them out as a hierarchy', () => {
    const result = projectRunBoard(runA)
    expect(result.nodes.map((node) => node.id)).toEqual(runA.nodes.map((node) => node.id))
    for (const [index, node] of result.nodes.entries()) {
      const saved = nativeNode(runA.nodes[index]!)
      expect(node.data.snapshot).toBe(saved)
      expect(node.position).not.toBe(saved.position)
      expect(node.style).toEqual({ width: node.initialWidth, height: node.initialHeight })
      expect(node.ariaLabel).toContain(saved.name)
      expect(node.domAttributes?.title).toContain(saved.agentConfigurationVersionId)
    }
    // X hands to Y and Y to Z: each sits in its own layer below the one before, whatever was saved.
    const [x, y, z] = result.nodes.map((node) => node.position)
    expect(x!.y).toBeLessThan(y!.y)
    expect(y!.y).toBeLessThan(z!.y)
    expect(projectRunBoard(runB).nodes.map((node) => node.id)).not.toContain('node-y')
  })
  it('never installs mutable canvas geometry into the frozen snapshot', () => {
    const before = JSON.stringify(runA)
    const result = projectRunBoard(runA)
    nativeNode(result.nodes[0]!).position.x = 999
    nativeNode(result.nodes[0]!).style!.width = 999
    result.nodes.splice(1, 1)
    result.edges.pop()
    expect(JSON.stringify(runA)).toBe(before)
    expect(Object.isFrozen(runA)).toBe(true)
    expect(Object.isFrozen(nativeNode(runA.nodes[0]!).position)).toBe(true)
  })
  it('keeps approval and execution edges distinct, including handles, labels and policy', () => {
    const { edges } = projectRunBoard(runA)
    expect(edges.map((edge) => edge.id)).toEqual(['edge-xy', 'approval-xy', 'edge-yz'])
    expect(edges[0]).toMatchObject({ source: 'node-x', target: 'node-y', sourceHandle: 'bottom', targetHandle: 'top' })
    expect(edges[0]!.data!.snapshot).toBe(runA.edges[0])
    expect(edges[0]!.data!.snapshot.maxWorkHandoffsPerRun).toBe(3)
    expect(edges[0]!.data!.lane).not.toBe(edges[1]!.data!.lane)
    expect(edges[2]).toMatchObject({ sourceHandle: 'right', targetHandle: 'left' })
  })
  it('locks keyboard, drag, connect, reconnect and delete at both canvas and object levels', () => {
    expect(READ_ONLY_FLOW_PROPS).toMatchObject({ nodesDraggable: false, nodesConnectable: false,
      edgesReconnectable: false, elementsSelectable: false, connectOnClick: false,
      disableKeyboardA11y: true, deleteKeyCode: null })
    const { nodes, edges } = projectRunBoard(runA)
    for (const node of nodes) expect(node).toMatchObject({ draggable: false, connectable: false, selectable: false, deletable: false })
    for (const edge of edges) expect(edge).toMatchObject({ selectable: false, reconnectable: false, deletable: false })
  })
})

describe('saved edge geometry', () => {
  const input = { sourceX: 10, sourceY: 20, targetX: 500, targetY: 200,
    sourcePosition: Position.Bottom, targetPosition: Position.Top, lane: 0, loop: false }
  it('uses the actual saved handle endpoints and has finite chevron geometry', () => {
    const curve = savedEdgeCurve(input)
    expect(curve.path).toMatch(/^M 10,20 C /)
    expect(curve.path).toMatch(/ 500,200$/)
    expect(Object.values(curve.mid).every(Number.isFinite)).toBe(true)
    expect(savedEdgeCurve({ ...input, lane: 1 }).path).not.toBe(curve.path)
  })
  it('handles all four sides and coincident/self edges without NaN', () => {
    for (const side of Object.values(Position)) {
      const curve = savedEdgeCurve({ ...input, sourcePosition: side, targetPosition: side,
        targetX: input.sourceX, targetY: input.sourceY, loop: true })
      expect(curve.path).not.toMatch(/NaN|Infinity/)
      expect(Object.values(curve.mid).every(Number.isFinite)).toBe(true)
    }
  })
})

describe('Run Board Host CI ownership', () => {
  const ci = {
    id: '00000000-0000-4000-8000-000000000001', groupId: '00000000-0000-4000-8000-000000000002',
    suite: 'integration' as const, part: null, partition: { index: 0, count: 2 }, state: 'queued' as const,
    computer: null, step: null, exitCode: null, queuedAt: '2026-10-01T00:00:00.000Z', startedAt: null, finishedAt: null,
  }
  const scope = { workspaceId: runA.workspaceId, workflowId: runA.workflowId, runId: runA.runId,
    workflowVersionId: runA.workflowVersionId }
  const ref = { kind: 'ci' as const, ...scope, nodeId: 'node-x', agentId: 'agent-x', executionId: 'execution-x',
    attemptKey: '1', ticketId: ci.id }
  const activity = { schemaVersion: 1 as const, scope: { kind: 'workflow_run' as const, ...scope }, revision: '1',
    active: [{ ref, phase: 'waiting' as const, outcome: null, delivery: null, evidence: 'confirmed' as const,
      startedAt: null, ci }], queued: [ref], latest: ref, pendingInteractions: [], activities: [],
    page: { before: null, nextCursor: null, hasMore: false } }

  it('shows each CI ticket only on the originating Agent and leaves captured facts untouched', () => {
    const before = JSON.stringify(runA)
    const result = projectRunBoard(runA, activity)
    expect(result.nodes[0]?.data.ci).toEqual(ci)
    expect(result.nodes[1]?.data.ci).toBeUndefined()
    expect(result.nodes[2]?.data.ci).toBeUndefined()
    expect(JSON.stringify(runA)).toBe(before)
    expect(projectRunBoard(runB, activity).nodes.every(node => !node.data.ci)).toBe(true)
    const foreign = { ...activity, active: [{ ...activity.active[0]!, ref: { ...ref, agentId: 'foreign-agent' } }] }
    expect(projectRunBoard(runA, foreign).nodes.every(node => !node.data.ci)).toBe(true)
  })

  it('keeps a running partition visible beside a newer queued partition', () => {
    const running = { ...activity.active[0]!, ci: { ...ci, state: 'running' as const,
      computer: { label: 'Build computer', hostRef: { kind: 'main' as const, mainId: 'synthetic-main' } } } }
    const queued = { ...activity.active[0]!, ref: { ...ref, ticketId: ci.groupId },
      ci: { ...ci, id: ci.groupId, partition: { index: 1, count: 2 } } }
    expect(projectRunBoard(runA, { ...activity, active: [running, queued] }).nodes[0]?.data.ci).toEqual(running.ci)
  })

  it('replaces active CI with the recorded terminal result without marking other Agents complete', () => {
    const done = { ...ci, state: 'passed' as const, exitCode: 0 }
    const completed = { ...activity, active: [], queued: [], activities: [{ kind: 'diagnostic' as const,
      id: 'ci-finished', revision: '0', order: '3', owner: ref, source: { schemaVersion: 1 as const,
        system: 'run_activity', observedAt: done.queuedAt }, evidence: 'confirmed' as const,
      code: 'job_work', message: 'CI integration passed', ci: done }] }
    const result = projectRunBoard(runA, completed)
    expect(result.nodes[0]?.data.ci?.state).toBe('passed')
    expect(result.nodes[1]?.data.ci).toBeUndefined()
  })
})
