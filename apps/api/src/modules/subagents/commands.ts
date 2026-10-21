import { randomUUID } from 'node:crypto'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { RunSubagentCommandReceiptSchema, RunSubagentInputSchema, RunSubagentInterruptSchema, RunSubagentRespondSchema,
  type RunSubagentCommandReceipt } from '@foreman-code/contracts/subagents'
import { DomainError } from '../errors.js'
import { subagentAvailableActions } from './capabilities.js'
import { reconcileRunSubagents } from './projection.js'
import { reconcileSubagentCommand } from './recovery.js'
import { SubagentDispatchRejectedError } from './controlErrors.js'
import type { SubagentServicePort, SubagentReadScope } from './types.js'
import { withInteractionResponse } from '@foreman-code/contracts'
import type { z } from 'zod'

type SubagentCommandInput = z.infer<typeof RunSubagentInputSchema> | z.infer<typeof RunSubagentInterruptSchema>
  | z.infer<typeof RunSubagentRespondSchema>

async function updateReceipt(scope: SubagentReadScope, receipt: RunSubagentCommandReceipt) {
  await scope.sql.query('update run_subagent_command_receipts set record=$2::jsonb where id=$1', [receipt.id, JSON.stringify(RunSubagentCommandReceiptSchema.parse(receipt))])
}
export async function executeSubagentCommand(service: SubagentServicePort, principal: ManagementPrincipal, source: 'http' | 'mcp',
  operation: RunSubagentCommandReceipt['operation'], raw: unknown): Promise<RunSubagentCommandReceipt> {
  let input: SubagentCommandInput
  let action: 'runs:subagents:input' | 'runs:stop' | 'interactions:respond'
  if (operation === 'run_subagent_input_v1') {
    input = RunSubagentInputSchema.parse(raw)
    action = 'runs:subagents:input'
  } else if (operation === 'run_subagent_respond_v1') {
    input = RunSubagentRespondSchema.parse(raw)
    action = 'interactions:respond'
  } else {
    input = RunSubagentInterruptSchema.parse(raw)
    action = 'runs:stop'
  }
  const available = (actions: ReturnType<typeof subagentAvailableActions>) => {
    if (operation === 'run_subagent_respond_v1') return actions.respond
    return operation === 'run_subagent_input_v1' ? actions.sendInput : actions.interrupt
  }
  const inputHash = commandInputHash(input)
  let isNew = false
  const accepted = await service.scoped(principal, input, action, async scope => {
    await reconcileRunSubagents(scope.sql, input.runId)
    await scope.sql.query('select pg_advisory_xact_lock(hashtext($1))', [JSON.stringify(['subagent-command', principal.id, operation, input.commandId])])
    const child = await service.child(scope, input)
    const existing = (await scope.sql.query<{ input_hash: string; record: unknown }>(`select input_hash,record from run_subagent_command_receipts
      where principal_id=$1 and operation=$2 and command_id=$3 for update`, [principal.id, operation, input.commandId])).rows[0]
    if (existing) {
      if (existing.input_hash !== inputHash) throw new DomainError('COMMAND_ID_CONFLICT', 'This command ID was already bound to different input.', 409)
      return RunSubagentCommandReceiptSchema.parse(existing.record)
    }
    if (child.revision !== input.expectedRevision) throw new DomainError('SUBAGENT_REVISION_CONFLICT', 'The child revision changed; read it again.', 409)
    const lease = service.controls(child)
    const actions = subagentAvailableActions(child, scope.principal, scope.stopped, lease)
    if (!available(actions) || !lease) {
      throw new DomainError(actions.blockedReason ?? 'SUBAGENT_ACTION_UNAVAILABLE', 'This child action is not currently qualified and available.', 409)
    }
    lease.assertCurrent()
    let response: RunSubagentCommandReceipt['response']
    if (operation === 'run_subagent_respond_v1' && 'nativeRequestId' in input) {
      const pending = lease.pendingInteraction?.()
      const offered = pending?.responseOptions.find(option => option.optionId === input.optionId)
      if (!pending || !offered || pending.turn.nativeRequestId !== input.nativeRequestId) {
        throw new DomainError('SUBAGENT_RESPONSE_STALE', 'Read the current child request before answering.', 409)
      }
      const prior = await scope.sql.query(`select 1 from run_subagent_command_receipts
        where subagent_id=$1 and operation='run_subagent_respond_v1'
          and record->'response'->>'nativeRequestId'=$2 and record->>'state' <> 'rejected'`,
      [child.id, pending.turn.nativeRequestId])
      if (prior.rowCount) throw new DomainError('SUBAGENT_RESPONSE_RECORDED', 'This child response is already recorded.', 409)
      response = { nativeRequestId: pending.turn.nativeRequestId!, nativeRequestType: pending.nativeRequestType,
        option: withInteractionResponse(offered, input.response) }
    }
    const now = new Date().toISOString()
    const receipt = RunSubagentCommandReceiptSchema.parse({ schemaVersion: 1, id: randomUUID(), principalId: principal.id, operation, commandId: input.commandId,
      workspaceId: input.workspaceId, runId: input.runId, subagentId: child.id, expectedRevision: input.expectedRevision,
      nativeGeneration: lease.generation,
      nativeTurnId: response ? lease.pendingInteraction!()!.turn.nativeTurnId ?? null : lease.nativeTurnId,
      nativeCorrelationId: `msg_${randomUUID().replaceAll('-', '')}`,
      ...(response ? { response } : {}),
      state: 'accepted', acceptedAt: now, updatedAt: now })
    await scope.sql.query(`insert into run_subagent_command_receipts(id,principal_id,operation,command_id,subagent_id,input_hash,record)
      values($1,$2,$3,$4,$5,$6,$7::jsonb)`, [receipt.id, principal.id, operation, input.commandId, child.id, inputHash, JSON.stringify(receipt)])
    await scope.sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details) values($1,$2,$3,$4,'succeeded',$5::jsonb)`,
      [principal.id, source, operation, child.id, JSON.stringify({ commandId: input.commandId, receiptId: receipt.id, state: 'accepted' })])
    isNew = true
    return receipt
  })
  // Retries only read receipts. In-flight or uncertain commands are never dispatched a second time.
  if (!isNew) return accepted.state === 'uncertain'
    ? await reconcileSubagentCommand(service, principal, { ...input, receiptId: accepted.id }, source) ?? accepted : accepted
  const dispatching = { ...accepted, state: 'dispatching' as const, updatedAt: new Date().toISOString() }
  await service.scoped(principal, input, action, async scope => { await updateReceipt(scope, dispatching) })
  const dispatch = await service.scoped(principal, input, action, async scope => {
    const child = await service.child(scope, input)
    const lease = service.controls(child)
    const actions = subagentAvailableActions(child, scope.principal, scope.stopped, lease)
    const turnId = accepted.response ? lease?.pendingInteraction?.()?.turn.nativeTurnId ?? null : lease?.nativeTurnId
    if (!lease || !lease.matches(child) || lease.generation !== accepted.nativeGeneration || turnId !== accepted.nativeTurnId
      || child.revision !== accepted.expectedRevision || !available(actions)) return undefined
    lease.assertCurrent()
    return lease
  })
  // Native callbacks may append Run evidence on another connection. No SQL/authority row lock spans native dispatch.
  let state: RunSubagentCommandReceipt['state'] = 'rejected'
  let reasonCode: string | undefined = 'SUBAGENT_DISPATCH_FENCE_CHANGED'
  if (dispatch) {
    try {
      dispatch.assertCurrent()
      if (operation === 'run_subagent_input_v1' && 'text' in input && typeof input.text === 'string') await dispatch.sendInput!(dispatching, input.text)
      else if (operation === 'run_subagent_respond_v1') await dispatch.respond!(dispatching)
      else await dispatch.interrupt!(dispatching)
      state = 'acknowledged'; reasonCode = undefined
    } catch (error) {
      state = error instanceof SubagentDispatchRejectedError ? 'rejected' : 'uncertain'
      reasonCode = state === 'rejected' ? 'SUBAGENT_NATIVE_REJECTED' : 'SUBAGENT_NATIVE_DELIVERY_UNCERTAIN'
    }
  }
  const outcome = RunSubagentCommandReceiptSchema.parse({ ...dispatching, state, updatedAt: new Date().toISOString(), ...(reasonCode ? { reasonCode } : {}) })
  // This is server-owned delivery evidence. A grant revoked during native IO must not erase it or cause replay.
  await service.pool.query(`update run_subagent_command_receipts set record=$2::jsonb where id=$1 and record->>'state'='dispatching'`, [accepted.id, JSON.stringify(outcome)])
  await service.pool.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details) values($1,$2,$3,$4,$5,$6::jsonb)`,
    [principal.id, source, operation, accepted.subagentId, state === 'rejected' ? 'failed' : 'succeeded', JSON.stringify({ receiptId: accepted.id, state })])
  return service.scoped(principal, input, action, async scope => {
    await service.child(scope, input)
    const persisted = (await scope.sql.query<{ record: unknown }>('select record from run_subagent_command_receipts where id=$1 and principal_id=$2', [accepted.id, principal.id])).rows[0]
    return RunSubagentCommandReceiptSchema.parse(persisted?.record)
  })
}
