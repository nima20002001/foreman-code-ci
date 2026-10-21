import { GraphIdSchema, RunActivityPublicSchema, WorkHandoffResultSchema,
  type RunActivityPublic, type WorkflowVersionV3 } from '@foreman-code/contracts/wave25'
import { CiActivitySchema, ExecutionResultSchema } from '@foreman-code/contracts'
import { nativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { repeatId } from './repeatResolution.js'
import { safeNodeName, nativeToolTitle } from './nativeAction.js'
import { nativeActivityStatus } from './nativeActivityStatus.js'
import { claudeConversationActivity } from '../harnesses/claudeSdk/conversationActivity.js'
import { codexUnsupportedInteractionMessage } from '@foreman-code/contracts'

export interface ActivityReadRow {
  sequence: string; source: string; kind: string; occurred_at: Date;
  harness_execution_id: string | null;
  execution_node_id: string | null; execution_agent_id: string | null;
  execution_attempt: number | null; work_activation_id: string | null;
  /** Set when the execution is an interval check. */
  execution_tick_index?: number | null;
  job_execution_id?: string | null; job_attempt_id?: string | null; job_operation_id?: string | null;
  node_execution_id?: string | null; job_definition_id?: string | null;
  ci_ticket_id?: string | null; ci_activity?: unknown;
  job_definition_revision?: number | null; job_definition_version_id?: string | null;
  result_outcome: string | null;
  work_result?: unknown;
  safe_payload: Record<string, unknown>; native: Record<string, unknown> | null;
}

const string = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined
const id = (value: unknown): string | undefined => GraphIdSchema.safeParse(value).success ? value as string : undefined
const count = (value: unknown): number | undefined => typeof value === 'number'
  && Number.isSafeInteger(value) && value >= 0 ? value : undefined

function activityWorkResult(raw: unknown): RunActivityPublic['workResult'] {
  const result = ExecutionResultSchema.safeParse(raw)
  if (!result.success || result.data.outcome !== 'succeeded') return undefined
  let output = result.data.output
  if (output && typeof output === 'object' && !Array.isArray(output)
    && Object.keys(output).length === 1 && typeof output.text === 'string') output = output.text
  if (typeof output === 'string') {
    try { output = JSON.parse(output) } catch (error) {
      if (error instanceof SyntaxError) return undefined
      throw error
    }
  }
  const work = WorkHandoffResultSchema.safeParse(output)
  if (!work.success) return undefined
  return nativePersistenceRedactor([]).value({
    outcome: work.data.routing.outcome ?? work.data.routing.kind,
    latestDeliverable: work.data.data.latestDeliverable,
    remainingFindings: work.data.data.remainingFindings,
  })
}

function recordedResultActivity(raw: unknown): Pick<RunActivityPublic, 'status' | 'summary' | 'detail' | 'workResult'> {
  const result = ExecutionResultSchema.safeParse(raw)
  if (result.success && result.data.outcome === 'failed') {
    const error = result.data.error
    const detail = error ? nativePersistenceRedactor([]).text(`${error.code}: ${error.message}`).slice(0, 500)
      : undefined
    return { status: 'failed', summary: error?.retryable ? 'Attempt failed with a retryable error' : 'Work failed',
      ...(detail ? { detail } : {}) }
  }
  const workResult = activityWorkResult(raw)
  return { status: 'completed', summary: 'Work result recorded', ...(workResult ? { workResult } : {}) }
}

function toolLabel(native: Record<string, unknown>): string | undefined {
  const item = string(native.itemType), part = string(native.partTool)
  if (item === 'commandExecution' && native.commandName) {
    return nativeToolTitle(item, undefined, string(native.commandName))
  }
  if ((item === 'mcpToolCall' || item === 'dynamicToolCall') && native.toolName) {
    return nativeToolTitle(item, string(native.toolName))
  }
  if (item === 'dynamicToolCall') return 'Tool action'
  if (item === 'commandExecution' || part === 'bash') return 'Command action'
  if (item === 'fileChange' || ['write','edit','apply_patch','multiedit'].includes(part ?? '')) return 'File change'
  if (item === 'webSearch' || ['websearch','webfetch','codesearch'].includes(part ?? '')) return 'Web search'
  if (item === 'mcpToolCall' || part?.startsWith('foreman-code_') || part?.startsWith('foreman_code_') || part?.startsWith('graphql_') || part?.startsWith('graphql-app_')) return 'MCP tool action'
  if (item === 'collabAgentToolCall' || item === 'subAgentActivity' || part === 'task') return 'Subagent action'
  if (part === 'read') return 'File read'
  if (part === 'grep' || part === 'glob' || part === 'list') return 'File search'
  return undefined
}

const notificationSummaries = new Map([
  ['item/agentMessage/delta', 'Agent message updated'],
  ['item/commandExecution/outputDelta', 'Command output updated'],
  ['item/fileChange/outputDelta', 'File change output updated'],
  ['item/reasoning/textDelta', 'Reasoning text updated'],
  ['item/reasoning/summaryTextDelta', 'Reasoning summary updated'],
  ['item/reasoning/summaryPartAdded', 'Reasoning summary added'],
  ['item/mcpToolCall/progress', 'MCP tool progress updated'],
  ['mcpServer/startupStatus/updated', 'MCP server startup updated'],
  ['account/rateLimits/updated', 'Account rate limits updated'],
  ['thread/tokenUsage/updated', 'Token usage updated'],
  ['thread/status/changed', 'Native session status updated'],
  ['turn/diff/updated', 'File changes updated'],
  ['turn/plan/updated', 'Agent plan updated'],
  ['serverRequest/resolved', 'Native request resolved'],
])
const itemLabels = new Map([
  ['agentMessage', 'Agent message'], ['userMessage', 'User message'], ['reasoning', 'Agent reasoning'],
  ['plan', 'Agent plan'], ['contextCompaction', 'Context compaction'],
])
// Any other provider item type still names itself, e.g. imageView -> "Image view".
const itemTypeLabel = (itemType: string | undefined) => itemType && /^[A-Za-z]{1,48}$/.test(itemType)
  ? itemType.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/^./, (letter) => letter.toUpperCase()) : undefined

