import { randomUUID } from 'node:crypto'
import type {
  MemoryBoardScope, MemoryCard, MemoryCardWorkBinding,
  MemoryCardWorkClaim, MemoryCardWorkSelection,
} from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { MemoryBoardAuthority, MutationContext, Operation } from './types.js'
import { invalid, nodeKey, same, scopeContains, workKey } from './identity.js'

const liveStates = new Set(['queued','running','awaiting_acceptance','waiting_children','blocked'])
export function unresolved(binding: MemoryCardWorkBinding): boolean {
  return !binding.resolution && liveStates.has(binding.state)
}
function cardWorkReason(reason: string | null): string {
  const text = reason?.trim() || 'Linked work needs attention.'
  let length = 0
  // Bound the display field without splitting a Unicode character; bindings retain the full cause.
  for (const character of text) {
    if (length + character.length > 1000) break
    length += character.length
  }
  return text.slice(0, length)
}
export function aggregateCard(card: MemoryCard, bindings: MemoryCardWorkBinding[], claims: MemoryCardWorkClaim[], autoComplete = true): MemoryCard {
  if (card.status === 'done' && card.completionKind === 'dropped') return card
  const required = bindings.filter(binding => !binding.resolution)
  const blocked = required.find(binding => ['blocked','failed','canceled'].includes(binding.state))
  if (blocked) return { ...card, status: 'blocked', completionKind: null, reason: cardWorkReason(blocked.reason) }
  if (required.some(binding => ['running','awaiting_acceptance','waiting_children'].includes(binding.state))) {
    return { ...card, status: 'doing', completionKind: null, reason: null }
  }
  if (required.some(binding => binding.state === 'queued')) return { ...card, status: 'todo', completionKind: null, reason: null }
  if (autoComplete && required.length && required.every(binding => binding.state === 'accepted')
    && !claims.some(claim => claim.state === 'armed') && card.status !== 'blocked' && card.status !== 'waiting_for_user') {
    return { ...card, status: 'done', completionKind: 'completed', reason: null }
  }
  return card
}
export function validateCardState(card: MemoryCard, before?: MemoryCard): void {
  if ((card.status === 'done') !== (card.completionKind !== null)) invalid('Completion kind is required exactly for Done tasks.')
  if ((card.status === 'blocked' || card.status === 'waiting_for_user' || card.completionKind === 'dropped'
    || (before?.status === 'done' && card.status !== 'done')) && !card.reason?.trim()) {
    invalid('Blocked, waiting-for-user, dropped and reopened tasks need a reason.')
  }
}
export async function validateLinks(tx: GraphTransactionSql, authority: MemoryBoardAuthority,
  scope: MemoryBoardScope, card: MemoryCard): Promise<void> {
  const links = [...card.linkedNodes, ...(card.assignee ? [card.assignee] : [])]
  if (new Set(card.linkedNodes.map(nodeKey)).size !== card.linkedNodes.length) invalid('Duplicate task links are not allowed.')
  for (const node of links) {
    if (!scopeContains(scope,node)) invalid('The selected agent is outside this board scope.')
    await authority.node(tx,node,scope)
  }
}
export function resolveTerminalWork(card: MemoryCard, before: MemoryCard | undefined,
  bindings: MemoryCardWorkBinding[], claims: MemoryCardWorkClaim[], operation: Operation, now: string): void {
  const reopening = before?.status === 'done' && card.status !== 'done'
    || (before?.status === 'blocked' && !['blocked','done'].includes(card.status))
  if (card.status === 'done' && bindings.some(unresolved)) {
    throw new DomainError('ACTIVE_WORK_UNRESOLVED', 'Linked work is still active. Finish that work before completing or dropping this task.',409,
      { card: before ?? card, bindings: bindings.filter(unresolved) })
  }
  const failed = bindings.filter(binding => !binding.resolution && ['failed','canceled'].includes(binding.state))
  if (failed.length && (reopening || card.completionKind === 'dropped')) {
    if (!card.reason?.trim()) invalid('Resolving failed work requires a reason.')
    for (const binding of failed) {
      binding.resolution = { kind: card.completionKind === 'dropped' ? 'dropped' : 'reopened',
        commandId: operation.commandId, reason: card.reason, resolvedAt: now }
      binding.revision += 1
    }
  } else if (failed.length && card.status === 'done') {
    throw new DomainError('ACTIVE_WORK_UNRESOLVED','Failed work must be explicitly reopened or dropped with a reason.',409)
  }
  if (card.status === 'done') for (const claim of claims) if (claim.state === 'armed') claim.state = 'canceled'
}
export async function selectWork(tx: GraphTransactionSql, authority: MemoryBoardAuthority, scope: MemoryBoardScope,
  card: MemoryCard, selections: MemoryCardWorkSelection[] | undefined, context: MutationContext,
  existing: MemoryCardWorkBinding[], claims: MemoryCardWorkClaim[], creating: boolean): Promise<void> {
  let chosen = selections
  if (chosen === undefined && creating && context.subject?.kind === 'execution') {
    const current = await authority.currentWork(tx,context.subject)
    if (current?.isBusinessWork) chosen = [{ kind: 'current', work: current.work }]
  }
  // Assignment and display links never arm automatic completion. The UI can
  // explicitly choose Next activation; an omitted selection stays unbound.
  const keys = new Set<string>()
  for (const selection of chosen ?? []) {
    const key = selection.kind === 'current' ? `work:${workKey(selection.work)}` : `node:${nodeKey(selection.node)}`
    if (keys.has(key)) invalid('Select each work item only once.')
    keys.add(key)
    if (selection.kind === 'current') {
      const resolved = await authority.work(tx,selection.work)
      if (!resolved.isBusinessWork) invalid('Interval checks cannot be selected as task obligations.')
      if (!same(resolved.work,selection.work) || !scopeContains(scope,resolved.node)) invalid('The selected work is outside this board.')
      await authority.node(tx,resolved.node,scope)
      if (!existing.some(binding => same(binding.work,selection.work))) existing.push({
        id: randomUUID(), cardId: card.id, node: resolved.node, work: resolved.work,
        state: resolved.state, currentExecutionId: resolved.currentExecutionId, reason: resolved.reason, revision: 1,
        ...(resolved.parentRequestId ? { parentRequestId: resolved.parentRequestId } : {}),
      })
    } else {
      if (!scopeContains(scope,selection.node)) invalid('The next activation is outside this board.')
      await authority.node(tx,selection.node,scope)
      if (!claims.some(claim => claim.state === 'armed' && same(claim.node,selection.node))) claims.push({
        id: randomUUID(), cardId: card.id, node: selection.node, state: 'armed', consumedBy: null,
      })
    }
  }
}
