import { randomUUID } from 'node:crypto'
import { BoardLifecycleFactSchema, type BoardLifecycleFact, type BoardApplicationReceipt,
  type MemoryCardWorkBinding, type MemoryCardWorkClaim } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import type { BoardRow, MemoryBoardAuthority } from './types.js'
import { inputHash, invalid, nodeKey, same, workKey } from './identity.js'
import { aggregateCard } from './work.js'
import { bindingsFor, cardBlockerSource, cardById, claimsFor, loadBoard, lockIdentity, saveBinding, saveCard, saveClaim } from './repository.js'

export async function beginEffect(tx: GraphTransactionSql, kind: 'result' | 'lifecycle',
  work: BoardLifecycleFact['work'], sourceEventKey: string, input: unknown): Promise<{
    key: string; hash: string; replay?: BoardApplicationReceipt
  }> {
  const key = inputHash({ kind,work,sourceEventKey }), hash = inputHash(input)
  await lockIdentity(tx,`effect:${key}`)
  const result = await tx.query<{ input_hash: string; receipt: BoardApplicationReceipt }>(
    'select input_hash,receipt from memory_board_effects where effect_key=$1',[key])
  const saved = result.rows[0]
  if (saved && saved.input_hash !== hash) throw new DomainError('COMMAND_INPUT_CONFLICT','This engine effect identity has different input.',409)
  return { key,hash,...(saved ? { replay:{ ...saved.receipt,replayed:true } } : {}) }
}
export async function finishEffect(tx: GraphTransactionSql, key: string, hash: string, receipt: BoardApplicationReceipt): Promise<BoardApplicationReceipt> {
  await tx.query('insert into memory_board_effects(effect_key,input_hash,receipt) values($1,$2,$3)',[key,hash,receipt])
  return receipt
}
export function effectReceipt(sourceEventKey: string, rows: Iterable<BoardRow>, changedCardIds: string[], commandIds: string[] = []): BoardApplicationReceipt {
  return { applicationId:randomUUID(),sourceEventKey,commandIds,changedCardIds:[...new Set(changedCardIds)],
    boardRevisions:[...rows].map(row => ({ boardId:row.board.id,revision:row.board.revision })),replayed:false }
}
function bindingState(phase: BoardLifecycleFact['phase']): MemoryCardWorkBinding['state'] {
  switch (phase) {
    case 'admitted':
    case 'retry_admitted':
    case 'continuation_admitted': return 'queued'
    case 'launched': return 'running'
    default: return phase
  }
}
function nextBinding(binding: MemoryCardWorkBinding, fact: BoardLifecycleFact): MemoryCardWorkBinding {
  if (binding.resolution) return binding
  const continuing = fact.phase === 'continuation_admitted'
    || ((fact.phase === 'admitted' || fact.phase === 'launched') && fact.continuationOf !== undefined)
  if (continuing && fact.controlContinuationId) {
    if (!fact.previousExecution || !fact.execution) invalid('A control continuation needs the old and successor executions.')
    if (binding.currentExecutionId === fact.execution.executionId) return binding
    if (binding.currentExecutionId !== fact.previousExecution.executionId) {
      throw new DomainError('STALE_EXECUTION','The continuation no longer owns this task binding.',409)
    }
  } else if (!(continuing && fact.continuationOf) && fact.execution && binding.currentExecutionId && fact.execution.executionId !== binding.currentExecutionId
    && !['admitted','retry_admitted'].includes(fact.phase)) {
    throw new DomainError('STALE_EXECUTION','This callback belongs to an older execution.',409)
  }
  if (binding.state === 'accepted' && !continuing) return binding
  if (['failed','canceled'].includes(binding.state) && !['retry_admitted','continuation_admitted'].includes(fact.phase)) return binding
  const state = bindingState(fact.phase)
  const next: MemoryCardWorkBinding = { ...binding,work:fact.work,state,
    currentExecutionId: fact.execution?.executionId ?? binding.currentExecutionId,
    reason: ['blocked','failed','canceled'].includes(state) ? fact.reason : null,
    ...(fact.requestGroupId ? { parentRequestId:fact.requestGroupId } : {}) }
  if (same(next,binding)) return binding
  next.revision += 1
  return next
}
async function claimAdmission(tx: GraphTransactionSql, row: BoardRow, cardId: string, fact: BoardLifecycleFact,
  bindings: MemoryCardWorkBinding[], claims: MemoryCardWorkClaim[]): Promise<boolean> {
  if (fact.phase !== 'admitted' || fact.continuationOf) return false
  let changed = false
  for (const claim of claims) if (claim.state === 'armed' && nodeKey(claim.node) === nodeKey(fact.agent)) {
    const consumed: MemoryCardWorkClaim = { ...claim,state:'consumed',consumedBy:fact.work }
    await saveClaim(tx,row.board.id,consumed)
    Object.assign(claim,consumed)
    if (!bindings.some(binding => same(binding.work,fact.work))) bindings.push({ id:randomUUID(),cardId,
      node:claim.node,work:fact.work,state:'queued',reason:null,revision:1,
      currentExecutionId:fact.execution?.executionId ?? null })
    changed = true
  }
  return changed
}
async function projectCard(tx: GraphTransactionSql, row: BoardRow, cardId: string, fact: BoardLifecycleFact, now: string): Promise<boolean> {
  const card = await cardById(tx,row.board.id,cardId), bindings = await bindingsFor(tx,cardId), claims = await claimsFor(tx,cardId)
  const previous = structuredClone(bindings)
  let changed = await claimAdmission(tx,row,cardId,fact,bindings,claims)
  for (let index=0;index<bindings.length;index+=1) {
    const binding = bindings[index]!
    if (!same(binding.work,fact.continuationOf ?? fact.work)) continue
    if (nodeKey(binding.node) !== nodeKey(fact.agent)) invalid('The engine fact addresses another node.')
    const next = nextBinding(binding,fact)
    if (!same(binding,next) || !previous.some(old => old.id === next.id)) {
      await saveBinding(tx,row.board.id,next); bindings[index] = next; changed = true
    }
  }
  if (!changed) return false
  const blockerSource = await cardBlockerSource(tx,card.id)
  const base = blockerSource === 'engine' ? { ...card,status:'todo' as const,completionKind:null,reason:null } : card
  const manualBlocker = base.status === 'blocked' && blockerSource === 'manual'
  let projected = manualBlocker ? base : aggregateCard(base,bindings,claims)
  const continuationAdmitted = fact.phase === 'continuation_admitted'
    || (fact.phase === 'admitted' && fact.continuationOf !== undefined)
  if (continuationAdmitted && !manualBlocker && projected.status !== 'blocked') {
    projected = { ...projected,status:'doing',completionKind:null,reason:null }
  }
  await saveCard(tx,row,card,projected,{ actor:{ kind:'engine',id:fact.agent.agentId,displayName:fact.agent.displayName },
    sourceEventKey:fact.sourceEventKey,now,preserveBlocker:manualBlocker,
    provenance:{ work:fact.work,...(fact.execution ? { execution:fact.execution } : {}) } })
  return true
}
export async function applyLifecycle(tx: GraphTransactionSql, authority: MemoryBoardAuthority,
  input: BoardLifecycleFact, now: string): Promise<BoardApplicationReceipt> {
  assertGraphTransaction(tx)
  const fact = BoardLifecycleFactSchema.parse(input)
  if (fact.phase === 'accepted' && fact.outstandingRequestIds.length) invalid('Work with outstanding requests cannot complete.')
  if (['blocked','failed','canceled'].includes(fact.phase) && !fact.reason?.trim()) invalid('A negative work fact needs its cause.')
  await authority.lifecycle(tx,fact.agent,fact.work,fact.execution?.executionId)
  const workKeys = [...new Set([workKey(fact.work),...(fact.continuationOf ? [workKey(fact.continuationOf)] : [])])].sort()
  for (const key of workKeys) await lockIdentity(tx,`work:${key}`)
  if (fact.phase === 'admitted' && !fact.continuationOf) await lockIdentity(tx,`node:${nodeKey(fact.agent)}`)
  const effect = await beginEffect(tx,'lifecycle',fact.work,fact.sourceEventKey,fact)
  if (effect.replay) return effect.replay
  const matched = await tx.query<{ board_id:string;card_id:string }>(
    `select board_id,card_id from memory_card_bindings where work_key=any($1::text[])
      union select board_id,card_id from memory_card_claims where node_key=$2 and state='armed' and $3::boolean`,
    [workKeys,nodeKey(fact.agent),fact.phase==='admitted' && !fact.continuationOf])
  const rows = new Map<string,BoardRow>()
  for (const boardId of [...new Set(matched.rows.map(row => row.board_id))].sort()) rows.set(boardId,await loadBoard(tx,boardId))
  const changed: string[] = []
  for (const match of matched.rows.sort((a,b) => a.card_id.localeCompare(b.card_id))) {
    if (await projectCard(tx,rows.get(match.board_id)!,match.card_id,fact,now)) changed.push(match.card_id)
  }
  return finishEffect(tx,effect.key,effect.hash,effectReceipt(fact.sourceEventKey,rows.values(),changed))
}