function nativeDetail(native: Record<string, unknown>): string | undefined {
  const item = string(native.itemType)
  const files = count(native.fileChangeCount)
  if (item === 'fileChange' && files !== undefined) {
    return `Changes cover ${files} ${files === 1 ? 'file' : 'files'}.`
  }
  if (item === 'commandExecution' && Number.isSafeInteger(native.exitCode)) {
    return `Exit code: ${native.exitCode}.`
  }
  if (item === 'agentMessage') {
    if (native.messagePhase === 'commentary') return 'Progress update.'
    if (native.messagePhase === 'final_answer') return 'Final answer.'
  }
  const characters = count(native.deltaLength)
  if (characters !== undefined && notificationSummaries.has(string(native.nativeMethod) ?? '')) {
    return `Received ${characters} ${characters === 1 ? 'character' : 'characters'}.`
  }
  return undefined
}

function toolStatus(native: Record<string, unknown>): RunActivityPublic['status'] {
  const item = nativeActivityStatus(string(native.itemStatus))
  const part = nativeActivityStatus(string(native.partStatus))
  if (item === 'canceled' || part === 'canceled') return 'canceled'
  if (native.itemError === true || item === 'failed' || part === 'failed') return 'failed'
  if (native.type === 'item.completed' || item === 'completed' || part === 'completed') return 'completed'
  if (item === 'unknown' || part === 'unknown') return 'unknown'
  if (item === 'pending' || part === 'pending') return 'pending'
  if (native.type === 'item.started' || item === 'running' || part === 'running') return 'running'
  return 'recorded'
}

type ActivityView = { kind: RunActivityPublic['kind']; status: RunActivityPublic['status']; summary: string; detail?: string | undefined }

