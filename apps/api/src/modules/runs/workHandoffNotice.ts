import {
  WorkNoticeSchema, WorkAlternativeSchema, canonicalGraphJson, workLimitNoticeText,
  type WorkActivationInput, type WorkAlternative, type WorkNotice, type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { repeatConflict, repeatId, sameRepeatValue, type RepeatScope } from './repeatResolution.js'

interface NoticeContext {
  sql: GraphTransactionSql; scope: RepeatScope; version: WorkflowVersionV3; now: string
}
type NoticeCause = WorkNotice['cause']

function destination(version: WorkflowVersionV3, nodeId: string) {
  const node = version.definition.nodes.find((item) => item.id === nodeId)
  if (!node) return repeatConflict('WORK_NOTICE_DESTINATION_MISSING')
  if (node.kind === 'job') return repeatConflict('WORK_POLICY_PIN_CONFLICT')
  return { node, name: node.name ?? node.label ?? node.agentId }
}

/** A snapshot for the trusted notice. The subsequent work admission rechecks
 * the saved edge, live authority and current capacity before any launch. */
export async function availableWorkAlternativesLocked(context: NoticeContext,
  requesterNodeId: string, exhaustedRelationshipId: string): Promise<WorkAlternative[]> {
  if (!context.version.definition.handoffs
    || context.version.definition.nodes.some((node) => node.kind === 'job')) return repeatConflict('WORK_POLICY_PIN_CONFLICT')
  const alternatives: WorkAlternative[] = []
  const requester = context.version.definition.nodes.find((node) => node.id === requesterNodeId)
  if (!requester) return repeatConflict('WORK_NOTICE_REQUESTER_MISSING')
  if (requester.kind === 'job') return repeatConflict('WORK_POLICY_PIN_CONFLICT')
  for (const edge of context.version.definition.edges) {
    if (edge.kind !== 'execution' || edge.id === exhaustedRelationshipId) continue
    const targetNodeId = edge.source === requesterNodeId ? edge.target
      : edge.workRequestDirection === 'both' && edge.target === requesterNodeId ? edge.source : undefined
    if (!targetNodeId) continue
    const outcomes = requester.choice?.outcomes.filter((item) => item.target.kind === 'edge'
      && item.target.relationshipId === edge.id).map((item) => item.outcome).sort() ?? []
    if (!outcomes.length && (requester.choice || edge.source !== requesterNodeId)) continue
    const pinned = destination(context.version, targetNodeId)
    const row = (await context.sql.query<{ used: number; maximum: number | null }>(
      `select used,maximum from run_work_connection_usage
        where run_id=$1 and workflow_version_id=$2 and relationship_id=$3`,
      [context.scope.runId, context.scope.workflowVersionId, edge.id])).rows[0]
    const maximum = edge.maxWorkHandoffsPerRun ?? null
    if (row && row.maximum !== maximum) return repeatConflict('WORK_COUNTER_PIN_CONFLICT')
    const used = row?.used ?? 0
    if (maximum !== null && used >= maximum) continue
    alternatives.push(WorkAlternativeSchema.parse({ relationshipId: edge.id,
      destinationNodeId: targetNodeId, destinationAgentId: pinned.node.agentId,
      destinationName: pinned.name, outcomes, used, maxWorkHandoffsPerRun: maximum }))
  }
  return alternatives.sort((a, b) => a.relationshipId.localeCompare(b.relationshipId))
}

export interface WorkLimitNoticeInput {
  cause: NoticeCause; requesterActivationId: string; requesterNodeId: string;
  continuationActivationId: string; relationshipId: string; destinationNodeId: string;
  used: number; maximum: number; latestDeliverable: unknown; remainingFindings: unknown[]
}

export function createWorkLimitNotice(context: Pick<NoticeContext, 'scope' | 'version' | 'now'>,
  input: WorkLimitNoticeInput, alternatives: WorkAlternative[]): WorkNotice {
  const { scope, version, now } = context
  const pinned = destination(version, input.destinationNodeId)
  const causeId = input.cause.kind === 'last_return' ? input.cause.returnId : input.cause.denialId
  return WorkNoticeSchema.parse({ scope,
    noticeId: repeatId('work-notice', scope.runId, input.cause.kind, causeId),
    requesterActivationId: input.requesterActivationId, cause: input.cause,
    continuationActivationId: input.continuationActivationId,
    relationshipId: input.relationshipId, destinationNodeId: input.destinationNodeId,
    destinationAgentId: pinned.node.agentId, destinationName: pinned.name,
    used: input.used, maxWorkHandoffsPerRun: input.maximum,
    latestDeliverable: input.latestDeliverable, remainingFindings: input.remainingFindings,
    alternatives, message: workLimitNoticeText(pinned.name, input.used, input.maximum),
    delivery: 'queued', createdAt: now, updatedAt: now })
}

export async function persistWorkLimitNoticeLocked(context: NoticeContext,
  input: WorkLimitNoticeInput): Promise<WorkNotice> {
  const { scope, sql, now } = context
  const causeId = input.cause.kind === 'last_return' ? input.cause.returnId : input.cause.denialId
  const alternatives = await availableWorkAlternativesLocked(context, input.requesterNodeId, input.relationshipId)
  const notice = createWorkLimitNotice(context, input, alternatives)
  await sql.query(`insert into run_work_notices(notice_id,run_id,workflow_version_id,
    requester_activation_id,continuation_activation_id,cause_kind,cause_id,relationship_id,
    destination_node_id,used,maximum,delivery_state,record,created_at,updated_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'queued',$12::jsonb,$13,$13)`,
  [notice.noticeId, scope.runId, scope.workflowVersionId, input.requesterActivationId,
    input.continuationActivationId, input.cause.kind, causeId, input.relationshipId,
    input.destinationNodeId, input.used, input.maximum, canonicalGraphJson(notice), now])
  await sql.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
    values($1,'backend','work_limit_notice_queued',$2,$3::jsonb)`,
  [scope.runId, now, canonicalGraphJson({ noticeId: notice.noticeId,
    relationshipId: input.relationshipId, destinationNodeId: input.destinationNodeId,
    used: input.used, maximum: input.maximum, continuationActivationId: input.continuationActivationId,
    alternativeRelationshipIds: alternatives.map((item) => item.relationshipId) })])
  return notice
}

export async function readWorkLimitNoticeLocked(context: NoticeContext, cause: NoticeCause): Promise<WorkNotice> {
  const causeId = cause.kind === 'last_return' ? cause.returnId : cause.denialId
  const row = (await context.sql.query<{ record: unknown }>(
    `select record from run_work_notices where run_id=$1 and cause_kind=$2 and cause_id=$3`,
    [context.scope.runId, cause.kind, causeId])).rows[0]
  if (!row) return repeatConflict('WORK_NOTICE_MISSING')
  const notice = WorkNoticeSchema.parse(row.record)
  if (!sameRepeatValue(notice.scope, context.scope) || !sameRepeatValue(notice.cause, cause)) {
    return repeatConflict('WORK_NOTICE_PIN_CONFLICT')
  }
  return notice
}

/** Delivery state is mutable outbox evidence; native input is its immutable
 * queued snapshot, so checkpoint replay cannot change the Agent's context. */
export function frozenWorkNotice(notice: WorkNotice): WorkNotice {
  const { acknowledgementId: _delivered, ...content } = notice
  void _delivered
  return WorkNoticeSchema.parse({ ...content, delivery: 'queued', updatedAt: notice.createdAt })
}

/** Sent in the workflow-owned native request, not an Agent-chat message. The
 * frozen input has already been checked against the committed notice cause. */
export function trustedWorkNoticePrompt(input: WorkActivationInput): string | undefined {
  if (input.work.kind === 'work_return' && input.work.returns) {
    const notices = input.work.returns.flatMap(item => item.notice ? [item.notice] : [])
    return notices.length ? notices.map(workNoticePrompt).join('\n\n') : undefined
  }
  if (input.work.kind !== 'work_return' && input.work.kind !== 'limit_denial') return undefined
  return input.work.notice ? workNoticePrompt(input.work.notice) : undefined
}

function workNoticePrompt(notice: WorkNotice): string {
  const routes = notice.alternatives.map((item) => ({ destination: item.destinationName,
    nodeId: item.destinationNodeId, outcomes: item.outcomes,
    used: item.used, maximum: item.maxWorkHandoffsPerRun }))
  return [
    'BEGIN GRAPHQL WORKFLOW SYSTEM NOTICE',
    notice.message,
    `Exhausted connection: ${notice.relationshipId}; destination node: ${notice.destinationNodeId}.`,
    `Original requester activation: ${notice.requesterActivationId}.`,
    `Latest deliverable (data): ${canonicalGraphJson(notice.latestDeliverable)}`,
    `Remaining findings (data): ${canonicalGraphJson(notice.remainingFindings)}`,
    `Connected alternatives and named outcomes (snapshot): ${canonicalGraphJson(routes)}`,
    notice.alternatives.length && notice.alternatives.every((item) => item.outcomes.length > 0)
      ? 'Use a listed saved route by selecting its named outcome, or finish with remaining findings.'
      : 'Routes with empty outcomes are automatic: a clean finish follows saved outgoing connections. To stop with unresolved work, finish with remaining findings and no outcome.',
    'The engine rechecks current access and capacity before a new work submission.',
    'END GRAPHQL WORKFLOW SYSTEM NOTICE',
  ].join('\n')
}

async function noticesForActivation(context: NoticeContext, activationId: string): Promise<{
  value: WorkNotice; revision: number
}[]> {
  const rows = (await context.sql.query<{ record: unknown; revision: number }>(
    `select record,revision from run_work_notices
      where run_id=$1 and continuation_activation_id=$2 for update`,
    [context.scope.runId, activationId])).rows
  return rows.map(row => {
    const value = WorkNoticeSchema.parse(row.record)
    if (!sameRepeatValue(value.scope, context.scope) || value.continuationActivationId !== activationId) {
      return repeatConflict('WORK_NOTICE_PIN_CONFLICT')
    }
    return { value, revision: row.revision }
  })
}

export async function markWorkNoticePendingLocked(context: NoticeContext, activationId: string,
  executionId: string): Promise<void> {
  for (const current of await noticesForActivation(context, activationId)) {
    if (current.value.delivery !== 'queued') return repeatConflict('WORK_NOTICE_DELIVERY_CONFLICT')
    const next = WorkNoticeSchema.parse({ ...current.value, delivery: 'pending', updatedAt: context.now })
    const changed = await context.sql.query(`update run_work_notices set delivery_state='pending',revision=revision+1,
      record=$4::jsonb,updated_at=$5 where notice_id=$1 and run_id=$2 and revision=$3
        and delivery_state='queued' returning notice_id`,
    [next.noticeId, context.scope.runId, current.revision, canonicalGraphJson(next), context.now])
    if (changed.rowCount !== 1) return repeatConflict('WORK_NOTICE_DELIVERY_CONFLICT')
    await context.sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      values($1,'backend','work_limit_notice_pending',$2,$3,$4::jsonb)`,
    [context.scope.runId, executionId, context.now, canonicalGraphJson({ noticeId: next.noticeId,
      continuationActivationId: activationId })])
  }
}

