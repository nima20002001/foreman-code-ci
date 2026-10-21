import { useRef, useState } from 'react'
import { useStore } from 'zustand'
import { Icon, IconButton } from '../../shared/ui/nocturne'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { createScheduleEditorStore } from './editorStore'
import { ScheduleModal } from './ScheduleModal'
import { useScheduleCommand } from './queries'
import './schedules.css'

export interface ScheduleClockButtonProps {
  workspaceId: string
  workflowId?: string | null
  /** True only when a persisted workflow version exists; a client-allocated id is insufficient. */
  isSaved: boolean
}

export function ScheduleClockButton(props: ScheduleClockButtonProps) {
  if (!props.isSaved || !props.workflowId || !props.workspaceId) {
    return <span className="schedule-clock-disabled" tabIndex={0} aria-label="Save workflow first">
      <IconButton label="Save workflow first" size="sm" variant="ghost" disabled><Icon name="clock" size={16} /></IconButton>
    </span>
  }
  // Drafts, dialogs, and in-flight callbacks can never migrate into another workflow.
  return <SavedScheduleClock key={JSON.stringify([sessionGeneration(), props.workspaceId, props.workflowId])}
    workspaceId={props.workspaceId} workflowId={props.workflowId} />
}

function SavedScheduleClock({ workspaceId, workflowId }: { workspaceId: string; workflowId: string }) {
  // React holds only the store instance; Zustand owns all local interaction state.
  const [store] = useState(createScheduleEditorStore)
  const open = useStore(store, (state) => state.open)
  const trigger = useRef<HTMLButtonElement>(null)
  const command = useScheduleCommand({ workspaceId, workflowId })
  const historyLocked = !!command.command?.history && (command.pending || command.unconfirmed)
  return <>
    <IconButton ref={trigger} label="Schedule workflow" size="sm" variant="ghost"
      disabled={historyLocked} title={historyLocked ? 'Confirm the pending schedule change on the Board first.' : undefined}
      aria-haspopup="dialog" aria-expanded={open} onClick={() => store.getState().show()}>
      <Icon name="clock" size={16} />
    </IconButton>
    <ScheduleModal scope={{ workspaceId, workflowId }} store={store} returnFocusRef={trigger} />
  </>
}