/** A recorded native provider event: tool, item, turn or session activity. */
function nativeOutputActivity(native: Record<string, unknown>, runId: string): ActivityView {
  const unsupported = string(native.type) === 'interaction.unsupported'
    ? codexUnsupportedInteractionMessage(native.unsupportedInteractionCode) : undefined
  if (unsupported) return { kind: 'error', status: 'failed', summary: unsupported }
  const claude = claudeConversationActivity({ type: string(native.type) ?? '', payload: {
    itemId: native.claudeItemId, taskId: native.claudeTaskId, name: native.claudeName, status: native.claudeStatus,
  } }, runId)
  const tool = claude?.title ?? toolLabel(native)
  const label = tool ?? itemLabels.get(string(native.itemType) ?? '') ?? itemTypeLabel(string(native.itemType))
  let kind: RunActivityPublic['kind'] = 'tool_log'
  if (label) kind = 'agent_work'
  if (tool) kind = 'tool_action'
  let status: RunActivityPublic['status'] = claude?.status ?? toolStatus(native)
  const action = status === 'running' ? 'started' : status
  let summary = label ? `${label} ${action}` : 'Native activity recorded; details unavailable'
  if (native.type === 'native.notification') {
    summary = notificationSummaries.get(string(native.nativeMethod) ?? '') ?? summary
  } else if (native.type === 'turn.started' || native.type === 'turn.completed') {
    status = nativeActivityStatus(string(native.turnStatus))
      ?? (native.type === 'turn.started' ? 'running' : 'completed')
    summary = `Agent turn ${status === 'running' ? 'started' : status}`
  } else if (native.type === 'turn.capacity_wait') {
    status = 'pending'
    summary = 'Waiting for model capacity'
  } else if (native.type === 'turn.mcp_startup_retry') {
    kind = 'recovery'
    status = 'pending'
    summary = 'Retrying Foreman Code MCP startup'
  } else if (native.type === 'thread.started') {
    summary = 'Native session created'
  } else if (native.type === 'thread.reconciled') {
    summary = 'Native session history reconciled'
  }
  if (native.subagent === true) summary = `Subagent: ${summary.replace(/^Agent /, '')}`
  return { kind, status, summary, detail: nativeDetail(native) }
}

/** Approval request, decision, delivery and Worker acknowledgement activity. */
function approvalActivity(kind: string, payload: Record<string, unknown>,
  refs: { interactionId?: string | undefined; acknowledgementId?: string | undefined }): ActivityView {
  let status: RunActivityPublic['status'] = 'unknown'
  let summary = 'Approval details unavailable'
  switch (kind) {
    case 'interaction_pending':
      status = refs.interactionId ? 'pending' : 'unknown'
      summary = refs.interactionId ? 'Approval requested' : 'Approval details unavailable'; break
    case 'interaction_decided':
      status = 'recorded'
      summary = !refs.interactionId ? 'Approval decision details unavailable'
        : payload.selectedSemantic === 'reject' ? 'Approval rejected; decision recorded'
        : payload.selectedSemantic === 'cancel' ? 'Approval canceled; decision recorded'
          : ['approve_once','allow_turn','allow_session','provider_scoped_allow','persistent_policy_change']
            .includes(string(payload.selectedSemantic) ?? '')
            ? 'Approval granted; decision recorded' : 'Approval decision recorded'
      break
    case 'interaction_delivery_state': case 'interaction_resolved': {
      const delivery = string(payload.deliveryState)
      const resolution = string(payload.status)
      if (!refs.interactionId) {
        status = 'unknown'
        summary = 'Approval details unavailable'
      } else if (resolution === 'canceled') {
        status = 'canceled'
        summary = 'Approval canceled'
      } else if (delivery === 'delivered' && resolution === 'delivered') {
        status = 'delivered'
        summary = 'Approval delivered to provider'
      } else if (resolution === 'delivery_failed' || delivery === 'failed') {
        status = 'delivery_failed'
        summary = 'Approval delivery failed'
      } else if (delivery === 'uncertain') {
        status = 'unknown'
        summary = 'Approval delivery uncertain'
      } else {
        status = 'pending'
        summary = 'Approval delivery pending'
      }
      break
    }
    case 'interaction_worker_ack':
      status = refs.interactionId && refs.acknowledgementId ? 'acknowledged' : 'unknown'
      summary = status === 'acknowledged' ? 'Worker acknowledged approval'
        : 'Worker acknowledgement details unavailable'; break
  }
  return { kind: 'approval', status, summary }
}

