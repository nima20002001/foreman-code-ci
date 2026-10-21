import { describe, expect, it } from 'vitest';
import { WorkspaceBoardSearchSchema, boardSearchForRun, boardSidePanelFromSearch,
  resolveWorkflowBoardLocation, staysOnWorkflowBoard } from './boardNavigation.js';

const scope = { workspaceId: 'workspace', workflowId: 'workflow', runId: 'run',
  workflowVersionId: 'version', executionSemanticsVersion: 3 as const };
const at = (search: unknown) => ({ pathname: '/workspaces/workspace', search });
const selection = { workflowId: 'workflow', agentId: 'authoring-agent', boardView: 'graph' as const,
  boardPanel: 'agent' as const, boardAgentTab: 'settings' as const, boardNodeId: 'worker' };

describe('shared Board surface URL state', () => {
  it('projects one selected rail while retaining its linkable node and execution context', () => {
    const search = WorkspaceBoardSearchSchema.parse({ ...boardSearchForRun(selection, 'workflow', scope),
      boardExecutionId: 'execution', boardMemory: 'true' });
    expect(boardSidePanelFromSearch(search)).toEqual({ kind: 'agent', nodeId: 'worker', tab: 'settings', executionId: 'execution' });
    expect(boardSidePanelFromSearch({ ...search, boardPanel: 'browser' })).toEqual({ kind: 'browser', nodeId: 'worker', executionId: 'execution' });
    expect(boardSidePanelFromSearch({ ...search, boardPanel: 'group_chat' })).toEqual({ kind: 'group_chat' });
    expect(boardSidePanelFromSearch({ ...search, boardPanel: 'operator' })).toEqual({ kind: 'operator' });
    expect(search.boardMemory).toBe(true);
    expect(boardSidePanelFromSearch({ workflowId: 'workflow' })).toEqual({ kind: 'none' });
  });

  it('requires an Agent selection and complete immutable execution pins', () => {
    expect(WorkspaceBoardSearchSchema.safeParse({ workflowId: 'workflow', boardPanel: 'agent' }).success).toBe(false);
    expect(WorkspaceBoardSearchSchema.safeParse({ workflowId: 'workflow', boardPanel: 'browser', boardExecutionId: 'execution' }).success).toBe(false);
    expect(() => resolveWorkflowBoardLocation('/workspaces/workspace', { ...selection, boardExecutionId: 'execution' })).toThrow();
    const pinned = resolveWorkflowBoardLocation('/workspaces/workspace/workflows/workflow/runs/run/graph/version/3',
      { boardPanel: 'browser', boardNodeId: 'worker', boardExecutionId: 'execution' });
    expect(pinned.run).toEqual(scope);
    expect(pinned.search.boardExecutionId).toBe('execution');
  });

  it('clears an execution only when the selected Run or version changes', () => {
    const search = WorkspaceBoardSearchSchema.parse({ ...boardSearchForRun(selection, 'workflow', scope), boardExecutionId: 'execution' });
    expect(boardSearchForRun(search, 'workflow', scope).boardExecutionId).toBe('execution');
    expect(boardSearchForRun(search, 'workflow', { ...scope, runId: 'other-run' })).toMatchObject({ boardNodeId: 'worker', boardPanel: 'agent' });
    expect(boardSearchForRun(search, 'workflow', { ...scope, runId: 'other-run' }).boardExecutionId).toBeUndefined();
    expect(boardSearchForRun(search, 'workflow', { ...scope, workflowVersionId: 'other-version' }).boardExecutionId).toBeUndefined();
    expect(boardSearchForRun(search, 'workflow').boardExecutionId).toBeUndefined();
  });

  it('retains drafts across rail, view, modal and Run changes while preserving departure guards', () => {
    const search = WorkspaceBoardSearchSchema.parse({ ...boardSearchForRun(selection, 'workflow', scope), boardExecutionId: 'execution' });
    for (const boardPanel of ['group_chat', 'browser', 'operator'] as const) {
      expect(staysOnWorkflowBoard(at(search), at({ ...search, boardPanel, boardView: 'overview', boardMemory: true }))).toBe(true);
    }
    expect(staysOnWorkflowBoard(at(search), at({ ...search, boardNodeId: 'other-node', boardAgentTab: 'chat' }))).toBe(true);
    expect(staysOnWorkflowBoard(at(search), at(boardSearchForRun(search, 'workflow', { ...scope, runId: 'other-run' })))).toBe(true);
    expect(staysOnWorkflowBoard(at(search), at({ ...search, agentId: 'other-authoring-agent' }))).toBe(false);
    expect(staysOnWorkflowBoard(at(search), at({ ...search, workflowId: 'other-workflow' }))).toBe(false);
    expect(staysOnWorkflowBoard(at(search), { pathname: '/workspaces/other-workspace', search: { workflowId: 'workflow' } })).toBe(false);
  });
});
