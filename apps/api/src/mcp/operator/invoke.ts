import type { FileReferenceToolName, RunHistoryToolName, WorkflowScheduleToolName } from './toolNames.js'
import type { WORKFLOW_HIERARCHY_TOOLS } from '@foreman-code/contracts'
import type { RunInspectionToolName } from '@foreman-code/contracts/wave25'
import type { ManagementAction, OperatorToolName } from '@foreman-code/contracts/management'

import { DomainError, databaseReadFailure } from '../../modules/errors.js'
import { componentLogger } from '../../infrastructure/logger.js'
import { toolFailure, toolResult } from '../shared/results.js'
import type { OperatorRequestContext } from './types.js'
import { deviceBusyFailure } from '../../modules/devices/deviceBusyError.js'
import { asForegroundWork } from '../../modules/devices/deviceRequestQueue.js'

export function logOperatorToolFailure(name: string, error: unknown): void {
  if (error instanceof DomainError) return
  const diagnostic = error as { code?: unknown; stack?: unknown } | null
  const code = diagnostic?.code
  const databaseException = error instanceof Error && code === 'PGC02'
    && /^CURRENT_[A-Z_]{1,56}$/.test(error.message) ? error.message : undefined
  componentLogger('engine').error({
    tool: name,
    errorType: error instanceof Error ? error.constructor.name : typeof error,
    ...(typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? { errorCode: code } : {}),
    ...(databaseException ? { databaseException } : {}),
    ...(typeof diagnostic?.stack === 'string'
      ? { stackFrames: diagnostic.stack.split('\n').filter(line => /^\s+at\s/.test(line)).slice(0, 8) } : {}),
  }, 'Operator tool failed')
}

export async function invokeOperatorTool(
  context: OperatorRequestContext,
  name: OperatorToolName | RunInspectionToolName | FileReferenceToolName | WorkflowScheduleToolName | RunHistoryToolName
    | typeof WORKFLOW_HIERARCHY_TOOLS[keyof typeof WORKFLOW_HIERARCHY_TOOLS],
  work: () => Promise<unknown>,
  /** The tool's registry action (catalog.ts). A failed read is classified as a retryable read failure. */
  action?: ManagementAction,
) {
  try { return toolResult(await asForegroundWork(work)) } catch (caughtError) {
    let error = deviceBusyFailure(caughtError)
    logOperatorToolFailure(name, error)
    if (action?.endsWith(':read')) error = databaseReadFailure(error)
    if (error instanceof DomainError && error.status === 403 && !error.denialAudited) {
      await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
    }
    return toolFailure(error)
  }
}