/** Review job state; without a review job reference the details are unavailable. */
function reviewActivity(state: string | undefined, reviewJobId: string | undefined): ActivityView {
  const status: RunActivityPublic['status'] = !reviewJobId ? 'unknown'
    : state === 'completed' ? 'completed' : state === 'failed' ? 'failed'
    : state === 'uncertain' ? 'unknown' : 'pending'
  const summary = !reviewJobId ? 'Review details unavailable'
    : status === 'completed' ? 'Review completed'
    : status === 'failed' ? 'Review failed' : 'Review status updated'
  return { kind: 'review', status, summary }
}

function skippedEventsActivity(payload: Record<string, unknown>): ActivityView {
  const from = count(payload.fromSequence)
  const to = count(payload.toSequence)
  const skipped = from !== undefined && to !== undefined && to >= from ? to - from + 1 : undefined
  const summary = skipped === undefined ? 'Events skipped' : `${skipped} ${skipped === 1 ? 'event' : 'events'} skipped`
  const detail = to === undefined ? undefined
    : `Activity observation resumed at event ${to + 1}. The Agent kept running.`
  return { kind: 'recovery', status: 'recorded', summary, detail }
}

function ciActivity(ci: RunActivityPublic['ci']): ActivityView {
  if (!ci) {
    return { kind: 'job_work', status: 'unknown', summary: 'CI activity details unavailable' }
  }
  const statuses: Record<typeof ci.state, RunActivityPublic['status']> = {
    queued: 'queued', starting: 'starting', running: 'running', passed: 'completed',
    failed: 'failed', canceled: 'canceled', lost: 'unknown',
  }
  return { kind: 'job_work', status: statuses[ci.state], summary: `CI ${ci.suite} ${ci.state}` }
}

