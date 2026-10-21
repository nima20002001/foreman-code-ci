import { beforeEach, describe, expect, it } from 'vitest'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { announceBoardChange, boardScope, clearBoardRedo, describeDraftChange, pendingBoardAction, popBoardAction,
  popBoardRedo, publishDraftDepth, recordBoardAction, useBoardUndo } from './boardUndo'

const scope = boardScope('workspace', 'workflow')
const graph = (patch: Partial<WorkflowDefinitionV3> = {}) => ({ id: 'workflow', workspaceId: 'workspace', name: 'Tasks',
  executionSemanticsVersion: 3, entryNodeId: 'a', executionCondition: { kind: 'manual' },
  nodes: [{ kind: 'agent', id: 'a', agentId: 'agent', name: 'Lead', position: { x: 0, y: 0 } }], edges: [], ...patch }) as WorkflowDefinitionV3

beforeEach(() => useBoardUndo.setState({ actions: {}, redo: {}, changes: {}, depth: {}, notice: undefined }))

describe('Board undo history', () => {
  it('names what a draft step changed', () => {
    expect(describeDraftChange(graph(), graph({ name: 'Renamed' }))).toBe('workflow name “Tasks” → “Renamed”')
    expect(describeDraftChange(graph(), graph({ nodes: [] }))).toBe('removed “Lead”')
    expect(describeDraftChange(graph(), graph({ executionPolicy: { maxParallelism: 2, maxNodeExecutions: 4 } }))).toBe('workflow limits')
  })
  it('undoes a settings action before older draft steps and after newer ones', () => {
    publishDraftDepth(scope, 2)
    recordBoardAction(scope, { label: 'schedule change', undo: async () => {}, redo: async () => {} })
    // Two later draft edits come first; then the schedule change at depth 2.
    expect(pendingBoardAction(scope, 4)).toBeUndefined()
    const action = pendingBoardAction(scope, 2)
    expect(action?.label).toBe('schedule change')
    popBoardAction(scope, action!)
    expect(pendingBoardAction(scope, 2)).toBeUndefined()
    expect(popBoardRedo(scope)).toMatchObject({ kind: 'action', action: { label: 'schedule change' } })
    expect(pendingBoardAction(scope, 2)?.label).toBe('schedule change')
  })
  it('drops redo after a new edit and keeps every announced change', () => {
    recordBoardAction(scope, { label: 'schedule set', undo: async () => {}, redo: async () => {} })
    popBoardAction(scope, pendingBoardAction(scope, 0)!)
    clearBoardRedo(scope)
    expect(popBoardRedo(scope)).toBeUndefined()
    announceBoardChange(scope, 'Undid schedule set')
    announceBoardChange(scope, 'Undid workflow name')
    expect(useBoardUndo.getState().changes[scope]?.map((change) => change.text)).toEqual(['Undid workflow name', 'Undid schedule set'])
    expect(useBoardUndo.getState().notice).toMatchObject({ scope, text: 'Undid workflow name' })
  })
})
