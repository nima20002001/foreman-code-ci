import { MemoryResultRejected } from '../collaboration/memoryResultError.js'
import { DomainError } from '../errors.js'
import type { ExecutionResult } from '@foreman-code/contracts'
import { workflowResultContext } from './resultContext.js'
import { memoryFindingReason } from './memoryFindings.js'
import { reconcileMemoryHandoffsLocked } from './memoryBoardHandoffs.js'
import { selectedWorkHandoffRoutes } from './workHandoffRouting.js'
import {
  parseCoordinationResult, type BoardLifecycleFact, type HarnessExecution,
  type LogicalWorkRef,
} from '@foreman-code/contracts'
import { parseWorkHandoffResult, type WorkflowRunV3 } from '@foreman-code/contracts/wave25'
import type { MemoryBoardPort } from '../collaboration/ports.js'
import { memoryExecution } from '../collaboration/memoryExecution.js'
import type { MemoryBoardService } from '../memory-boards/service.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { RepeatEffect } from './repeatPostgres.js'
import type { RepeatNativeChange } from './repeatNativeRepository.js'
import { repeatTickIndex } from './repeatResolution.js'

export async function prepareMemoryLaunchLocked(tx: GraphTransactionSql, service: MemoryBoardService,
  execution: HarnessExecution): Promise<HarnessExecution> {
  const saved = await memoryExecution(tx, execution.id)
  const previous = saved.previousExecutionId ? await memoryExecution(tx, saved.previousExecutionId) : undefined
  const digest = previous?.execution.memoryBoardDigest
    ?? await service.readDigestLocked(tx, { subject: saved.subject, work: saved.work })
  return { ...execution, memoryBoardDigest: digest }
}

async function lifecycle(tx: GraphTransactionSql, service: MemoryBoardPort,
  executionId: string, sourceEventKey: string, phase: BoardLifecycleFact['phase'],
  extra: Partial<Pick<BoardLifecycleFact, 'reason' | 'continuationOf' | 'outstandingRequestIds'>> = {}) {
  const saved = await memoryExecution(tx, executionId)
  return service.applyLifecycleLocked(tx, { agent: saved.subject.agent, execution: saved.subject.execution,
    work: saved.work, sourceEventKey, phase, reason: null, outstandingRequestIds: [], ...extra })
}

async function continuations(tx: GraphTransactionSql, work: LogicalWorkRef): Promise<LogicalWorkRef[]> {
  if (work.kind !== 'activation') return []
  const rows = await tx.query<{ activation_id: string }>(`select distinct q.requester_activation_id as activation_id
    from run_work_returns t join run_work_requests q on q.run_id=t.run_id and q.request_id=t.request_id
    where t.run_id=$1 and t.requester_continuation_activation_id=$2
    union select d.record->>'requesterActivationId' as activation_id from run_work_denials d
    join run_work_activations a on a.run_id=d.run_id and a.cause_kind='limit_denial' and a.cause_id=d.denial_id
    where a.run_id=$1 and a.activation_id=$2`, [work.runId, work.activationId])
  return rows.rows.map(row => ({ ...work, activationId: row.activation_id }))
}

export async function applyMemoryEffectLocked(tx: GraphTransactionSql, service: MemoryBoardPort,
  effect: RepeatEffect): Promise<void> {
  if (effect.kind !== 'input.bind' && effect.kind !== 'terminal.accept') return
  const saved = await memoryExecution(tx, effect.entityId)
  if (repeatTickIndex(saved.execution.input) !== undefined) return
  const source = `${effect.kind}:${effect.entityId}:${effect.digest}`
  if (effect.kind === 'input.bind') {
    const previous = saved.previousExecutionId ? [] : await continuations(tx, saved.work)
    if (previous.length) {
      for (const work of previous) {
        const key = work.kind === 'activation' ? work.activationId : work.slotId
        await lifecycle(tx, service, effect.entityId, `${source}:${key}`, 'admitted', { continuationOf: work })
      }
    } else {
      await lifecycle(tx, service, effect.entityId, source, saved.previousExecutionId ? 'retry_admitted' : 'admitted')
    }
    await reconcileMemoryHandoffsLocked(tx, service, effect.entityId, source)
    return
  }
  if (saved.execution.result?.outcome !== 'succeeded') return
  if (saved.version.definition.handoffs) {
    const result = parseWorkHandoffResult(saved.execution.result, workflowResultContext(saved.version, saved.execution))
    if (result.data.remainingFindings.length) {
      await lifecycle(tx, service, effect.entityId, source, 'blocked', { reason: memoryFindingReason(result.data.remainingFindings) })
      return
    }
    const outgoing = selectedWorkHandoffRoutes(saved.version.definition, saved.node.id, result)
    if (result.routing.kind === 'return' || outgoing.length) {
      await lifecycle(tx, service, effect.entityId, source, 'waiting_children')
      await reconcileMemoryHandoffsLocked(tx, service, effect.entityId, source)
      return
    }
  }
  await lifecycle(tx, service, effect.entityId, source, 'accepted')
  await reconcileMemoryHandoffsLocked(tx, service, effect.entityId, source)
}

export async function applyMemoryNativeLocked(tx: GraphTransactionSql, service: MemoryBoardPort,
  run: Pick<WorkflowRunV3, 'resultProtocol'>, change: RepeatNativeChange): Promise<void> {
  const source = `${change.sourceId}:${change.sourceRevision}`
  if (change.kind === 'launch') {
    if (repeatTickIndex(change.next.input) === undefined) await lifecycle(tx, service, change.next.id, source, 'launched')
    return
  }
  if (change.previous.state === 'completed' || change.next.state !== 'completed') return
  const outcome = change.next.result!.outcome
  // Coordinated results and their awaiting-acceptance fact commit through the collaboration hook.
  if (outcome === 'succeeded' && run.resultProtocol) return
  if (repeatTickIndex(change.next.input) === undefined) {
    const phase = outcome === 'succeeded' ? 'awaiting_acceptance' : outcome
    await lifecycle(tx, service, change.next.id, source, phase, {
      reason: outcome === 'succeeded' ? null : change.next.result!.error?.message ?? 'The execution was canceled.',
    })
    if (outcome !== 'succeeded') await reconcileMemoryHandoffsLocked(tx, service, change.next.id, source)
  }
}

export async function validateMemoryResultLocked(tx: GraphTransactionSql, service: MemoryBoardPort,
  execution: HarnessExecution, result: ExecutionResult): Promise<void> {
  if (!execution.resultProtocol || result.outcome !== 'succeeded') return
  const saved = await memoryExecution(tx, execution.id)
  const parsed = parseCoordinationResult(result.output, workflowResultContext(saved.version, execution)!)
  try {
    await service.applyResultLocked(tx, { subject: saved.subject, execution: saved.subject.execution,
      work: saved.work, sourceEventKey: `validate:${execution.id}`, result: parsed.board })
  } catch (error) {
    if (error instanceof DomainError && error.status < 500) throw new MemoryResultRejected(error)
    throw error
  }
}
