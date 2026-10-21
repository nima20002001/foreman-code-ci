import type { MaintenanceTask } from '@foreman-code/contracts/computer-maintenance'

const TASK_LABELS: Record<string, string> = { 'update-harnesses': 'Harness update', 'update-system': 'System update', restart: 'Restart',
  'sync-mcp': 'MCP sync', 'sync-plugins': 'Plugin sync', 'update-worker': 'Worker update', 'repair-browser': 'Browser repair' }
export function taskLabel(kind: string) { return TASK_LABELS[kind] ?? kind }

/** Known system and Worker codes in plain words. The raw text stays available for the tooltip. */
const KNOWN: { pattern: RegExp; text: string }[] = [
  { pattern: /\bEDQUOT\b|\berror -122\b|disk quota/iu, text: 'Disk quota exceeded' },
  { pattern: /\bENOSPC\b|\berror -28\b|no space left/iu, text: 'Disk is full' },
  { pattern: /\bEACCES\b|\bEPERM\b|\berror -13\b|permission denied/iu, text: 'Permission denied' },
  { pattern: /\bETIMEDOUT\b|\bECONNRESET\b|\bENOTFOUND\b|\bEAI_AGAIN\b/iu, text: 'Network connection failed' },
  { pattern: /worker_update_restart_pending/iu, text: 'Restarting to finish the update' },
]

/** Short human text for a maintenance summary or error; raw is set only when the text was translated. */
export function humanizeMaintenanceText(raw: string): { text: string; raw: string | undefined } {
  const known = KNOWN.find(entry => entry.pattern.test(raw))
  return known ? { text: known.text, raw } : { text: raw, raw: undefined }
}

/** The newest task of each kind, newest first. An older failure that a later task of the same kind replaced is dropped. */
export function newestTaskPerKind(tasks: readonly MaintenanceTask[]): MaintenanceTask[] {
  const seen = new Set<string>()
  return [...tasks].sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))
    .filter(task => !seen.has(task.kind) && seen.add(task.kind))
}
