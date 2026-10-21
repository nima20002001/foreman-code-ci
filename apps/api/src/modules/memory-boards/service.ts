import { BoardResultSchema, type MemoryBoardMutation } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { MemoryBoardPort } from '../collaboration/ports.js'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import type { BoardRow, ChangesRequest, MemoryBoardDependencies, MutationReceipt, Operation, ReadRequest } from './types.js'
import { authorizeCaller } from './authorization.js'
import { applyBatch, lockSelections, mutationTool, parseOperations } from './batch.js'
import { lockSelectionRuns } from './runLocks.js'
import { readDigest } from './digest.js'
import { inputHash, invalid, same, scopeContains, workKey } from './identity.js'
import { applyLifecycle, beginEffect, effectReceipt, finishEffect } from './lifecycle.js'
import { replayCommand } from './mutations.js'
import { commandReceipt, ensureBoard, findScopeBoard, loadBoard, lockIdentity, peekBoardScope, readBoard } from './repository.js'
import { MemoryChangesInputSchema, MemoryReadInputSchema, readChanges, readProjection } from './reads.js'

export class MemoryBoardService implements MemoryBoardPort {
  constructor(private readonly dependencies: MemoryBoardDependencies) {}
  private now(): string { return (this.dependencies.now?.() ?? new Date()).toISOString() }

