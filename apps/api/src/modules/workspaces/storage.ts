import { homedir } from 'node:os'
import { join } from 'node:path'

/** Durable project data is separate from application code and harness runtime state. */
export function workspaceStorageRoot(): string {
  return join(homedir(), '.local', 'share', 'graphql', 'workspaces')
}
