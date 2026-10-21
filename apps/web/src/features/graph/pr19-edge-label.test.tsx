import { applyGraphGeometry } from './geometry'
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Position, ReactFlowProvider, type EdgeProps } from '@xyflow/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type WorkflowDefinitionV3 as WorkflowDefinition } from '@foreman-code/contracts/wave25'
import { HandoffEdge } from './GraphElements'
import { GraphPresentationProvider } from './GraphPresentation'
import { makeSequentialHandoffEdge, workflowToGraph } from './mapper'
import type { GraphEdge } from './types'

vi.mock('@xyflow/react', async (original) => ({ ...await original<typeof import('@xyflow/react')>(),
  BaseEdge: (props: { id: string; path: string; label?: string; labelX?: number; labelY?: number }) => <g>
    <path id={props.id} d={props.path} />
    {props.label ? <text x={props.labelX} y={props.labelY}>{props.label}</text> : null}
  </g>,
}))
afterEach(cleanup)
describe('PR19 custom handoff labels', () => {
  it('names the edge by its explicit label without drawing it, and preserves it after moving and saving', () => {
    // Minimal graph data; these pure mappers preserve unrelated domain metadata.
    const workflow = { id: 'named-workflow', workspaceId: 'workspace', name: 'Named workflow', executionSemanticsVersion: 3, entryNodeId: 'a', executionCondition: { kind: 'manual' }, nodes: [{ id: 'a', agentId: 'agent-a' }, { id: 'b', agentId: 'agent-b' }],
      edges: [{ id: 'edge', source: 'a', target: 'b', kind: 'execution', label: 'Only after review approval' }] } as WorkflowDefinition
    const graph = workflowToGraph({ workflow, agents: [] })
    const edge = graph.edges[0]!
    const props = { ...edge, sourceX: 0, sourceY: 0, targetX: 200, targetY: 0,
      sourcePosition: Position.Right, targetPosition: Position.Left } as EdgeProps<GraphEdge>
    render(<QueryClientProvider client={new QueryClient()}><ReactFlowProvider><GraphPresentationProvider><svg><HandoffEdge {...props} /></svg></GraphPresentationProvider></ReactFlowProvider></QueryClientProvider>)
    expect(screen.queryByText('Only after review approval')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('group', { name: /Only after review approval/ }))
    expect(screen.getByRole('button', { name: /only after review approval/i })).toBeInTheDocument()
    const moved = graph.nodes.map((node) => ({ ...node, position: { x: node.position.x + 50, y: node.position.y + 10 } }))
    expect(applyGraphGeometry(workflow, moved.map(({ id, position }) => ({ id, position }))).edges[0]?.label).toBe('Only after review approval')
    expect(makeSequentialHandoffEdge('a', 'b').label).toBeUndefined()
  })
})
