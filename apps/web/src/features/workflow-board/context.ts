import { createContext, useContext, type ReactNode } from 'react'
import type { BoardSidePanel, RepeatGraphScopeV3, WorkspaceBoardInspection } from '@foreman-code/contracts/wave25'
import type { CollaborationFieldSlots } from '../graph/collaborationFields'

export type WorkflowAuthoringActions = { openWorkflowSettings(): void }

/** Callbacks and presentation context only; neither drafts nor Run facts live here. */
export const WorkflowBoardContext = createContext<{
  workspaceId: string; workflowId: string; run?: RepeatGraphScopeV3
  selectedAgentId?: string; selectDraftAgent?(agentId?: string): void
  inspection: WorkspaceBoardInspection
  selectInspection(inspection: WorkspaceBoardInspection): void
  selectRun(scope?: RepeatGraphScopeV3): void
  getSelectionToken?(): unknown
  openLocation(): void
  openRuns(): void
  navigationControls?: ReactNode
  authoringActive?: boolean
  registerAuthoringActions?(actions?: WorkflowAuthoringActions): void
  sidePanel?: BoardSidePanel
  selectedPanelNodeId?: string
  selectSidePanel?(selection: BoardSidePanel): void
  sidePanelHost?: HTMLDivElement | null
  executionChatMounted?: boolean
  collaborationFields?: CollaborationFieldSlots
  memoryOpen?: boolean
  canvasVisible?: boolean
  teamNodeId?: string
  selectTeam?(nodeId?: string): void
  /** Active or recovering Runs in the workspace; saving meaningful edits may stop them. */
  activeRuns: number
} | null>(null)
export const useWorkflowBoard = () => useContext(WorkflowBoardContext)
