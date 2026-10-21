import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { MaintenanceTaskStart } from '@foreman-code/contracts/computer-maintenance'

export function syncFingerprint(task: MaintenanceTaskStart): string {
  // Retained MCP successes must be re-delivered once when destination executable validation changes.
  if (task.kind === 'sync-mcp') return commandInputHash({ task, validation: 'destination-script-operands' })
  return commandInputHash(task)
}
