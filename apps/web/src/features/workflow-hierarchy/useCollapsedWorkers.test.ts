import { act, renderHook } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'
import type { WorkflowHierarchy } from '@foreman-code/contracts'
import { useSidePanelPresentation } from '../workflow-board/sidePanelPresentation'
import { useCollapsedWorkers } from './useCollapsedWorkers'

const hierarchy = { version: 1, masterNodeId: 'master', parents: [
  { workflowNodeId: 'team', parentNodeId: 'master' }, { workflowNodeId: 'worker', parentNodeId: 'team' },
] } as WorkflowHierarchy

beforeEach(() => useSidePanelPresentation.setState({ collapsedTeams: {} }))

it('names the Workers hidden under a collapsed team and keeps the same set until that changes', () => {
  const { result, rerender } = renderHook(() => useCollapsedWorkers('board', hierarchy))
  expect([...result.current]).toEqual([])
  const unchanged = result.current
  rerender()
  expect(result.current).toBe(unchanged)
  act(() => useSidePanelPresentation.setState({ collapsedTeams: { board: ['team'] } }))
  expect([...result.current]).toEqual(['worker'])
  const collapsed = result.current
  rerender()
  expect(result.current).toBe(collapsed)
})
