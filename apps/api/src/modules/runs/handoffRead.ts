import type pg from 'pg'
import { z } from 'zod'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { RunHandoffsReadInputSchema, RunHandoffsReadSchema, WorkNoticeSchema,
  canonicalGraphJson, type RunHandoffsRead } from '@foreman-code/contracts/wave25'
import { DomainError } from '../errors.js'
import { requireAuthorization } from '../access/policy.js'
import { safeNodeName } from './nativeAction.js'
import { withCurrentRunRead } from './currentRead.js'

/** Saved edges and exact Run receipts, read under the same live Run grant as
 * HTTP and Operator MCP. This is a read, never an alternative admission path. */
export class RunHandoffReadService {
  constructor(private readonly pool: pg.Pool) {}

  async read(principal: ManagementPrincipal, raw: unknown): Promise<RunHandoffsRead> {
    const input = RunHandoffsReadInputSchema.parse(raw)
    try { return await withCurrentRunRead(this.pool, principal, input.workspaceId, input.runId, 'runs:read',
      async (sql, snapshot, live) => {
        const { run, version } = snapshot
        requireAuthorization(live, 'workflows:read', { workspaceId: run.workspaceId,
          workflowId: run.workflowId })
        const scope = { workspaceId: run.workspaceId, workflowId: run.workflowId,
          runId: run.id, workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 as const }
        if (!version.definition.handoffs) return RunHandoffsReadSchema.parse({
          scope, policy: 'not_configured', runState: run.executionState,
          connections: [], routes: [], notices: [], unresolved: [], directionWait: false,
        })
        const workEdges = version.definition.edges.filter((edge) => edge.kind === 'execution')
        const usages = (await sql.query<{ relationship_id: string; used: number; maximum: number | null }>(
          `select relationship_id,used,maximum from run_work_connection_usage
            where run_id=$1 and workflow_version_id=$2 order by relationship_id limit 8001`,
          [run.id, version.id])).rows
        if (usages.length>8000) throw new DomainError('HANDOFF_READ_TOO_LARGE', 'The Run has too many work connections to read.', 409)
        const usage = new Map(usages.map((item) => [item.relationship_id, item]))
        if (usage.size !== usages.length || usages.some((item) => !workEdges.some((edge) => edge.id === item.relationship_id))) {
          throw new DomainError('HANDOFF_READ_EVIDENCE_CONFLICT', 'The Run counter conflicts with its saved connection.', 409)
        }
        const endpoint = (id: string) => {
          const node = version.definition.nodes.find((item) => item.id === id)
          if (!node || node.kind === 'job') throw new DomainError('HANDOFF_READ_EVIDENCE_CONFLICT', 'A work handoff connection must have a pinned Agent node.', 409)
          const name = safeNodeName(node.name ?? node.label) ?? 'Agent'
          return { nodeId: node.id, nodeName: name, agentId: node.agentId, agentName: name }
        }
        const connections = workEdges.map((edge) => {
          const row = usage.get(edge.id), limit = edge.maxWorkHandoffsPerRun ?? null
          if (row && row.maximum !== limit || row && limit !== null && row.used>limit) {
            throw new DomainError('HANDOFF_READ_EVIDENCE_CONFLICT', 'The Run counter changed its saved limit.', 409)
          }
          const used = row?.used ?? 0
          return { relationshipId: edge.id, source: endpoint(edge.source), target: endpoint(edge.target),
            workRequestDirection: edge.workRequestDirection ?? 'source_to_target',
            used, limit, remaining: limit === null ? null : limit-used }
        })
        const byEdge = new Map(connections.map((item) => [item.relationshipId, item]))
        const routes = version.definition.nodes.flatMap((node) => node.choice?.outcomes.flatMap((choice) => {
          const target = choice.target
          if (target.kind !== 'edge') return []
          const edge = version.definition.edges.find((item) => item.id === target.relationshipId)
          const state = byEdge.get(target.relationshipId)
          if (!edge || !state || !(edge.source === node.id
            || edge.workRequestDirection === 'both' && edge.target === node.id)) return []
          return [{ requesterNodeId: node.id, outcome: choice.outcome,
            relationshipId: edge.id, destinationNodeId: edge.source === node.id ? edge.target : edge.source,
            available: run.executionState === 'running' && !snapshot.stopRequested
              && (state.limit === null || state.used<state.limit) }]
        }) ?? [])
        const notices = (await sql.query<{ record: unknown; delivery_state: string }>(
          `select record,delivery_state from run_work_notices where run_id=$1
            order by created_at,notice_id limit 1001`, [run.id])).rows
        const unresolved = (await sql.query<{ unresolved_id: string; activation_id: string;
          execution_id: string; reason: 'finish_with_findings' | 'repeated_exhausted_route';
          relationship_id: string | null; created_at: Date }>(
          `select unresolved_id,activation_id,execution_id,reason,relationship_id,created_at
            from run_work_unresolved where run_id=$1 order by created_at,unresolved_id limit 1001`,
          [run.id])).rows
        if (notices.length>1000 || unresolved.length>1000) throw new DomainError('HANDOFF_READ_TOO_LARGE',
          'The Run has too many notices or unresolved work items to read.', 409)
        const directionWait = run.executionState === 'waiting' && !snapshot.stopRequested
          && (await sql.query(`select 1 from run_work_direction_waits d where d.run_id=$1
            and not exists(select 1 from durable_interactions i where i.run_id=d.run_id
              and i.record->>'kind'='work_direction' and i.status='delivered')`,
          [run.id])).rowCount === 1
        const result = RunHandoffsReadSchema.parse({ scope, policy: 'work', runState: run.executionState,
          connections, routes,
          notices: notices.map((row) => {
            const notice = WorkNoticeSchema.parse(row.record)
            if (notice.scope.runId !== run.id || notice.scope.workflowVersionId !== version.id
              || notice.delivery !== row.delivery_state) throw new DomainError('HANDOFF_READ_EVIDENCE_CONFLICT',
              'A notice conflicts with its pinned Run.', 409)
            return { noticeId: notice.noticeId, cause: notice.cause.kind,
              requesterActivationId: notice.requesterActivationId,
              continuationActivationId: notice.continuationActivationId,
              relationshipId: notice.relationshipId, destinationNodeId: notice.destinationNodeId,
              delivery: notice.delivery,
              ...(notice.acknowledgementId ? { acknowledgementExecutionId: notice.acknowledgementId } : {}),
              remainingFindingsCount: notice.remainingFindings.length, createdAt: notice.createdAt }
          }),
          unresolved: unresolved.map((item) => ({ unresolvedId: item.unresolved_id,
            activationId: item.activation_id, executionId: item.execution_id, reason: item.reason,
            ...(item.relationship_id ? { relationshipId: item.relationship_id } : {}),
            createdAt: item.created_at.toISOString() })), directionWait })
        canonicalGraphJson(result, 256 * 1024)
        return result
      })
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof SyntaxError) throw new DomainError(
        'HANDOFF_READ_EVIDENCE_CONFLICT', 'Persisted handoff evidence is invalid or unavailable.', 409, undefined, { cause: error })
      if (error instanceof Error && error.message === 'GRAPH_JSON_LIMIT') throw new DomainError(
        'HANDOFF_READ_TOO_LARGE', 'The Run handoff read exceeds its response bound.', 409, undefined, { cause: error })
      throw error
    }
  }
}
