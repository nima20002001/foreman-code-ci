import { enqueueGroupChatFact } from './groupChatFacts.js'
import { createHash } from 'node:crypto'
import {
  AgentConfigurationVersionSchema, AgentIdentitySchema, BoardApplicationReceiptSchema,
  BoardLifecycleFactSchema, BoardResultApplicationSchema, BoardResultSchema,
  type AgentIdentity, type BoardApplicationReceipt, type BoardLifecycleFact, type BoardResult,
  type ExecutionRef, type HarnessExecution, type LogicalWorkRef,
} from '@foreman-code/contracts'
import type { WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import type { RepeatRuntimeRun } from '../runs/repeatPostgres.js'
import { repeatTickIndex } from '../runs/repeatResolution.js'
import { workflowResultEffectConflict } from '../runs/workflowResultEffectFailure.js'
import { appendHierarchyReportLocked } from '../workflow-hierarchy/reports.js'
import type { MemoryBoardPort } from './ports.js'

export interface WorkflowCollaborationInput {
  run: RepeatRuntimeRun
  version: WorkflowVersionV3
  execution: HarnessExecution
  sourceEventKey: string
}
export interface WorkflowLifecycleInput extends WorkflowCollaborationInput {
  phase: BoardLifecycleFact['phase']
  outstandingRequestIds?: string[]
  reason?: string | null
  continuationOf?: LogicalWorkRef
  requestGroupId?: string
  controlContinuationId?: string
  previousExecution?: ExecutionRef
  summary?: string
}
export interface WorkflowResultInput extends WorkflowCollaborationInput { result: BoardResult; summary: string }
export interface WorkflowCollaborationHooks {
  lifecycleLocked(sql: GraphTransactionSql, input: WorkflowLifecycleInput): Promise<void>
  resultLocked(sql: GraphTransactionSql, input: WorkflowResultInput): Promise<void>
}
export type WorkflowCollaborationBinding = { agent: AgentIdentity; work: LogicalWorkRef; execution: ExecutionRef }

function conflict(message: string): never {
  throw new DomainError('COLLABORATION_WORK_PIN_CONFLICT', message, 409)
}

/** These hooks run only inside the mutation's existing Run transaction. They
 * never launch native work, open a pool transaction, or publish before COMMIT. */
export function createWorkflowCollaborationHooks(memoryBoards?: MemoryBoardPort): WorkflowCollaborationHooks {
  return {
    async lifecycleLocked(sql, input) {
      if ((!input.run.resultProtocol && !input.version.definition.hierarchy) || repeatTickIndex(input.execution.input) !== undefined) return
      assertGraphTransaction(sql)
      const binding = await readWorkflowCollaborationBindingLocked(sql, input)
      if (!binding) return
      const fact = BoardLifecycleFactSchema.parse({ ...binding, sourceEventKey: input.sourceEventKey,
        phase: input.phase, outstandingRequestIds: input.outstandingRequestIds ?? [], reason: input.reason ?? null,
        ...(input.continuationOf ? { continuationOf: input.continuationOf } : {}),
        ...(input.requestGroupId ? { requestGroupId: input.requestGroupId } : {}),
        ...(input.controlContinuationId ? { controlContinuationId: input.controlContinuationId } : {}),
        ...(input.previousExecution ? { previousExecution: input.previousExecution } : {}) })
      const receipt = input.run.resultProtocol && memoryBoards ? BoardApplicationReceiptSchema.parse(await memoryBoards.applyLifecycleLocked(sql, fact)) : undefined
      assertReceipt(receipt, fact.sourceEventKey)
      await projectLifecycleLocked(sql, input, fact, receipt)
    },
    async resultLocked(sql, input) {
      if (!input.run.resultProtocol) return
      assertGraphTransaction(sql)
      const result = BoardResultSchema.parse(input.result)
      const binding = await readWorkflowCollaborationBindingLocked(sql, input)
      if (!binding) {
        if (result.kind !== 'none' || result.appliedCommandIds?.length) {
          throw new DomainError('MEMORY_BOARD_UNAVAILABLE', 'This saved Agent has no collaboration identity.', 409)
        }
        return
      }
      const application = BoardResultApplicationSchema.parse({ execution: binding.execution, work: binding.work,
        subject: { kind: 'execution', agent: binding.agent, execution: binding.execution },
        sourceEventKey: input.sourceEventKey, result })
      let receipt: BoardApplicationReceipt | undefined
      if (memoryBoards) {
        try { receipt = BoardApplicationReceiptSchema.parse(await memoryBoards.applyResultLocked(sql, application)) }
        catch (error) {
          if (error instanceof DomainError && error.code === 'REVISION_CONFLICT' && error.status === 409
            && result.kind === 'changes' && result.operations.some(operation => operation.expectedRevision !== undefined)) {
            throw workflowResultEffectConflict({ execution: input.execution, subject: application.subject,
              work: application.work, error })
          }
          throw error
        }
      } else if (result.kind !== 'none' || result.appliedCommandIds?.length) {
        throw new DomainError('MEMORY_BOARD_UNAVAILABLE', 'Memory board effects are not installed.', 503)
      }
      assertReceipt(receipt, input.sourceEventKey)
      // Interval observations may carry board effects but do not create or complete a logical task claim.
      if (repeatTickIndex(input.execution.input) !== undefined) return
      const fact = BoardLifecycleFactSchema.parse({ ...binding,
        sourceEventKey: `${input.sourceEventKey}:awaiting-acceptance`, phase: 'awaiting_acceptance',
        outstandingRequestIds: [], reason: null })
      const lifecycleReceipt = memoryBoards && BoardApplicationReceiptSchema.parse(await memoryBoards.applyLifecycleLocked(sql, fact))
      assertReceipt(lifecycleReceipt, fact.sourceEventKey)
      await projectLifecycleLocked(sql, { ...input, phase: 'awaiting_acceptance' }, fact, receipt)
    },
  }
}

function assertReceipt(receipt: BoardApplicationReceipt | undefined | false, sourceEventKey: string) {
  if (receipt && receipt.sourceEventKey !== sourceEventKey) conflict('The board receipt belongs to another source event.')
}

export async function readWorkflowCollaborationBindingLocked(sql: GraphTransactionSql,
  input: WorkflowCollaborationInput): Promise<WorkflowCollaborationBinding | undefined> {
  const { run, version, execution } = input
  if (run.id !== execution.runId || run.workflowVersionId !== version.id || run.workspaceId !== version.workspaceId
    || run.workflowId !== version.workflowId || !input.sourceEventKey.trim()) conflict('The collaboration source is not the pinned Run.')
  const node = version.definition.nodes.find(candidate => candidate.id === execution.workflowNodeId)
  if (!node || node.kind === 'job') return undefined
  if (node.agentId !== execution.agentId || version.agentConfigurationVersionIds[node.agentId] !== execution.agentConfigurationVersionId) {
    conflict('The collaboration source is not the pinned Agent node.')
  }
  const row = (await sql.query<{ configuration: unknown; record: unknown; slot_id: string; activation_id: string | null }>(
    `select c.record as configuration,e.record,s.slot_id,s.work_activation_id as activation_id
      from harness_executions e join run_repeat_executions x on x.execution_id=e.id and x.run_id=e.run_id
      join run_repeat_slots s on s.slot_id=x.slot_id and s.run_id=e.run_id
      join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId'
      where e.id=$1 and e.run_id=$2 and c.workspace_id=$3`,
  [execution.id, run.id, run.workspaceId])).rows[0]
  if (!row || !sameWorkflowValue(row.record, execution)) conflict('The lifecycle callback must follow its exact persisted execution mutation.')
  const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
  if (configuration.id !== execution.agentConfigurationVersionId || configuration.agentId !== node.agentId) {
    conflict('The immutable Agent configuration changed.')
  }
  // Untouched historical configurations do not acquire an invented product role or newly enabled tools.
  if (!configuration.productRole) return undefined
  const agent = AgentIdentitySchema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId,
    workflowNodeId: node.id, agentId: node.agentId, productRole: configuration.productRole,
    displayName: node.name ?? node.label ?? node.id, configurationVersionId: configuration.id })
  const work: LogicalWorkRef = row.activation_id
    ? { kind: 'activation', runId: run.id, workflowVersionId: version.id, activationId: row.activation_id }
    : { kind: 'slot', runId: run.id, workflowVersionId: version.id, slotId: row.slot_id }
  return { agent, work, execution: { runId: run.id, workflowVersionId: version.id,
    executionId: execution.id, attempt: execution.attempt,
    ...(row.activation_id ? { activationId: row.activation_id } : {}) } }
}

