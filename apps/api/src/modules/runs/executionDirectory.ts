import { isAbsolute, relative, resolve, sep } from 'node:path'

import { DomainError } from '../errors.js'

function segment(id: string): string {
  if (id.length === 0) throw new DomainError('HARNESS_WORKSPACE_INVALID', 'Execution IDs cannot be empty.', 400)
  try {
    // Encode the ID itself, not the complete path. Encoding dots also handles
    // the special "." and ".." segments while preserving normal UUID IDs.
    return encodeURIComponent(id).replaceAll('.', '%2E')
  } catch {
    throw new DomainError('HARNESS_WORKSPACE_INVALID', 'Execution IDs must contain valid Unicode.', 400)
  }
}

function isStrictDescendant(parent: string, child: string): boolean {
  const suffix = relative(parent, child)
  return suffix !== '' && suffix !== '..' && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix)
}

/** Lexical run-directory isolation; this is not a native-process sandbox. */
export function resolveExecutionDirectory(
  workspaceRoot: string,
  runId: string,
  nodeId: string,
  attempt: number,
  workspaceId?: string,
): string {
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw new DomainError('HARNESS_WORKSPACE_INVALID', 'The execution attempt must be a positive safe integer.', 400)
  }
  const root = resolve(workspaceRoot)
  const workspaceDirectory = workspaceId ? resolve(root, segment(workspaceId)) : root
  const runDirectory = resolve(workspaceDirectory, segment(runId))
  const directory = resolve(runDirectory, segment(nodeId), `attempt-${attempt}`)
  if ((workspaceId && !isStrictDescendant(root, workspaceDirectory))
    || !isStrictDescendant(workspaceDirectory, runDirectory)
    || !isStrictDescendant(runDirectory, directory)) {
    throw new DomainError('HARNESS_WORKSPACE_INVALID', 'Harness workspace escaped its run directory.', 500)
  }
  return directory
}
