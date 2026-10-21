import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { QueryClient } from '@tanstack/react-query'
import { ScheduleConfigurationSchema, type ScheduleGetInput, type WorkflowSchedule } from '@foreman-code/contracts/schedules'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { boardScope, recordBoardAction, useBoardUndo } from '../workflow-board/boardUndo'
import { scheduleApi } from './client'
import { scheduleCommandOwner, type ScheduleCommand } from './queries'

function scheduleSettings(schedule: WorkflowSchedule) {
  const { workspaceId, workflowId, revision, nextOccurrenceAt, ...settings } = schedule
  void workspaceId
  void workflowId
  void revision
  void nextOccurrenceAt
  if (settings.mode === 'weekly') return { ...settings, weekdays: [...settings.weekdays].sort((a, b) => a - b) }
  return settings
}

async function restoreSchedule(scope: ScheduleGetInput, target: WorkflowSchedule | null, expected: WorkflowSchedule,
  client: QueryClient, lineageKey: string, generation: number, history: NonNullable<ScheduleCommand['history']>) {
  assertSession(generation)
  const owner = scheduleCommandOwner(client, scope)
  if (owner.pending) throw new Error('A schedule change is still in progress.')
  let result
  if (owner.unconfirmed) {
    result = await owner.retry(history)
  } else {
    const expectedRevision = useBoardUndo.getState().scheduleRevisions[lineageKey]!
    const { schedule } = await scheduleApi.get(scope)
    assertSession(generation)
    if (!schedule || schedule.revision !== expectedRevision
      || !sameWorkflowValue(scheduleSettings(schedule), scheduleSettings(expected))) {
      throw new Error('Schedule changed. Undo or Redo cannot replace another schedule edit.')
    }
    if (target) {
      const settings = scheduleSettings(target)
      result = await owner.submit({ kind: 'save', history,
        input: { ...scope, expectedRevision, schedule: ScheduleConfigurationSchema.parse(settings) } })
    } else {
      result = await owner.submit({ kind: 'disable', history, input: { ...scope, expectedRevision } })
    }
  }
  if (!result) throw new Error('Resolve the pending schedule change before using Undo or Redo.')
  assertSession(generation)
  useBoardUndo.setState(state => ({ scheduleRevisions: { ...state.scheduleRevisions, [lineageKey]: result.value.revision } }))
}

/** A saved schedule change joins the Board's undo history. */
export function recordScheduleUndo(scope: ScheduleGetInput, previous: WorkflowSchedule | null,
  next: WorkflowSchedule, client: QueryClient) {
  const generation = sessionGeneration()
  const lineageKey = JSON.stringify([generation, scope.workspaceId, scope.workflowId])
  useBoardUndo.setState(state => ({ scheduleRevisions: { ...state.scheduleRevisions, [lineageKey]: next.revision } }))
  const actionId = crypto.randomUUID()
  let label = 'schedule change'
  if (!previous) label = 'schedule set'
  else if (!next.enabled && previous.enabled) label = 'schedule turned off'
  else if (next.enabled && !previous.enabled) label = 'schedule turned on'
  const restored = previous ?? { ...next, enabled: false, nextOccurrenceAt: null }
  recordBoardAction(boardScope(scope.workspaceId, scope.workflowId), {
    label,
    undo: () => restoreSchedule(scope, previous, next, client, lineageKey, generation, { actionId, direction: 'undo' }),
    redo: () => restoreSchedule(scope, next, restored, client, lineageKey, generation, { actionId, direction: 'redo' }),
  })
}