const fallback: Record<BoardLifecycleFact['phase'], string> = {
  admitted: 'Work queued.', launched: 'Work started.', awaiting_acceptance: 'Processing result.',
  waiting_children: 'Waiting for delegated work.', accepted: 'Work accepted.',
  retry_admitted: 'Retrying the same work.', continuation_admitted: 'Continuing the same task.',
  blocked: 'Work is blocked.', failed: 'Work failed.', canceled: 'Work was canceled.',
}
function summaryFor(input: WorkflowLifecycleInput): string {
  const summary = input.summary?.trim() || input.reason?.trim() || fallback[input.phase]
  return Array.from(summary).slice(0, 600).join('')
}

async function projectLifecycleLocked(sql: GraphTransactionSql, input: WorkflowLifecycleInput,
  fact: BoardLifecycleFact, receipt?: BoardApplicationReceipt | false) {
  const summary = summaryFor(input)
  const reportIds: string[] = []
  const parent = input.version.definition.hierarchy?.parents.find(item => item.workflowNodeId === fact.agent.workflowNodeId)
  const state = reportState(fact.phase)
  if (parent && fact.work.kind === 'activation' && state) {
    const row = (await sql.query<{ request_id: string | null }>(
      'select work_parent_request($1,$2) as request_id', [fact.work.runId, fact.work.activationId])).rows[0]
    if (row?.request_id) {
      const id = `hierarchy-report-${createHash('sha256').update(fact.work.runId).update('\0').update(fact.sourceEventKey).digest('hex')}`
      const updatedAt = input.execution.finishedAt ?? input.execution.startedAt ?? input.execution.createdAt
      await appendHierarchyReportLocked(sql, { id, agent: fact.agent, execution: fact.execution!,
        parentNodeId: parent.parentNodeId, parentRequestId: row.request_id, state, summary,
        cardIds: receipt ? receipt.changedCardIds : [], sourceEventKey: fact.sourceEventKey, updatedAt })
      reportIds.push(id)
    }
  }
  // The existing committed activity stream is C's durable projection seam. No
  // native transcript, card body, provider handle, or transport work is copied here.
  const payload = { sourceEventKey: fact.sourceEventKey, fact, summary, reportIds,
    ...(receipt ? { boardApplicationId: receipt.applicationId } : {}) }
  await sql.query(`insert into run_activity(run_id,source,kind,occurred_at,payload,harness_execution_id)
    values($1,'backend','collaboration_lifecycle',$2::timestamptz,$3::jsonb,$4)
    on conflict(run_id,(payload->>'sourceEventKey'))
      where source='backend' and kind='collaboration_lifecycle' do nothing`,
  [input.run.id, input.execution.finishedAt ?? input.execution.startedAt ?? input.execution.createdAt, JSON.stringify(payload), input.execution.id])
  const retained = (await sql.query<{ payload: unknown }>(`select payload from run_activity
    where run_id=$1 and source='backend' and kind='collaboration_lifecycle' and payload->>'sourceEventKey'=$2`,
  [input.run.id, fact.sourceEventKey])).rows[0]
  if (!retained || !sameWorkflowValue(retained.payload, payload)) conflict('The committed lifecycle source already has different facts.')
  await enqueueGroupChatFact(sql, { kind: 'lifecycle', agent: fact.agent, fact, summary,
    sourceEventKey: fact.sourceEventKey,
    createdAt: input.execution.finishedAt ?? input.execution.startedAt ?? input.execution.createdAt })
}

function reportState(phase: BoardLifecycleFact['phase']) {
  if (phase === 'launched') return 'started' as const
  if (phase === 'accepted') return 'returned' as const
  if (phase === 'failed' || phase === 'canceled' || phase === 'blocked') return phase
  if (phase === 'waiting_children' || phase === 'awaiting_acceptance') return 'working' as const
  return undefined
}
