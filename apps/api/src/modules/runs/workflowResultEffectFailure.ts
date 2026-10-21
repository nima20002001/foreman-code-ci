import { parseCoordinationResult, type AgentSubject, type ExecutionResult, type HarnessExecution,
  type LogicalWorkRef, type ResultProtocol } from '@foreman-code/contracts'
import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { repeatDigest, repeatExecutionIdentity, repeatTickIndex, sameRepeatValue } from './repeatResolution.js'
import { readWorkResultRepairAttempt } from './workResultRepair.js'

interface EffectFailurePins {
  runId: string
  execution: ReturnType<typeof repeatExecutionIdentity>
  resultDigest: string
  subject: AgentSubject
  work: LogicalWorkRef
}
const issued = new WeakMap<object, EffectFailurePins>()

/** A real failed F1 application, retained only across its rolled-back terminal
 * transaction. This is not an HTTP input or caller-authored failure reason. */
class WorkflowResultEffectConflictError extends DomainError {
  constructor(pins: EffectFailurePins, cause: DomainError) {
    super('WORKFLOW_BOARD_EFFECT_CONFLICT',
      'The result could not apply its supplied board revision. Correct it against the current board state.',
      409, undefined, { cause })
    issued.set(this, structuredClone(pins))
  }

  get subject(): AgentSubject { return structuredClone(issued.get(this)!.subject) }
  get work(): LogicalWorkRef { return structuredClone(issued.get(this)!.work) }
}
export type WorkflowResultEffectFailure = WorkflowResultEffectConflictError

/** Called only by the terminal effects adapter after F1 rejected its atomic
 * batch. Other 409s (scope, identity, disabled tools) are never repair tokens. */
export function workflowResultEffectConflict(input: {
  execution: HarnessExecution; subject: AgentSubject; work: LogicalWorkRef; error: DomainError
}): WorkflowResultEffectFailure {
  if (input.error.status !== 409 || input.error.code !== 'REVISION_CONFLICT'
    || input.execution.state !== 'completed' || input.execution.result?.outcome !== 'succeeded') throw input.error
  return new WorkflowResultEffectConflictError({ runId: input.execution.runId,
    execution: repeatExecutionIdentity(input.execution), resultDigest: repeatDigest(input.execution.result, 64 * 1024),
    subject: input.subject, work: input.work }, input.error)
}

export function isWorkflowResultEffectFailure(error: unknown): error is WorkflowResultEffectFailure {
  return typeof error === 'object' && error !== null && issued.has(error)
}

/** Native proof separately verifies the original provider result. This only
 * authorizes its derived failure after the same two corrective turns are spent. */
export function verifiedWorkflowResultEffectFailure(token: WorkflowResultEffectFailure,
  execution: HarnessExecution): ExecutionResult {
  const pins = issued.get(token)
  if (!pins || execution.runId !== pins.runId || execution.state !== 'completed'
    || execution.result?.outcome !== 'succeeded'
    || !sameRepeatValue(repeatExecutionIdentity(execution), pins.execution)
    || repeatDigest(execution.result, 64 * 1024) !== pins.resultDigest) {
    throw new DomainError('WORKFLOW_BOARD_EFFECT_FAILURE_CONFLICT', 'The failed board application belongs to another native result.', 409)
  }
  return { outcome: 'failed', error: { code: 'WORKFLOW_BOARD_EFFECT_CONFLICT',
    message: 'The complete result still conflicts with the supplied board revision after two corrective turns.', retryable: false } }
}

export async function readWorkflowResultEffectFailureLocked(sql: GraphSqlClient,
  version: WorkflowVersionV3, execution: HarnessExecution, resultProtocol: ResultProtocol | undefined,
  token?: WorkflowResultEffectFailure): Promise<ExecutionResult | undefined> {
  if (!token) return undefined
  const failure = verifiedWorkflowResultEffectFailure(token, execution)
  if (!resultProtocol || await readWorkResultRepairAttempt(sql, execution.id) !== 2) {
    throw new DomainError('WORKFLOW_BOARD_EFFECT_REPAIR_PENDING', 'The exact result still has corrective turns available.', 409)
  }
  const result = parseCoordinationResult(execution.result!.output, { resultProtocol,
    definition: version.definition, workflowNodeId: execution.workflowNodeId,
    interval: repeatTickIndex(execution.input) !== undefined })
  if (result.board.kind !== 'changes' || !result.board.operations.some(operation => operation.expectedRevision !== undefined)) {
    throw new DomainError('WORKFLOW_BOARD_EFFECT_FAILURE_CONFLICT', 'A revision failure requires the original supplied revision.', 409)
  }
  return failure
}
