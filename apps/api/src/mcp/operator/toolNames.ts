/** Backend extension names: the frozen OperatorToolName enumeration predates file references. */
export const FILE_REFERENCE_TOOL_NAMES = [
  'reference_files_list', 'reference_file_read', 'reference_file_add', 'reference_file_remove',
] as const
export type FileReferenceToolName = typeof FILE_REFERENCE_TOOL_NAMES[number]

export const RUN_HISTORY_TOOLS = { list: 'run_summaries_list', snapshot: 'run_board_snapshot_get' } as const
export type RunHistoryToolName = typeof RUN_HISTORY_TOOLS[keyof typeof RUN_HISTORY_TOOLS]

export const WORKFLOW_SCHEDULE_TOOLS = [
  'workflow_schedule_get', 'workflow_schedule_save', 'workflow_schedule_enable',
  'workflow_schedule_disable', 'workflow_schedule_clear', 'workflow_schedule_occurrences_list',
] as const
export type WorkflowScheduleToolName = typeof WORKFLOW_SCHEDULE_TOOLS[number]
