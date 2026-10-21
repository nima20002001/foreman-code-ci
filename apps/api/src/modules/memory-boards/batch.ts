import { randomUUID } from 'node:crypto'
import { MemoryBoardMutationSchema, type AgentSubject, type LogicalWorkRef, type MemoryBoardMutation } from '@foreman-code/contracts'
import { lockSelectionRuns } from './runLocks.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { BoardRow, MemoryBoardAuthority, MemoryTool, MutationContext, Operation } from './types.js'
import { authorizeCaller, authorizeSubject } from './authorization.js'
import { invalid, nodeKey, workKey } from './identity.js'
import { loadBoard, lockIdentity, peekBoardScope } from './repository.js'
import { checkCapacity, mutateLocked } from './mutations.js'

export function mutationTool(operation: MemoryBoardMutation): MemoryTool { return `memory_${operation.kind}` }
export function parseOperations(input: readonly MemoryBoardMutation[]): Operation[] {
  if (!input.length || input.length>32 || Buffer.byteLength(JSON.stringify(input))>65536) invalid('Use 1–32 memory operations and at most 64 KiB per batch.')
  return input.map(value => { const parsed=MemoryBoardMutationSchema.parse(value);return { ...parsed,commandId:parsed.commandId ?? randomUUID() } })
}
export async function lockSelections(tx: GraphTransactionSql, operations: readonly Operation[], extraWork: string[] = []): Promise<void> {
  const work = new Set<string>(extraWork), nodes = new Set<string>()
  for (const operation of operations) if ('workSelections' in operation) for (const selection of operation.workSelections ?? []) {
    if (selection.kind==='current') work.add(workKey(selection.work))
    else nodes.add(nodeKey(selection.node))
  }
  for (const key of [...work].sort()) await lockIdentity(tx,`work:${key}`)
  for (const key of [...nodes].sort()) await lockIdentity(tx,`node:${key}`)
}
export async function applyBatch(tx: GraphTransactionSql, authority: MemoryBoardAuthority, operations: Operation[],
  caller: { principal:ManagementPrincipal } | { subject:AgentSubject }, now: string, extraBoardIds: string[] = []): Promise<{
    receipts: Awaited<ReturnType<typeof mutateLocked>>[]; rows: Map<string,BoardRow>
  }> {
  const contexts: MutationContext[] = []
  for (const operation of operations) {
    const scope = await peekBoardScope(tx,operation.boardId)
    contexts.push('principal' in caller
      ? await authorizeCaller(tx,authority,caller.principal,scope,mutationTool(operation))
      : await authorizeSubject(tx,authority,caller.subject,scope,mutationTool(operation)))
  }
  const currentWork: LogicalWorkRef[] = []
  // Default current-work binding also shares the lifecycle's work serialization.
  for (const context of contexts) if (context.subject?.kind === 'execution') {
    const current = await authority.currentWork(tx,context.subject)
    if (current) currentWork.push(current.work)
  }
  await lockSelectionRuns(tx, operations, currentWork)
  await lockSelections(tx,operations,currentWork.map(workKey))
  const commands = [...new Set(operations.map((operation,index) => `${contexts[index]!.principalId}:${operation.commandId}`))].sort()
  for (const key of commands) await lockIdentity(tx,`command:${key}`)
  const rows = new Map<string,BoardRow>()
  for (const boardId of [...new Set([...operations.map(operation=>operation.boardId),...extraBoardIds])].sort()) rows.set(boardId,await loadBoard(tx,boardId))
  const receipts = []
  for (let index=0;index<operations.length;index+=1) {
    const operation=operations[index]!
    receipts.push(await mutateLocked(tx,authority,rows.get(operation.boardId)!,contexts[index]!,operation,now))
  }
  checkCapacity(rows.values())
  return { receipts,rows }
}