/** Project typed activity details and recorded work results; exclude native provider bodies. */
export function publicRunActivity(row: ActivityReadRow, version: WorkflowVersionV3,
  runId: string, runOutcome: string): RunActivityPublic {
  const scope = { workspaceId: version.workspaceId, workflowId: version.workflowId,
    runId, workflowVersionId: version.id,
    executionSemanticsVersion: 3 as const }
  const payload = row.safe_payload, native = row.native ?? {}
  const node = version.definition.nodes.find((item) => item.id === row.execution_node_id)
  const actorKind = new Set(['node_scheduled','node_state_changed','harness_session_started',
    'harness_output','harness_session_finished','result_recorded','work_result_accepted',
    'work_handoff_accepted','work_handoff_returned','work_handoff_denied','work_rerouted','ci_state_changed',
    'interaction_pending','interaction_decided','interaction_delivery_state','interaction_resolved','interaction_worker_ack',
    'native_events_skipped'])
  const jobActor = node?.kind === 'job' && row.job_execution_id && row.node_execution_id === row.job_execution_id
    && row.job_definition_id === node.jobDefinitionId && row.job_definition_revision === node.jobDefinitionRevision
    && row.job_definition_version_id === node.jobDefinitionVersionId
    ? { kind: 'job' as const, nodeId: node.id, nodeName: string(payload.actorName) ?? 'Job',
      jobDefinitionId: node.jobDefinitionId, jobDefinitionRevision: node.jobDefinitionRevision,
      jobDefinitionVersionId: node.jobDefinitionVersionId } : undefined
  const actor = actorKind.has(row.kind) && jobActor ? jobActor
    : actorKind.has(row.kind) && node && node.kind !== 'job' && node.agentId === row.execution_agent_id
    ? { agentId: node.agentId, agentName: safeNodeName(payload.actorName) ?? 'Agent',
      nodeId: node.id, nodeName: safeNodeName(payload.actorName) ?? 'Agent' } : undefined
  const subjectId = row.kind === 'work_requester_reactivated' ? id(payload.requesterNodeId)
    : row.kind.startsWith('work_limit_notice_') || row.kind === 'work_rerouted'
      ? id(payload.destinationNodeId) : undefined
  const subjectNode = version.definition.nodes.find((item) => item.id === subjectId)
  const subject = subjectNode?.kind === 'job' ? { kind: 'job' as const, nodeId: subjectNode.id,
    nodeName: string(payload.subjectName) ?? 'Job', jobDefinitionId: subjectNode.jobDefinitionId,
    jobDefinitionRevision: subjectNode.jobDefinitionRevision, jobDefinitionVersionId: subjectNode.jobDefinitionVersionId }
    : subjectNode ? { agentId: subjectNode.agentId,
    agentName: safeNodeName(payload.subjectName) ?? 'Agent',
    nodeId: subjectNode.id, nodeName: safeNodeName(payload.subjectName) ?? 'Agent' } : undefined
  const relationship = id(payload.relationshipId)
  const fromRelationship = id(payload.fromRelationshipId)
  const requesterNode = id(payload.requesterNodeId)
  const destinationNode = id(payload.destinationNodeId)
  const continuedFromExecutionId = id(payload.continuedFromExecutionId)
  const ciResult = CiActivitySchema.safeParse(row.ci_activity)
  const ci = row.kind === 'ci_state_changed' && actor && 'agentId' in actor
    && ciResult.success && ciResult.data.id === row.ci_ticket_id ? ciResult.data : undefined
  const refs = {
    ...(ci ? { ciTicketId: ci.id, ciGroupId: ci.groupId } : {}),
    ...(jobActor ? { executionId: row.job_execution_id, jobExecutionId: row.job_execution_id,
      jobAttemptId: id(row.job_attempt_id), jobOperationId: id(row.job_operation_id), nodeExecutionId: row.node_execution_id } : {}),
    ...(!jobActor && row.harness_execution_id && row.execution_node_id ? { executionId: row.harness_execution_id } : {}),
    ...(continuedFromExecutionId ? { continuedFromExecutionId } : {}),
    ...(id(row.work_activation_id ?? payload.activationId) ? { activationId: id(row.work_activation_id ?? payload.activationId) } : {}),
    ...(id(payload.requestId) ? { requestId: id(payload.requestId) } : {}),
    ...(id(payload.returnId) ? { returnId: id(payload.returnId) } : {}),
    ...(id(payload.denialId) ? { denialId: id(payload.denialId) } : {}),
    ...(id(payload.noticeId) ? { noticeId: id(payload.noticeId) } : {}),
    ...(id(payload.unresolvedId) ? { unresolvedId: id(payload.unresolvedId) } : {}),
    ...(relationship && version.definition.edges.some((edge) => edge.id === relationship)
      ? { relationshipId: relationship } : {}),
    ...(fromRelationship && version.definition.edges.some((edge) => edge.id === fromRelationship)
      ? { fromRelationshipId: fromRelationship } : {}),
    ...(requesterNode && version.definition.nodes.some((item) => item.id === requesterNode)
      ? { requesterNodeId: requesterNode } : {}),
    ...(destinationNode && version.definition.nodes.some((item) => item.id === destinationNode)
      ? { destinationNodeId: destinationNode } : {}),
    ...(id(payload.interactionId) ? { interactionId: id(payload.interactionId) } : {}),
    ...(id(payload.reviewJobId) ? { reviewJobId: id(payload.reviewJobId) } : {}),
    ...(id(payload.acknowledgementId) ? { acknowledgementId: id(payload.acknowledgementId) } : {}),
    ...(count(row.execution_attempt) && row.execution_node_id ? { technicalAttempt: row.execution_attempt! } : {}),
    ...(count(payload.nativeEventSequence) !== undefined ? { nativeEventSequence: count(payload.nativeEventSequence) } : {}),
  }
  const used = count(payload.used), maximum = count(payload.maximum)
  const usageProven = row.kind === 'work_handoff_accepted' ? Boolean(refs.requestId)
    : row.kind === 'work_handoff_denied' ? Boolean(refs.denialId)
      : row.kind.startsWith('work_limit_notice_') ? Boolean(refs.noticeId) : true
  const usage = used === undefined || !usageProven ? undefined
    : { used, limit: maximum && maximum > 0 ? maximum : null }
  let kind: RunActivityPublic['kind'] = jobActor ? 'job_work' : 'agent_work'
  let status: RunActivityPublic['status']
  let summary: string
  let detail: string | undefined
  let workResult: RunActivityPublic['workResult']
  switch (row.kind) {
    case 'native_events_skipped':
      ({ kind, status, summary, detail } = skippedEventsActivity(payload))
      break
    case 'ci_state_changed':
      ({ kind, status, summary } = ciActivity(ci))
      break
    case 'run_state_changed': {
      kind = 'run'
      const state = string(payload.executionState)
      status = state === 'completed' ? runOutcome === 'failed' ? 'failed'
        : runOutcome === 'canceled' ? 'canceled' : 'completed'
        : state === 'running' ? 'running' : state === 'queued' ? 'queued'
          : state === 'interrupted' ? 'unknown' : 'pending'
      summary = state === 'completed' ? 'Run completed' : state === 'running' ? 'Run started'
        : state === 'queued' ? 'Run queued' : state === 'waiting' ? 'Run waiting'
          : 'Run state changed'
      break
    }
    case 'run_stop_requested': kind = 'stop'; status = 'pending'; summary = 'Stop requested'; break
    case 'run_cleanup_checked':
      kind = 'recovery'; status = payload.failed === true ? 'failed' : 'completed'
      summary = payload.code === 'RUN_CLEANUP_DEADLINE_EXCEEDED'
        ? 'Cleanup deadline exceeded; native cleanup is unconfirmed and ownership is retained'
        : payload.failed === true ? 'Native cleanup remains pending' : 'Native cleanup verified'
      break
    case 'node_scheduled': case 'work_activation_queued':
      status = 'queued'; summary = 'Work turn queued'; break
    case 'node_state_changed': {
      const state = string(payload.state)
      status = state === 'completed' ? row.result_outcome === 'failed' ? 'failed'
        : row.result_outcome === 'canceled' ? 'canceled' : 'completed'
        : state === 'starting' ? 'starting' : state === 'running' ? 'running'
          : state === 'waiting' ? 'pending' : 'queued'
      const label = jobActor ? 'Job' : 'Agent'
      const check = count(row.execution_tick_index)
      summary = check ? state === 'completed' ? `Loop ${check} finished`
        : state === 'running' ? `Looping · loop ${check}` : state === 'waiting' ? `Loop ${check} waiting`
          : state === 'starting' ? `Loop ${check} starting` : `Loop ${check} queued`
        : state === 'completed' ? `${label} work completed`
        : state === 'running' ? `${label} working` : state === 'waiting' ? `${label} waiting`
          : `${label} work queued`
      if (status === 'failed') detail = 'Error details are available in Run inspection.'
      break
    }
    case 'harness_session_started': status = 'running'; summary = 'Native session started'; break
    case 'harness_session_finished': status = 'completed'; summary = 'Native session finished'; break
    case 'harness_output':
      ({ kind, status, summary, detail } = nativeOutputActivity(native, runId))
      break
    case 'result_recorded': case 'work_result_accepted':
      ({ status, summary, detail, workResult } = recordedResultActivity(row.work_result))
      break
    case 'work_handoff_accepted':
      kind = 'work_request'; status = refs.requestId ? 'accepted' : 'unknown'
      summary = refs.requestId ? 'Work request admitted' : 'Work request details unavailable'; break
    case 'work_handoff_returned':
      kind = 'work_return'; status = !refs.returnId ? 'unknown'
        : payload.outcome === 'needs_changes' ? 'needs_changes'
          : payload.outcome === 'accepted' ? 'accepted' : 'unknown'
      summary = status === 'needs_changes' ? 'Review returned with changes needed'
        : status === 'accepted' ? 'Work return accepted' : 'Work return details unavailable'
      break
    case 'work_handoff_denied':
      kind = 'work_request'; status = refs.denialId ? 'denied' : 'unknown'
      summary = refs.denialId ? 'Work request denied at connection limit'
        : 'Work denial details unavailable'; break
    case 'work_requester_reactivated':
      kind = 'agent_work'; status = refs.activationId ? 'queued' : 'unknown'
      summary = refs.activationId ? `${subject?.nodeName ?? 'Requester'} continuation queued`
        : 'Requester continuation details unavailable'; break
    case 'work_rerouted':
      kind = 'reroute'; status = refs.requestId && refs.noticeId && refs.relationshipId
        && refs.fromRelationshipId ? 'accepted' : 'unknown'
      summary = status === 'accepted' ? 'Work rerouted on a saved connection'
        : 'Reroute details unavailable'; break
    case 'work_limit_notice_queued': case 'work_limit_notice_pending':
    case 'work_limit_notice_delivered': case 'work_limit_notice_unknown':
      kind = 'work_notice'
      status = !refs.noticeId ? 'unknown'
        : row.kind === 'work_limit_notice_delivered' ? 'delivered'
        : row.kind === 'work_limit_notice_unknown' ? 'unknown'
          : row.kind === 'work_limit_notice_pending' ? 'pending' : 'queued'
      summary = !refs.noticeId ? 'Work limit notice details unavailable'
        : status === 'delivered' ? 'Work limit notice acknowledged by requester'
        : status === 'unknown' ? 'Work limit notice delivery uncertain'
          : status === 'pending' ? 'Work limit notice bound to requester turn'
            : 'Work limit notice queued'
      if (subject) summary = `${summary} for ${subject.nodeName}`
      break
    case 'work_needs_direction': case 'work_direction_wait':
      kind = 'needs_direction'
      status = row.kind === 'work_direction_wait' || refs.unresolvedId ? 'needs_direction' : 'unknown'
      summary = status === 'unknown' ? 'Unresolved work details unavailable'
        : row.kind === 'work_direction_wait' ? 'Run waiting for direction' : 'Work needs direction'
      workResult = row.kind === 'work_needs_direction' ? activityWorkResult(row.work_result) : undefined
      break
    case 'interaction_pending': case 'interaction_decided': case 'interaction_delivery_state':
    case 'interaction_resolved': case 'interaction_worker_ack':
      ({ kind, status, summary } = approvalActivity(row.kind, payload, refs))
      break
    case 'review_job_state': ({ kind, status, summary } = reviewActivity(string(payload.state), refs.reviewJobId)); break
    default: kind = 'error'; status = 'unknown'; summary = 'Activity details unavailable'
  }
  const severity = status === 'failed' || status === 'delivery_failed' ? 'error'
    : ['denied','unknown','needs_direction'].includes(status) ? 'warning' : 'info'
  return RunActivityPublicSchema.parse({ id: repeatId('activity', scope.runId, row.sequence),
    scope, sequence: row.sequence, occurredAt: row.occurred_at.toISOString(), source: row.source,
    kind, status, severity, summary,
    ...(workResult ? { workResult } : {}),
    ...(ci ? { ci } : {}),
    ...(detail ? { detail } : {}), ...(actor ? { actor } : {}),
    ...(subject ? { subject } : {}), refs,
    ...(usage ? { usage } : {}) })
}