  async read(principal: ManagementPrincipal, input: ReadRequest) {
    const request = MemoryReadInputSchema.parse(input)
    let boardId = request.boardId
    if (request.scope) {
      const scope = request.scope
      const existing = await this.dependencies.readTransaction(async tx => {
        await authorizeCaller(tx, this.dependencies.authority, principal, scope, 'memory_board_get')
        await this.dependencies.authority.scope(tx, scope)
        return findScopeBoard(tx, scope)
      })
      boardId = existing?.board.id ?? await this.dependencies.transaction(async tx => {
        await authorizeCaller(tx, this.dependencies.authority, principal, scope, 'memory_board_get')
        await this.dependencies.authority.scope(tx, scope)
        return (await ensureBoard(tx, scope)).board.id
      })
    }
    return this.dependencies.readTransaction(async tx => {
      const scope = await peekBoardScope(tx, boardId!)
      const context = await authorizeCaller(tx, this.dependencies.authority, principal, scope, 'memory_board_get')
      await this.dependencies.authority.scope(tx, scope)
      return readProjection(tx, await readBoard(tx, boardId!), request, context.principalId)
    })
  }
  async changes(principal: ManagementPrincipal, input: ChangesRequest) {
    const request = MemoryChangesInputSchema.parse(input)
    return this.dependencies.readTransaction(async tx => {
      const scope = await peekBoardScope(tx,request.boardId)
      await authorizeCaller(tx,this.dependencies.authority,principal,scope,'memory_board_changes_read')
      return readChanges(tx,await readBoard(tx,request.boardId),request)
    })
  }
  async mutate(principal: ManagementPrincipal, input: MemoryBoardMutation): Promise<MutationReceipt> {
    const operation = parseOperations([input])[0]!
    try {
      return await this.dependencies.transaction(async tx => {
        const result = await applyBatch(tx,this.dependencies.authority,[operation],{ principal },this.now())
        return result.receipts[0]!
      })
    } catch (error) {
      if (!(error instanceof DomainError) || error.status>=500 || ['ACCESS_DENIED','AUTH_REQUIRED','NOT_FOUND','COMMAND_INPUT_CONFLICT'].includes(error.code)) throw error
      // The mutation transaction has rolled back. A second transaction records
      // only the definitive rejection; uncertain connection/commit errors stay unknown.
      const recovered = await this.recordRejection(principal,operation,error)
      if (recovered) return recovered
      throw error
    }
  }
  private async recordRejection(principal: ManagementPrincipal, operation: Operation, error: DomainError): Promise<MutationReceipt | undefined> {
    return this.dependencies.transaction(async tx => {
      const scope = await peekBoardScope(tx,operation.boardId)
      const context = await authorizeCaller(tx,this.dependencies.authority,principal,scope,mutationTool(operation))
      await lockIdentity(tx,`command:${context.principalId}:${operation.commandId}`)
      const stored = await commandReceipt(tx,context.principalId,operation.commandId)
      if (stored) return replayCommand(stored,operation)
      await tx.query(`insert into memory_board_commands(principal_id,command_id,board_id,input_hash,rejection)
        values($1,$2,$3,$4,$5)`,[context.principalId,operation.commandId,operation.boardId,inputHash(operation),
        { code:error.code,message:error.message,status:error.status,...(error.details ? { details:error.details } : {}) }])
      return undefined
    })
  }
  readDigest(input: Parameters<MemoryBoardPort['readDigest']>[0]) {
    return this.dependencies.readTransaction(tx => readDigest(tx,this.dependencies.authority,input))
  }
  readDigestLocked(tx: GraphTransactionSql, input: Parameters<MemoryBoardPort['readDigest']>[0]) {
    assertGraphTransaction(tx)
    return readDigest(tx, this.dependencies.authority, input)
  }
  applyLifecycleLocked(tx: GraphTransactionSql, fact: Parameters<MemoryBoardPort['applyLifecycleLocked']>[1]) {
    return applyLifecycle(tx,this.dependencies.authority,fact,this.now())
  }
  async applyResultLocked(tx: GraphTransactionSql, input: Parameters<MemoryBoardPort['applyResultLocked']>[1]) {
    assertGraphTransaction(tx)
    const result = BoardResultSchema.parse(input.result)
    if (Buffer.byteLength(JSON.stringify(result))>65536) invalid('Board effects exceed 64 KiB.')
    if (input.subject.kind !== 'execution' || !same(input.subject.execution,input.execution)
      || input.execution.runId!==input.work.runId || input.execution.workflowVersionId!==input.work.workflowVersionId) {
      invalid('Board result effects must belong to this exact execution and work.')
    }
    const authority=this.dependencies.authority
    const access = await authority.subject(tx,input.subject)
    if (!same(access.subject,input.subject)) throw new DomainError('ACCESS_DENIED','The saved agent identity has changed.',403)
    const operations=result.kind==='changes' ? parseOperations(result.operations) : []
    await lockSelectionRuns(tx, operations, [input.work])
    await lockSelections(tx,operations,[workKey(input.work)])
    const effect=await beginEffect(tx,'result',input.work,input.sourceEventKey,input)
    if (effect.replay) return effect.replay
    await authority.lifecycle(tx,input.subject.agent,input.work,input.execution.executionId)
    const current=await authority.currentWork(tx,input.subject)
    if (!current || !same(current.work,input.work) || current.currentExecutionId!==input.execution.executionId) {
      throw new DomainError('STALE_EXECUTION','This result no longer owns the logical work.',409)
    }
    if (!access.tools.some(tool => tool.startsWith('memory_')) && (result.kind!=='none' || result.reason!=='no_access')) {
      throw new DomainError('ACCESS_DENIED','This agent has no memory board access.',403)
    }
    const rows=new Map<string,BoardRow>(), changed:string[]=[], commands:string[]=[]
    const bound=await tx.query<{board_id:string}>('select distinct board_id from memory_card_bindings where work_key=$1',[workKey(input.work)])
    const boundIds=bound.rows.map(row=>row.board_id)
    if (result.kind==='changes') {
      if (access.readOnly) throw new DomainError('ACCESS_DENIED','Read-only agents cannot publish board changes.',403)
      const applied=await applyBatch(tx,authority,operations,{subject:input.subject},this.now(),boundIds)
      for (const [id,row] of applied.rows) rows.set(id,row)
      for (const receipt of applied.receipts) {
        commands.push(receipt.commandId)
        if (receipt.card && ['created','updated'].includes(receipt.outcome)) changed.push(receipt.card.id)
      }
    } else if (result.reason==='already_recorded') {
      for (const commandId of result.appliedCommandIds ?? []) {
        const recorded=await commandReceipt(tx,access.principalId,commandId)
        if (!recorded?.receipt) invalid('An already-recorded command has no successful receipt.')
        if(!scopeContains(await peekBoardScope(tx,recorded.board_id),access.subject.agent)) {
          throw new DomainError('ACCESS_DENIED','This recorded command belongs to another board scope.',403)
        }
        commands.push(commandId)
      }
    }
    if (result.kind==='none') for (const id of [...boundIds].sort()) rows.set(id,await loadBoard(tx,id))
    if (!current.isBusinessWork) {
      return finishEffect(tx,effect.key,effect.hash,effectReceipt(input.sourceEventKey,rows.values(),changed,commands))
    }
    const lifecycle=await applyLifecycle(tx,authority,{ sourceEventKey:`${input.sourceEventKey}:awaiting_acceptance`,
      agent:input.subject.agent,work:input.work,execution:input.execution,phase:'awaiting_acceptance',
      outstandingRequestIds:[],reason:null },this.now())
    for (const value of lifecycle.boardRevisions) {
      const row=rows.get(value.boardId)
      if (row) row.board={...row.board,revision:value.revision}
      else rows.set(value.boardId,await loadBoard(tx,value.boardId))
    }
    changed.push(...lifecycle.changedCardIds)
    return finishEffect(tx,effect.key,effect.hash,effectReceipt(input.sourceEventKey,rows.values(),changed,commands))
  }
  /** Subscribe before snapshot. The callback is only a wakeup; callers must read
   * authorized persisted changes and never trust notification payloads as data. */
  listen(boardId: string, changed: () => void, disconnected: () => void): Promise<() => void> {
    return this.dependencies.listen(boardId,changed,disconnected)
  }
}
