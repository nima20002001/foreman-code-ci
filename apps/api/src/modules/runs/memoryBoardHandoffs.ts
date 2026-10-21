import { memoryFindingReason } from './memoryFindings.js'
import type { BoardLifecycleFact } from '@foreman-code/contracts'
import { WorkReturnSchema, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { memoryExecution } from '../collaboration/memoryExecution.js'
import type { MemoryBoardPort } from '../collaboration/ports.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { selectedWorkHandoffRoutes } from './workHandoffRouting.js'
import { parseWorkflowWorkResult } from './workflowCoordinationResult.js'
import { repeatConflict } from './repeatResolution.js'

type Settlement = Pick<BoardLifecycleFact, 'reason' | 'outstandingRequestIds'> & {
  phase: 'accepted' | 'blocked' | 'waiting_children'
}
const waiting: Settlement = { phase: 'waiting_children', reason: null, outstandingRequestIds: [] }

function memoryWorkRoutes(definition: WorkflowDefinitionV3, nodeId: string,
  result: ReturnType<typeof parseWorkflowWorkResult>): string[] {
  if (!definition.hierarchy) return selectedWorkHandoffRoutes(definition, nodeId, result)
  const routing = result.routing
  if (routing.kind === 'return' || routing.kind === 'finish') return []
  const outcomes = routing.kind === 'delegate' ? routing.requests.map(request => request.outcome) : [routing.outcome]
  const node = definition.nodes.find(candidate => candidate.id === nodeId)
  return outcomes.map(outcome => {
    const target = node?.choice?.outcomes.find(candidate => candidate.outcome === outcome)?.target
    if (target?.kind !== 'edge') return repeatConflict('WORK_REQUEST_OUTCOME_UNDECLARED')
    return target.relationshipId
  })
}

export function memoryWorkSettlement(tx: GraphTransactionSql, executionId: string): Promise<Settlement> {
  return settlement(tx, executionId, new Set())
}

async function settlement(tx: GraphTransactionSql, executionId: string, visited: Set<string>): Promise<Settlement> {
  if (visited.has(executionId)) return waiting
  visited.add(executionId)
  const saved = await memoryExecution(tx, executionId)
  const result = saved.execution.result
  if (result?.outcome === 'failed' || result?.outcome === 'canceled') {
    return { phase: 'blocked', reason: result.error?.message ?? 'Required work was canceled.', outstandingRequestIds: [] }
  }
  if (!saved.accepted || result?.outcome !== 'succeeded') return waiting
  const output = parseWorkflowWorkResult(result, saved.version, saved.node.id, saved.execution.resultProtocol)
  if (output.data.remainingFindings.length) {
    return { phase: 'blocked', reason: memoryFindingReason(output.data.remainingFindings), outstandingRequestIds: [] }
  }
  if (output.routing.kind === 'return') {
    const returned = await tx.query('select return_id from run_work_returns where run_id=$1 and source_execution_id=$2',
      [saved.execution.runId, executionId])
    if (!returned.rowCount) return waiting
  }
  const routes = memoryWorkRoutes(saved.version.definition, saved.node.id, output)
  const requests = (await tx.query<{ request_id: string; relationship_id: string;
    returned: unknown; execution_id: string | null }>(`select q.request_id,q.relationship_id,t.record as returned,x.execution_id
    from run_work_requests q left join run_work_returns t on t.run_id=q.run_id and t.request_id=q.request_id
    left join lateral (select e.execution_id from run_repeat_executions e
      where e.run_id=q.run_id and e.work_activation_id=q.destination_activation_id
      order by e.technical_attempt desc limit 1) x on true
    where q.run_id=$1 and q.requester_execution_id=$2 order by q.request_id`,
  [saved.execution.runId, executionId])).rows
  const denials = (await tx.query<{ request_id: string; relationship_id: string; execution_id: string | null }>(`
    select d.request_id,d.relationship_id,x.execution_id from run_work_denials d
    join run_work_activations a on a.run_id=d.run_id and a.cause_kind='limit_denial' and a.cause_id=d.denial_id
    left join lateral (select e.execution_id from run_repeat_executions e
      where e.run_id=a.run_id and e.work_activation_id=a.activation_id
      order by e.technical_attempt desc limit 1) x on true
    where d.run_id=$1 and d.requester_execution_id=$2 order by d.denial_id`,
  [saved.execution.runId, executionId])).rows
  if (routes.some(id => ![...requests, ...denials].some(request => request.relationship_id === id))) return waiting
  const pending: string[] = []
  for (const denial of denials) {
    const continuation = denial.execution_id ? await settlement(tx, denial.execution_id, new Set(visited)) : waiting
    if (continuation.phase === 'blocked') return { ...continuation, outstandingRequestIds: [denial.request_id] }
    if (continuation.phase !== 'accepted') pending.push(denial.request_id)
  }
  for (const request of requests) {
    if (request.returned) {
      const returned = WorkReturnSchema.parse(request.returned)
      if (returned.outcome === 'accepted' && !returned.remainingFindings.length) continue
      if (returned.continuationActivationId) {
        const continuation = (await tx.query<{ execution_id: string }>(`select execution_id from run_repeat_executions
          where run_id=$1 and work_activation_id=$2 order by technical_attempt desc limit 1`,
        [saved.execution.runId, returned.continuationActivationId])).rows[0]
        if (continuation) {
          const corrected = await settlement(tx, continuation.execution_id, new Set(visited))
          if (corrected.phase === 'accepted') continue
          if (corrected.phase === 'waiting_children') { pending.push(request.request_id); continue }
          return { ...corrected, outstandingRequestIds: [request.request_id] }
        }
      }
      return { phase: 'blocked', reason: memoryFindingReason(returned.remainingFindings),
        outstandingRequestIds: [request.request_id] }
    }
    const child = request.execution_id ? await settlement(tx, request.execution_id, new Set(visited)) : waiting
    if (child.phase === 'blocked') return { ...child, outstandingRequestIds: [request.request_id] }
    if (child.phase !== 'accepted') pending.push(request.request_id)
  }
  return { phase: pending.length ? 'waiting_children' : 'accepted', reason: null, outstandingRequestIds: pending }
}

/** Only the affected request ancestry is read; no card history or native transcript is scanned. */
export async function reconcileMemoryHandoffsLocked(tx: GraphTransactionSql, service: MemoryBoardPort,
  executionId: string, sourceEventKey: string): Promise<void> {
  const source = await memoryExecution(tx, executionId)
  if (source.work.kind !== 'activation' || !source.version.definition.handoffs) return
  const parents = await parentExecutions(tx, source.work.runId, source.work.activationId)
  for (const id of [executionId, ...parents]) {
    const saved = id === executionId ? source : await memoryExecution(tx, id)
    // Native and admission callbacks own this execution until its result is accepted.
    if (!saved.accepted) continue
    const state = await settlement(tx, id, new Set())
    await service.applyLifecycleLocked(tx, { agent: saved.subject.agent, execution: saved.subject.execution,
      work: saved.work, sourceEventKey: `${sourceEventKey}:requests:${id}`, ...state })
  }
}

async function parentExecutions(tx: GraphTransactionSql, runId: string, activationId: string): Promise<string[]> {
  const seen = new Set([activationId])
  const executions = new Set<string>()
  let frontier = [activationId]
  while (frontier.length) {
    const rows = (await tx.query<{ activation_id: string; execution_id: string }>(`
      select q.requester_activation_id as activation_id,q.requester_execution_id as execution_id
        from run_work_requests q where q.run_id=$1 and q.destination_activation_id=any($2::text[])
      union select q.requester_activation_id,q.requester_execution_id
        from run_work_returns t join run_work_requests q on q.run_id=t.run_id and q.request_id=t.request_id
        where t.run_id=$1 and t.requester_continuation_activation_id=any($2::text[])
      union select d.requester_activation_id,d.requester_execution_id
        from run_work_denials d join run_work_activations a
          on a.run_id=d.run_id and a.cause_kind='limit_denial' and a.cause_id=d.denial_id
        where a.run_id=$1 and a.activation_id=any($2::text[])`, [runId, frontier])).rows
    frontier = []
    for (const row of rows) {
      executions.add(row.execution_id)
      if (!seen.has(row.activation_id)) {
        seen.add(row.activation_id)
        frontier.push(row.activation_id)
      }
    }
  }
  return [...executions]
}
