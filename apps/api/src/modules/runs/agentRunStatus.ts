import type pg from 'pg'
import { AgentRunStatusSchema, CiRunRecordSchema, RUN_STATUS_LIMITS, type AgentRunStatus } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import { workerScope, workerScopesForAction } from '../access/appPolicy.js'
import { DomainError } from '../errors.js'
import { ciActivityFromRecord } from './agentCiSnapshot.js'
import { workflowJobLifecycle } from '../run-graph/workflowJobProjection.js'

const clip = (text: string) => text.slice(0, RUN_STATUS_LIMITS.messageLength)

/** run_status_get: an interval Agent reads its OWN Run only, through its bound execution credential. */
export class AgentRunStatusService {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async read(principal: ManagementPrincipal): Promise<AgentRunStatus> {
    workerScope(principal)
    const binding = (await this.pool.query<{ run_id: string; execution_id: string; node_id: string; workspace_id: string
      workflow_id: string; workflow_version_id: string; state: string; outcome: string | null; stopped: boolean; version: unknown }>(
      `select r.id as run_id,e.id as execution_id,e.workflow_node_id as node_id,r.workspace_id,r.workflow_id,
         r.workflow_version_id,r.execution_state as state,r.record->>'outcome' as outcome,
         r.stop_requested_at is not null as stopped,v.record as version
       from worker_credential_bindings b join harness_executions e on e.id=b.execution_id and e.run_id=b.run_id
         and e.agent_id=b.agent_id
       join runs r on r.id=b.run_id join workflow_versions v on v.id=r.workflow_version_id and v.workspace_id=r.workspace_id
       where b.principal_id=$1 and b.agent_id=$2 and b.revoked_at is null limit 1`, [principal.id, principal.agentId])).rows[0]
    const scoped = binding && workerScopesForAction(principal, 'interactions:read').some(scope =>
      scope.workspaceIds?.includes(binding.workspace_id) && scope.workflowIds?.includes(binding.workflow_id)
      && scope.runIds?.includes(binding.run_id))
    if (!binding || !scoped) throw new DomainError('ACCESS_DENIED', 'The caller is not authorized to read this Run.', 403)
    const version = WorkflowVersionV3Schema.parse(binding.version)
    const self = version.definition.nodes.find(node => node.id === binding.node_id)
    if (!self || self.kind === 'job' || !self.interval) {
      throw new DomainError('TOOL_NOT_ENABLED', 'Run status is available only to workflow nodes with interval checks.', 403)
    }
    const executions = (await this.pool.query<{ id: string; node_id: string; state: string; outcome: string | null
      started_at: string | null; finished_at: string | null; tick: boolean; error_code: string | null; error_message: string | null
      stuck_message: string | null; stuck_at: string | null }>(
      `select e.id,e.workflow_node_id as node_id,e.record->>'state' as state,e.record#>>'{result,outcome}' as outcome,
         e.record->>'startedAt' as started_at,e.record->>'finishedAt' as finished_at,e.tick_index is not null as tick,
         e.record#>>'{result,error,code}' as error_code,e.record#>>'{result,error,message}' as error_message,
         b.record#>>'{happened,message}' as stuck_message,b.record->>'createdAt' as stuck_at
       from harness_executions e left join bug_reports b on b.id='bug-report-stuck-'||e.id and b.run_id=e.run_id
       where e.run_id=$1 order by e.created_at,e.id limit 16001`, [binding.run_id])).rows
    const jobs = (await this.pool.query<{ id: string; node_id: string; phase: string | null; outcome: string | null
      stopped: boolean | null; started_at: string | null; finished_at: string | null; publication: string | null
      result_issue: string | null }>(
      `select j.id,j.record#>>'{workflow,nodeId}' as node_id,j.record#>>'{process,phase}' as phase,
         j.record#>>'{process,outcome}' as outcome,(j.record#>>'{process,processStopped}')::boolean as stopped,
         j.record->>'startedAt' as started_at,j.record->>'finishedAt' as finished_at,j.record->>'publication' as publication,
         j.record->>'resultIssue' as result_issue
       from workflow_job_executions w join job_executions j on j.id=w.job_execution_id
       where w.run_id=$1 order by j.record->>'createdAt',j.id limit 16001`, [binding.run_id])).rows
    if (executions.length + jobs.length > 16000) throw new DomainError('RUN_STATUS_TOO_LARGE', 'This Run has too many executions to summarize.', 409)
    for (const job of jobs) {
      const { state, resultOutcome } = workflowJobLifecycle(job)
      const problem = job.outcome && job.outcome !== 'succeeded' ? job.outcome : job.result_issue
      executions.push({ id: job.id, node_id: job.node_id, state, outcome: resultOutcome, started_at: job.started_at,
        finished_at: job.finished_at, tick: false, error_code: problem ? `JOB_${problem.toUpperCase()}` : null,
        error_message: problem ? `The Job ended with ${problem.replaceAll('_', ' ')}.` : null,
        stuck_message: null, stuck_at: null })
    }
    const nodes = version.definition.nodes.map(node => {
      const own = executions.filter(execution => execution.node_id === node.id)
      const latest = own.at(-1)
      const state = latest?.state ?? 'not_started'
      return {
        nodeId: node.id, name: node.name ?? node.label ?? node.id,
        state: (['queued', 'starting', 'running', 'waiting', 'completed'].includes(state) ? state : 'not_started') as AgentRunStatus['nodes'][number]['state'],
        outcome: (['succeeded', 'failed', 'canceled'].includes(latest?.outcome ?? '') ? latest!.outcome : null) as AgentRunStatus['nodes'][number]['outcome'],
        executions: own.length, checks: own.filter(execution => execution.tick).length,
        lastStartedAt: latest?.started_at ?? null, lastFinishedAt: latest?.finished_at ?? null,
      }
    })
    const tickets = (await this.pool.query<{ node_id: string; record: unknown }>(
      `select e.workflow_node_id as node_id,c.record from ci_runs c join harness_executions e on e.id=c.record#>>'{initiator,executionId}'
       where e.run_id=$1 and c.workspace_id=$2 order by c.created_at desc,c.id desc limit $3`,
    [binding.run_id, binding.workspace_id, RUN_STATUS_LIMITS.ci])).rows.map(row => ({
      nodeId: row.node_id, record: CiRunRecordSchema.parse(row.record),
    }))
    const errors = [
      ...executions.filter(execution => execution.state === 'running' && execution.stuck_message).map(execution => ({
        nodeId: execution.node_id, executionId: execution.id, ciTicketId: null,
        code: 'AGENT_EXECUTION_STUCK', message: clip(execution.stuck_message!), at: execution.stuck_at,
      })),
      ...executions.filter(execution => execution.outcome === 'failed').map(execution => ({
        nodeId: execution.node_id, executionId: execution.id, ciTicketId: null,
        code: clip(execution.error_code ?? 'EXECUTION_FAILED').slice(0, 100),
        message: clip(execution.error_message ?? 'The execution failed.'), at: execution.finished_at,
      })),
      ...tickets.filter(ticket => ['failed', 'lost'].includes(ticket.record.state)).map(ticket => ({
        nodeId: ticket.nodeId, executionId: ticket.record.initiator.executionId, ciTicketId: ticket.record.id,
        code: ticket.record.state === 'lost' ? 'CI_LOST' : 'CI_FAILED',
        message: clip([ticket.record.suite, ticket.record.step, ticket.record.exitCode === null ? null : `exit ${ticket.record.exitCode}`,
          ticket.record.message].filter(Boolean).join(': ')), at: ticket.record.finishedAt,
      })),
    ].sort((left, right) => (right.at ?? '').localeCompare(left.at ?? '')).slice(0, RUN_STATUS_LIMITS.errors)
    return AgentRunStatusSchema.parse({
      run: { id: binding.run_id, executionState: binding.state, outcome: binding.outcome, stopRequested: binding.stopped },
      self: { nodeId: binding.node_id, executionId: binding.execution_id },
      nodes, ci: tickets.map(ticket => ({ nodeId: ticket.nodeId, ticket: ciActivityFromRecord(ticket.record) })), errors,
    })
  }
}
