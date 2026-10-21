import type { ReactNode } from 'react'

import { WorkspaceExecutionLocationSetup } from '../features/settings/WorkspaceExecutionLocationSetup'
import { NewWorkflowAction } from '../features/workflows/NewWorkflowAction'
import { Alert, EmptyState, ErrorState, Icon, LoadingState } from '../shared/ui/nocturne'
import { useRunQuery } from '../shared/api/query'
import '../features/workflows/workflows.css'

import {
  WorkspaceShell,
  type WorkspaceShellSlots,
} from '../shared/ui/WorkspaceShell'

export type WorkspaceRouteState = 'ready' | 'loading' | 'error' | 'not-found' | 'empty' | 'stale'

export interface WorkspaceRouteViewProps {
  /** Run reads and authoring do not require a future-Run execution folder. Start still does. */
  allowBoardWithoutLocation?: boolean
  workspaceId: string
  selectedAgentId?: string
  activeWorkflowId?: string
  lastRunId?: string
  state?: WorkspaceRouteState
  stateMessage?: string
  slots?: WorkspaceShellSlots
}

function DefaultWorkspaceSlot({ workspaceId }: { workspaceId: string }) {
  return <strong>{workspaceId}</strong>
}

function WorkflowRunLocation({ workspaceId, runId }: { workspaceId: string; runId: string }) {
  const run = useRunQuery(workspaceId, runId)
  const path = run.data?.run.executionLocation?.rootPath
  if (!path) return null
  return <span className="workspace-board-run-location" aria-label={`Run location: ${path}`} title={`Run location: ${path}`}>
    <Icon name="folder" size={12} />
    <span>…/{path.split(/[\\/]/).filter(Boolean).slice(-2).join('/')}</span>
  </span>
}

function DefaultGraphSlot({
  workspaceId,
  selectedAgentId,
  state,
  stateMessage,
}: Pick<WorkspaceRouteViewProps, 'workspaceId' | 'selectedAgentId' | 'state' | 'stateMessage'>) {
  if (state === 'loading') {
    return (
      <div className="n-theme" data-testid="workspace-loading">
        <LoadingState label="Loading workspace…" />
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="n-theme" data-testid="workspace-error">
        <ErrorState
          title="Workspace unavailable"
          description={stateMessage ?? 'The workspace could not be loaded.'}
        />
      </div>
    )
  }

  if (state === 'not-found') {
    return (
      <div className="n-theme" data-testid="workspace-not-found">
        <ErrorState
          title="Workspace not found"
          description={stateMessage ?? `Workspace ${workspaceId} is not available.`}
        />
      </div>
    )
  }

  if (state === 'empty') {
    return (
      <div className="n-theme workspace-board-empty" data-testid="workspace-empty">
        <EmptyState
          icon="workflow"
          title="No workflows yet"
          action={<NewWorkflowAction workspaceId={workspaceId} />}
        />
      </div>
    )
  }

  if (state === 'stale') {
    return (
      <div className="n-theme" data-testid="workspace-stale">
        <Alert live tone="warning" title="Selection needs attention">
          {stateMessage ?? `Agent ${selectedAgentId ?? 'selection'} is no longer available.`}
        </Alert>
      </div>
    )
  }

  return (
    <div className="n-theme" data-testid="workspace-ready">
      <EmptyState
        icon="workflow"
        title="Workflow graph"
        description={`The graph surface is ready for workspace ${workspaceId}.${selectedAgentId ? ` Agent ${selectedAgentId} is selected.` : ' No agent is selected.'}`}
      />
    </div>
  )
}

export function WorkspaceRouteView({
  workspaceId,
  selectedAgentId,
  activeWorkflowId,
  lastRunId,
  state = 'ready',
  stateMessage,
  slots,
  allowBoardWithoutLocation = false,
}: WorkspaceRouteViewProps) {
  const resolvedSlots: WorkspaceShellSlots = {
    workspace: slots?.workspace ?? <DefaultWorkspaceSlot workspaceId={workspaceId} />,
    graph:
      slots?.graph ?? (
        <DefaultGraphSlot
          workspaceId={workspaceId}
          selectedAgentId={selectedAgentId}
          state={state}
          stateMessage={stateMessage}
        />
      ),
  }

  resolvedSlots.graph = (
    <WorkspaceExecutionLocationSetup workspaceId={workspaceId} enabled={!allowBoardWithoutLocation && state !== 'loading' && state !== 'error' && state !== 'not-found'}>
      {state === 'ready' ? <div className="workspace-board">
        {lastRunId ? <div className="workspace-board-actions" data-testid="workspace-board-actions">
          <WorkflowRunLocation workspaceId={workspaceId} runId={lastRunId} />
        </div> : null}
        {resolvedSlots.graph}
      </div> : resolvedSlots.graph}
    </WorkspaceExecutionLocationSetup>
  )

  return (
    <WorkspaceShell
      workspaceId={workspaceId}
      activeWorkflowId={activeWorkflowId}
      slots={resolvedSlots}
    />
  )
}

export interface WorkspaceSelectionProps {
  allowBoardWithoutLocation?: boolean
  workspaceId: string
  selectedAgentId?: string
  activeWorkflowId?: string
  lastRunId?: string
  state?: WorkspaceRouteState
  stateMessage?: string
  slots?: WorkspaceShellSlots
  /** Optional extra content for route-level consumers above the shell. */
  children?: ReactNode
}

export function WorkspaceSelection({
  children,
  ...props
}: WorkspaceSelectionProps) {
  const state = props.state ?? 'ready'

  return (
    <div className="workspace-route" data-testid="workspace-route">
      <WorkspaceRouteView {...props} state={state} />
      {children}
    </div>
  )
}
