import { expect, it, vi } from 'vitest'
import { applyGraphGeometry } from '../geometry'
import { createGraphTopologyProjector } from '../topology'
import type { GraphProjection } from '../types'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { fixture } from './core.cases'

it('the shared geometry seam preserves entry, typed relationships, choices and unrelated node references', () => {
  const graph = fixture().draft.graph
  graph.nodes[0]!.choice = { outcomes: [{ outcome: 'next', target: { kind: 'edge', relationshipId: 'execution-1' } }] }
  const next = applyGraphGeometry(graph, [{ id: 'node-0', position: { x: 1200, y: -400 } }]) as WorkflowDefinitionV3
  expect(next.entryNodeId).toBe(graph.entryNodeId)
  expect(next.executionSemanticsVersion).toBe(3)
  expect(next.edges).toBe(graph.edges)
  expect(next.nodes[0]!.choice).toBe(graph.nodes[0]!.choice)
  expect(next.nodes[1]).toBe(graph.nodes[1])
  expect(applyGraphGeometry(graph, [{ id: 'removed', position: { x: 0, y: 0 } }])).toBe(graph)
})

it('the consumed topology seam does not reproject runtime-only Agent observations', () => {
  const context = fixture()
  const project = vi.fn((): GraphProjection => ({ nodes: [], edges: [] }))
  const topology = createGraphTopologyProjector(project)
  topology(context.draft.graph, context.agents.map((item) => item.agent))
  topology(context.draft.graph, context.agents.map((item) => ({ ...item.agent, executionState: 'disconnected' as const })))
  expect(project).toHaveBeenCalledOnce()
})
