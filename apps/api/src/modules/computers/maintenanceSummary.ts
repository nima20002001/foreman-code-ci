import {
  DEFAULT_MAINTENANCE_TASK_LIMIT,
  type ComputerMaintenanceList, type ComputerMaintenanceOperatorList, type ComputerMaintenanceOperatorListInput,
} from '@foreman-code/contracts/computer-maintenance'

/** Queued tasks use the running state until their predecessor finishes. */
export function maintenanceHistoryResult(
  result: ComputerMaintenanceList,
  input: Pick<ComputerMaintenanceOperatorListInput, 'taskLimit' | 'taskId'>,
): ComputerMaintenanceList {
  const taskLimit = input.taskLimit ?? DEFAULT_MAINTENANCE_TASK_LIMIT
  return { computers: result.computers.map(computer => {
    if (!computer.status) return computer
    const status = computer.status
    const tasks = [...status.tasks]
      .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
      .filter((task, index) => input.taskId
        ? task.id === input.taskId
        : index < taskLimit || task.state === 'running')
    return { ...computer, tasksOmitted: computer.tasksOmitted + status.tasks.length - tasks.length,
      status: { ...status, tasks } }
  }) }
}

export function maintenanceReadResult(
  result: ComputerMaintenanceList,
  input: ComputerMaintenanceOperatorListInput,
): ComputerMaintenanceOperatorList {
  const selected = maintenanceHistoryResult(result, input)
  if (input.detail === 'full') return selected
  return { computers: selected.computers.map(computer => {
    if (!computer.status) return computer
    const tasks = computer.status.tasks.map(({ outputTail: _outputTail, ...task }) => {
      void _outputTail
      return { ...task, summary: task.summary.length > 300 ? `${task.summary.slice(0, 299)}…` : task.summary }
    })
    return { ...computer, status: { ...computer.status, tasks } }
  }) }
}
