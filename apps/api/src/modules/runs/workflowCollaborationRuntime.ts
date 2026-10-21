import type { HarnessExecution, WorkflowControlContinuation } from '@foreman-code/contracts'
import { WorkActivationInputSchema, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import type { WorkflowLifecycleInput } from '../collaboration/workflowHooks.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { RepeatLockedHooks } from './repeatPostgres.js'
import type { RepeatNativeChange } from './repeatNativeRepository.js'
import { repeatConflict, repeatDigest, repeatTickIndex } from './repeatResolution.js'
import { parseWorkflowCoordinationResult } from './workflowCoordinationResult.js'
import { readWorkResultContextLocked } from './workReturnValidation.js'
import { readWorkflowControlDispositionLocked } from '../collaboration/workflowControlDisposition.js'

type Context = { sql: GraphTransactionSql; version: WorkflowVersionV3; hooks: RepeatLockedHooks }

export async function workflowLifecycleLocked(context: Context, execution: HarnessExecution,
  phase: WorkflowLifecycleInput['phase'], sourceEventKey: string,
  details: Pick<WorkflowLifecycleInput, 'reason' | 'summary' | 'continuationOf' | 'requestGroupId'
    | 'outstandingRequestIds' | 'controlContinuationId' | 'previousExecution'> = {}): Promise<void> {
  if (!context.hooks.run.resultProtocol && !context.version.definition.hierarchy) return
  const control = await readWorkflowControlDispositionLocked(context.sql, execution.runId, execution.id)
  if (control.kind === 'superseded' && !['failed', 'canceled'].includes(control.continuation.state)) return
  const hook = context.hooks.collaboration
  if (!hook) return repeatConflict('COLLABORATION_HOOKS_UNAVAILABLE')
  await hook.lifecycleLocked(context.sql, { run: context.hooks.run, version: context.version, execution,
    sourceEventKey, phase, ...details })
}

/** input.bind is the one claim/transfer authority for a real execution. */
export async function workflowAdmissionLifecycleLocked(context: Context, execution: HarnessExecution,
  previousExecutionId: string | null, controlContinuation?: WorkflowControlContinuation): Promise<void> {
  if (!context.hooks.run.resultProtocol && !context.version.definition.hierarchy) return
  if (controlContinuation) {
    if (controlContinuation.previousExecution.executionId !== previousExecutionId) return repeatConflict('CONTROL_SUCCESSOR_CONFLICT')
    await workflowLifecycleLocked(context, execution, 'continuation_admitted', `workflow:${execution.id}:admitted`, {
      continuationOf: controlContinuation.work, controlContinuationId: controlContinuation.id,
      previousExecution: controlContinuation.previousExecution,
    })
    return
  }
  const input = context.version.definition.handoffs && repeatTickIndex(execution.input) === undefined
    ? WorkActivationInputSchema.parse(execution.input) : undefined
  const work = input?.work
  const previousActivationId = work?.kind === 'hierarchy_group' ? work.group.parentActivationId
    : work?.kind === 'hierarchy_direction' ? work.direction.sourceActivationId : undefined
  const continuationOf = previousActivationId ? { kind: 'activation' as const, runId: execution.runId,
    workflowVersionId: context.version.id, activationId: previousActivationId } : undefined
  await workflowLifecycleLocked(context, execution, previousExecutionId ? 'retry_admitted' : 'admitted',
    `workflow:${execution.id}:admitted`, { ...(continuationOf ? { continuationOf } : {}),
      ...(work?.kind === 'hierarchy_group' ? { requestGroupId: work.group.groupId } : {}) })
  if (work?.kind === 'hierarchy_direction') {
    await workflowLifecycleLocked(context, execution, 'blocked', `workflow:${execution.id}:direction-wait`, {
      reason: 'Waiting for direction on unresolved findings.', summary: work.direction.summary,
      ...(continuationOf ? { continuationOf } : {}),
    })
  }
}

/** Called after the native mutation, before its transaction commits. Native
 * success and its board effects remain factual if later work admission fails. */
export async function workflowNativeLifecycleLocked(context: Context, change: RepeatNativeChange): Promise<void> {
  if (!context.hooks.run.resultProtocol && !context.version.definition.hierarchy) return
  const { next: execution, previous } = change
  const control = await readWorkflowControlDispositionLocked(context.sql, execution.runId, execution.id)
  // Supersession is permanent even when the reserved successor later fails.
  // An old native success can never acquire a new structured effect or return.
  if (control.kind === 'superseded' || control.kind === 'stopping') return
  if (change.kind === 'launch') {
    await workflowLifecycleLocked(context, execution, 'launched', `workflow:${execution.id}:launched`)
  }
  if (execution.state !== 'completed' || previous.state === 'completed' || !execution.result) return
  if (execution.result.outcome === 'succeeded') {
    if (!context.hooks.run.resultProtocol) return // Hierarchy routing does not enable structured board effects.
    const node = context.version.definition.nodes.find(item => item.id === execution.workflowNodeId)
    if (!node || node.kind === 'job') return
    const interval = repeatTickIndex(execution.input) !== undefined
    const work = context.version.definition.handoffs && !interval ? WorkActivationInputSchema.parse(execution.input) : undefined
    const executionContext = work ? await readWorkResultContextLocked({ sql: context.sql, scope: work.work.activation.scope },
      work.work.activation.activationId, execution.input, context.hooks.run.resultProtocol) : undefined
    const parsed = parseWorkflowCoordinationResult(execution.result, { resultProtocol: context.hooks.run.resultProtocol,
      definition: context.version.definition, workflowNodeId: execution.workflowNodeId, interval }, execution.input, executionContext)
    const hook = context.hooks.collaboration
    if (!hook) return repeatConflict('COLLABORATION_HOOKS_UNAVAILABLE')
    await hook.resultLocked(context.sql, { run: context.hooks.run, version: context.version, execution,
      sourceEventKey: `workflow:${execution.id}:result:${repeatDigest(execution.result, 64 * 1024)}`,
      result: parsed.board, summary: parsed.summary })
  } else {
    await workflowLifecycleLocked(context, execution, execution.result.outcome === 'canceled' ? 'canceled' : 'failed',
      `workflow:${execution.id}:terminal:${repeatDigest(execution.result, 64 * 1024)}`, {
        reason: execution.result.error?.message || (execution.result.outcome === 'canceled' ? 'Work was canceled.' : 'Work failed.'),
      })
  }
}
