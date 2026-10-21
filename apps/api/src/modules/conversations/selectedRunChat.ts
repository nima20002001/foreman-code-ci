import type { SqlQuery } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import type { HarnessExecution } from '@foreman-code/contracts'
import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import { RunBoardSnapshotSchema } from '@foreman-code/contracts/run-snapshots'
import type {
  ReadSelectedRunChatResponse, SelectedRunChatExecution, SelectedRunChatSelection, SelectedRunChatTarget,
} from '@foreman-code/contracts/selected-run-chat'
import { requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { DomainError } from '../errors.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import { agentChatKey, type AgentConversationRow } from './agentChatRepository.js'

type Queryable = Pick<pg.PoolClient, 'query'>
export type RunChatAuthorityCheck = (transaction?: pg.PoolClient) => Promise<void>
export type RunChatSelection = Exclude<ReadSelectedRunChatResponse, { kind: 'selected' }> | {
  kind: 'selected'; selection: SelectedRunChatExecution; context: AgentChatContext
}

export function staleRunChat(): never {
  throw new DomainError('AGENT_CHAT_CONTEXT_STALE', 'The supplied Run, node, execution and conversation do not identify the same chat.', 409)
}

/** A storage key is not authority. Preserve existing legacy keys when a matching row already exists. */
export function runChatStorageKey(context: AgentChatContext, executionId: string): string {
  if (!context.runId) staleRunChat()
  return JSON.stringify(['run-chat:v1', context.workspaceId, context.workflowId, context.runId,
    context.workflowNodeId, context.agentId, executionId])
}

/** Check BEFORE receipt lookup, native calls or command reservation. Null is only the first-send precondition. */
export function assertRunChatConversation(row: AgentConversationRow, context: AgentChatContext, executionId?: string,
  source?: HarnessExecution): void {
  if (row.workspace_id !== context.workspaceId || row.workflow_id !== context.workflowId
    || row.workflow_node_id !== context.workflowNodeId || row.agent_id !== context.agentId
    || row.origin_run_id !== (context.runId ?? null)) staleRunChat()
  const origin = row.record.origin
  if (!context.runId) {
    if (origin.kind !== 'fresh' || row.origin_execution_id !== null || executionId) staleRunChat()
    return
  }
  if (origin.kind !== 'run_execution' || !row.origin_execution_id || origin.runId !== context.runId
    || origin.executionId !== row.origin_execution_id || executionId && origin.executionId !== executionId) staleRunChat()
  if (source && (source.id !== origin.executionId || source.runId !== context.runId
    || source.workflowNodeId !== context.workflowNodeId || source.agentId !== context.agentId
    || source.agentConfigurationVersionId !== (row.record.sourceConfigurationVersionId ?? row.agent_configuration_version_id)
    || source.nativeSessionId && source.nativeSessionId !== origin.sourceNativeSessionId)) staleRunChat()
}

/** All physical scope/origin columns participate; never lookup a Run conversation by Agent alone. */
export async function findRunChatConversation(query: SqlQuery, context: AgentChatContext,
  executionId: string): Promise<AgentConversationRow | undefined> {
  if (!context.runId) staleRunChat()
  const rows = (await query.query<AgentConversationRow>(`
    select * from operator_conversations where kind='agent' and deleted_at is null
      and agent_key not like 'workflow-native-files:v1:%'
      and not coalesce((record->>'archived')::boolean, false)
      and workspace_id=$1 and workflow_id=$2 and origin_run_id=$3 and workflow_node_id=$4
      and agent_id=$5 and origin_execution_id=$6 order by id limit 2`,
  [context.workspaceId, context.workflowId, context.runId, context.workflowNodeId, context.agentId, executionId])).rows
  if (rows.length > 1) throw new DomainError('AGENT_CHAT_CONTEXT_STALE', 'This execution has more than one retained chat; no session was selected.', 409)
  const row = rows[0]
  if (row) {
    assertRunChatConversation(row, context, executionId)
    if (row.agent_key !== agentChatKey(context) && row.agent_key !== runChatStorageKey(context, executionId)) staleRunChat()
  }
  return row
}

/** Streaming, bounded projection. A missing session is NOT permission to select an older execution. */
export async function selectRunChatExecution(
  pages: AsyncIterable<HarnessExecution[]> | Iterable<HarnessExecution[]>,
  context: AgentChatContext, configurationVersionId: string, executionId?: string,
): Promise<{ executionId: string } | { executions: Array<{ executionId: string; attempt: number }>; hasMoreExecutions: boolean } | undefined> {
  let first: HarnessExecution | undefined
  let count = 0
  const choices: Array<{ executionId: string; attempt: number }> = []
  for await (const page of pages) {
    for (const execution of page) {
      if (executionId && execution.id !== executionId) continue
      if (execution.runId !== context.runId || execution.workflowNodeId !== context.workflowNodeId) {
        continue
      }
      if (execution.agentId !== context.agentId || execution.agentConfigurationVersionId !== configurationVersionId) staleRunChat()
      if (executionId) return { executionId: execution.id }
      first ??= execution
      count++
      if (choices.length < 100) choices.push({ executionId: execution.id, attempt: execution.attempt })
    }
  }
  if (executionId) throw new DomainError('RUN_CHAT_EXECUTION_NOT_FOUND', 'Execution not found in this Run and node.', 404)
  if (!first) return undefined
  if (count === 1) return { executionId: first.id }
  return { executions: choices, hasMoreExecutions: count > choices.length }
}

/** The immutable admission snapshot supplies Agent identity; today's workflow/Agent is never queried here. */
export async function resolveRunChatSelection(query: Queryable, runs: Pick<PostgresRunRepository, 'executionPages' | 'getExecution'>,
  input: SelectedRunChatSelection): Promise<RunChatSelection> {
  const target: SelectedRunChatTarget = { workspaceId: input.workspaceId, workflowId: input.workflowId,
    runId: input.runId, workflowNodeId: input.workflowNodeId }
  const row = (await query.query<{ workflow_version_id: string; snapshot_id: string | null; snapshot: unknown }>(`
    select r.workflow_version_id, s.run_id as snapshot_id, s.record as snapshot
    from runs r left join run_board_snapshots s on s.run_id=r.id
    where r.workspace_id=$1 and r.workflow_id=$2 and r.id=$3`,
  [input.workspaceId, input.workflowId, input.runId])).rows[0]
  if (!row) throw new DomainError('RUN_NOT_FOUND', 'Run not found in this workspace and workflow.', 404)
  if (row.snapshot_id === null) return { kind: 'unavailable', target, reason: 'legacy_run' }
  const parsed = RunBoardSnapshotSchema.safeParse(row.snapshot)
  if (!parsed.success || parsed.data.kind !== 'available') staleRunChat()
  const snapshot = parsed.data
  if (snapshot.workspaceId !== input.workspaceId || snapshot.workflowId !== input.workflowId
    || snapshot.runId !== input.runId || snapshot.workflowVersionId !== row.workflow_version_id) staleRunChat()
  const node = snapshot.nodes.find((entry) => entry.id === input.workflowNodeId)
  if (!node) throw new DomainError('RUN_CHAT_NODE_NOT_FOUND', 'Node not found in the selected Run snapshot.', 404)
  if (node.kind === 'job') return { kind: 'unavailable', target, reason: 'job_node' }
  const context: AgentChatContext = { ...target, agentId: node.agentId }
  const exact = input.executionId ? await runs.getExecution(input.executionId) : undefined
  const pages = input.executionId ? [exact ? [exact] : []] : runs.executionPages(input.runId)
  const selected = await selectRunChatExecution(pages, context, node.agentConfigurationVersionId, input.executionId)
  if (!selected) return { kind: 'unavailable', target, reason: 'execution_missing' }
  if ('executions' in selected) return { kind: 'execution_selection_required', target, ...selected }
  return { kind: 'selected', selection: { ...target, executionId: selected.executionId }, context }
}

/** Revalidate through the existing delegation reader. Do not hold a pool connection while
 * calling chat/Run services: those services acquire their own connections. A held outer
 * transaction would deadlock a saturated pool. Reads recheck before returning; message
 * admissions recheck on their transaction so authority locks survive its durable writes.
 * No authorization transaction spans native I/O. */
export async function withRunChatAuthority<T>(pool: pg.Pool, principal: ManagementPrincipal, target: SelectedRunChatTarget,
  actions: readonly ManagementAction[], work: (query: Queryable, assertCurrent: RunChatAuthorityCheck) => Promise<T>): Promise<T> {
  const authorize = (candidate: ManagementPrincipal) => {
    for (const action of actions) requireAuthorization(candidate, action, target)
  }
  const assertCurrent: RunChatAuthorityCheck = async (transaction) => {
    authorize(principal)
    if (transaction) {
      // The admission owner commits/releases this connection and its authority locks.
      const live = await readLiveManagementPrincipal(transaction, principal.id)
      authorize(principal); authorize(live)
      return
    }
    return withTransaction(pool, async (client) => {
      const live = await readLiveManagementPrincipal(client, principal.id)
      authorize(principal); authorize(live)
    })
  }
  await assertCurrent()
  const result = await work(pool, assertCurrent)
  if (actions.every((action) => action === 'agent_chat:read')) await assertCurrent()
  return result
}
