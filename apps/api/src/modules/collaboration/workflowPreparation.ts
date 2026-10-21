import {
  AgentConfigurationVersionSchema, AgentSubjectSchema, BoardDigestSchema, effectiveGraphqlTools,
  type AgentSubject, type BoardDigest, type HarnessExecution, type LogicalWorkRef,
} from '@foreman-code/contracts'
import { AcceptedWorkflowRunV3Schema, type AcceptedWorkflowRunV3,
  type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { assertGraphTransaction, beforeGraphCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import type { RunOwnership } from '../runs/ownership.js'
import type { MemoryBoardPort } from './ports.js'
import { readWorkflowCollaborationBindingLocked } from './workflowHooks.js'

export interface WorkflowPreparationIdentity { subject: AgentSubject; work: LogicalWorkRef }

/** Run owner/fence and original execution identity are checked before and after
 * outside-transaction feature preparation. The persisted input is never edited. */
export async function withWorkflowPreparation<T>(owner: RunOwnership, execution: HarnessExecution,
  active: boolean, work: (sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
    state: { stopped: boolean; cleanup: boolean }) => Promise<T>): Promise<T> {
  owner.assertOwned()
  if (owner.runId !== execution.runId) throw new DomainError('GRAPH_SCOPE_MISMATCH', 'Preparation belongs to another Run.', 409)
  return owner.oneShotConnection().transaction(async sql => {
    const row = (await sql.query<{ record: unknown; stopped: boolean; cleanup: boolean }>(
      `select r.record,r.stop_requested_at is not null as stopped,
        exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup
        from runs r where r.id=$1 for update`, [execution.runId])).rows[0]
    if (!row) throw new DomainError('RUN_NOT_FOUND', 'The preparation Run is unavailable.', 404)
    const run = AcceptedWorkflowRunV3Schema.parse(row.record)
    if (active && (row.stopped || row.cleanup || !['queued', 'running', 'waiting'].includes(run.executionState))) {
      throw new DomainError('GRAPH_STOP_CONFLICT', 'The Run no longer admits preparation.', 409)
    }
    const stored = (await sql.query<{ record: unknown }>('select record from harness_executions where id=$1 and run_id=$2',
      [execution.id, execution.runId])).rows[0]
    if (!stored || !sameWorkflowValue(stored.record, execution)) {
      throw new DomainError('COLLABORATION_EXECUTION_CHANGED', 'The exact execution changed during preparation.', 409)
    }
    const fence = await owner.readOneShotFence(sql)
    beforeGraphCommit(sql, async () => {
      owner.assertOwned()
      if (!sameWorkflowValue(fence, await owner.readOneShotFence(sql))) {
        throw new DomainError('RUN_OWNERSHIP_LOST', 'The preparation owner changed.', 409)
      }
    })
    return work(sql, run, { stopped: row.stopped, cleanup: row.cleanup })
  })
}

export async function workflowPreparationIdentityLocked(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3,
  version: WorkflowVersionV3, execution: HarnessExecution): Promise<WorkflowPreparationIdentity | undefined> {
  assertGraphTransaction(sql)
  const binding = await readWorkflowCollaborationBindingLocked(sql, { run, version, execution,
    sourceEventKey: `execution:${execution.id}:collaboration-preparation` })
  return binding ? { subject: AgentSubjectSchema.parse({ kind: 'execution', agent: binding.agent,
    execution: binding.execution }), work: binding.work } : undefined
}

export async function retainWorkflowPreparationLocked(sql: GraphTransactionSql, execution: HarnessExecution,
  identity: WorkflowPreparationIdentity): Promise<void> {
  await sql.query(`insert into workflow_collaboration_preparations(execution_id,run_id,subject,work)
    values($1,$2,$3::jsonb,$4::jsonb) on conflict(execution_id) do nothing`,
  [execution.id, execution.runId, JSON.stringify(identity.subject), JSON.stringify(identity.work)])
  const row = (await sql.query<{ subject: unknown; work: unknown }>(
    'select subject,work from workflow_collaboration_preparations where execution_id=$1 and run_id=$2',
    [execution.id, execution.runId])).rows[0]
  if (!row || !sameWorkflowValue(row.subject, identity.subject) || !sameWorkflowValue(row.work, identity.work)) {
    throw new DomainError('COLLABORATION_WORK_PIN_CONFLICT', 'Preparation identity differs from the admitted work.', 409)
  }
}

/** One bounded snapshot per logical work item, including technical retries.
 * Recovery never merges board content into input or fetches the complete board. */
export class WorkflowMemoryContext {
  constructor(private readonly memoryBoards?: MemoryBoardPort) {}

  async prepare(owner: RunOwnership, run: AcceptedWorkflowRunV3, version: WorkflowVersionV3,
    execution: HarnessExecution): Promise<void> {
    if (!this.memoryBoards) return
    const identity = await withWorkflowPreparation(owner, execution, true, async (sql, actualRun) => {
      if (actualRun.workflowVersionId !== run.workflowVersionId) {
        throw new DomainError('RUN_PIN_CONFLICT', 'The memory context Run version changed.', 409)
      }
      const node = version.definition.nodes.find(item => item.id === execution.workflowNodeId)
      if (!node || node.kind === 'job') return undefined
      const row = (await sql.query<{ record: unknown }>('select record from agent_configuration_versions where id=$1',
        [execution.agentConfigurationVersionId])).rows[0]
      if (!row) throw new DomainError('AGENT_CONFIGURATION_NOT_FOUND', 'The saved Agent is unavailable.', 409)
      const configuration = AgentConfigurationVersionSchema.parse(row.record)
      if (!configuration.productRole || !effectiveGraphqlTools(configuration.productRole,
        configuration.graphqlTools, node.graphqlTools, false, ['memory_board_get']).includes('memory_board_get')) return undefined
      const identity = await workflowPreparationIdentityLocked(sql, actualRun, version, execution)
      if (!identity) return undefined
      await retainWorkflowPreparationLocked(sql, execution, identity)
      const prepared = (await sql.query<{ board_digest: unknown }>(
        `select board_digest from workflow_collaboration_preparations
          where run_id=$1 and work=$2::jsonb and subject->'agent'=$3::jsonb and board_digest is not null
          order by execution_id limit 1`,
      [execution.runId, JSON.stringify(identity.work), JSON.stringify(identity.subject.agent)])).rows[0]
      if (!prepared) return identity
      const digest = BoardDigestSchema.parse(prepared.board_digest)
      await sql.query(`update workflow_collaboration_preparations set board_digest=$2::jsonb
        where execution_id=$1 and board_digest is null`, [execution.id, JSON.stringify(digest)])
      return undefined
    })
    if (!identity) return
    const digest = BoardDigestSchema.parse(await this.memoryBoards.readDigest(identity))
    owner.assertOwned()
    await withWorkflowPreparation(owner, execution, true, async sql => {
      await retainWorkflowPreparationLocked(sql, execution, identity)
      await sql.query(`update workflow_collaboration_preparations set board_digest=$2::jsonb
        where execution_id=$1 and board_digest is null`, [execution.id, JSON.stringify(digest)])
    })
  }

  async readPrompt(owner: RunOwnership, execution: HarnessExecution): Promise<string | undefined> {
    if (!this.memoryBoards) return undefined
    return withWorkflowPreparation(owner, execution, false,
      sql => readWorkflowCollaborationPromptLocked(sql, execution.id))
  }
}

export async function readWorkflowCollaborationPromptLocked(sql: GraphTransactionSql,
  executionId: string): Promise<string | undefined> {
  const row = (await sql.query<{ board_digest: unknown }>(
    'select board_digest from workflow_collaboration_preparations where execution_id=$1', [executionId])).rows[0]
  return row?.board_digest ? workflowMemoryDigestPrompt(BoardDigestSchema.parse(row.board_digest)) : undefined
}

export function workflowMemoryDigestPrompt(digest: BoardDigest): string | undefined {
  const bounded = BoardDigestSchema.parse(digest)
  if (!bounded.text) return undefined
  return ['Shared memory board snapshot (bounded context; use scoped tools for current facts):', bounded.text,
    ...(bounded.omittedCount ? [`${bounded.omittedCount} additional items are omitted.`] : [])].join('\n')
}