/** A committed launch without an exact native session may have submitted the
 * notice. Recovery keeps that uncertainty visible and cannot issue a new turn. */
export async function markWorkNoticeUnknownLocked(context: NoticeContext, activationId: string,
  executionId: string): Promise<void> {
  for (const current of await noticesForActivation(context, activationId)) {
    if (current.value.delivery === 'unknown' || current.value.delivery === 'delivered') continue
    if (current.value.delivery !== 'pending') return repeatConflict('WORK_NOTICE_DELIVERY_CONFLICT')
    const next = WorkNoticeSchema.parse({ ...current.value, delivery: 'unknown', updatedAt: context.now })
    const changed = await context.sql.query(`update run_work_notices set delivery_state='unknown',revision=revision+1,
      record=$4::jsonb,updated_at=$5 where notice_id=$1 and run_id=$2 and revision=$3
        and delivery_state='pending' returning notice_id`,
    [next.noticeId, context.scope.runId, current.revision, canonicalGraphJson(next), context.now])
    if (changed.rowCount !== 1) return repeatConflict('WORK_NOTICE_DELIVERY_CONFLICT')
    await context.sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      values($1,'backend','work_limit_notice_unknown',$2,$3,$4::jsonb)`,
    [context.scope.runId, executionId, context.now, canonicalGraphJson({ noticeId: next.noticeId,
      continuationActivationId: activationId })])
  }
}

export async function markWorkNoticeDeliveredLocked(context: NoticeContext, activationId: string,
  executionId: string): Promise<void> {
  for (const current of await noticesForActivation(context, activationId)) {
    if (current.value.delivery === 'delivered') {
      if (current.value.acknowledgementId !== executionId) return repeatConflict('WORK_NOTICE_DELIVERY_CONFLICT')
      continue
    }
    if (!['pending', 'unknown'].includes(current.value.delivery)) return repeatConflict('WORK_NOTICE_DELIVERY_CONFLICT')
    const next = WorkNoticeSchema.parse({ ...current.value, delivery: 'delivered',
      acknowledgementId: executionId, updatedAt: context.now })
    const changed = await context.sql.query(`update run_work_notices set delivery_state='delivered',
      acknowledgement_execution_id=$4,revision=revision+1,record=$5::jsonb,updated_at=$6
      where notice_id=$1 and run_id=$2 and revision=$3 returning notice_id`,
    [next.noticeId, context.scope.runId, current.revision, executionId, canonicalGraphJson(next), context.now])
    if (changed.rowCount !== 1) return repeatConflict('WORK_NOTICE_DELIVERY_CONFLICT')
    await context.sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
      values($1,'backend','work_limit_notice_delivered',$2,$3,$4::jsonb)`,
    [context.scope.runId, executionId, context.now, canonicalGraphJson({ noticeId: next.noticeId,
      continuationActivationId: activationId, acknowledgementExecutionId: executionId })])
  }
}
