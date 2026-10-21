import { AcceptedChatResponseControlSchema, matchingChatResponseAcknowledgment, type ChatResponseAcknowledgment, type AcceptedChatResponseControl, type ChatResponseIdentity } from '@foreman-code/contracts/interaction-activity'
import type pg from 'pg'
import { isDeepStrictEqual } from 'node:util'

import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ActivityScope, NativeSessionReference } from '@foreman-code/contracts'
import type { NativeMessageSubmission } from '@foreman-code/contracts/claude'

import { commandInputHash } from '../commands/postgres.js'
import { expiredCommandResult } from '../commands/receiptRetention.js'
import { DomainError } from '../errors.js'
import { HarnessExecutionError } from '../harnesses/errors.js'
import { responseValueDigest } from '../interactions/delivery.js'

type Outcome<State> = { acceptedControl?: AcceptedChatResponseControl; providerAcknowledgment?: ChatResponseAcknowledgment } & (
  | { status: 'pending' | 'uncertain' }
  | { status: 'completed'; state: State }
  | { status: 'rejected'; error: { code: string; message: string; status: number; details?: Record<string, unknown> } }
)
interface Receipt<State> { target_key: string; input_hash: string; result: Outcome<State> }

function unconfirmed(requestId: string, prefix: string) {
  return new DomainError(`${prefix}_CONTROL_UNCONFIRMED`,
    'This control was recorded but its outcome is unconfirmed. Read the conversation; do not submit it again with a new request ID.',
    409, { requestId })
}

function exactAcknowledgment(control: AcceptedChatResponseControl, raw: unknown): ChatResponseAcknowledgment | undefined {
  const proof = matchingChatResponseAcknowledgment(control, raw)
  if (!proof || proof.responseDigest !== undefined
    && proof.responseDigest !== responseValueDigest(control.choice.response)) return undefined
  return proof
}

/**
 * A command receipt is NOT a model-turn receipt. Reserve in autocommit before any
 * external effect, using the existing durable management receipt table. A crash
 * or lost acknowledgement leaves a non-replayable pending/uncertain tombstone.
 * Authorization (including read access to the returned state) precedes execute,
 * even on receipt reads. No transaction/connection is held across native I/O.
 */
export class NativeConversationControlCommands<State> {
  private closing = false
  private readonly pending = new Set<Promise<State>>()

  constructor(private readonly pool: Pick<pg.Pool, 'query'>, private readonly contract: {
    operation: 'agent_chat_control' | 'operator_chat_control'; parse(value: unknown): State; prefix: string; label: string;
    recoverOutcome?(state: State, payload: unknown, requestId: string, principalId: string): boolean;
    auditOutcome?(state: State, payload: unknown): 'succeeded' | 'failed' | 'uncertain';
  }) {}

  execute(principal: ManagementPrincipal, source: 'http' | 'mcp', conversationId: string, requestId: string,
    payload: unknown, perform: (markDispatchAttempt: () => void) => Promise<State>,
    readCurrent?: () => Promise<State>,
    acceptedControl?: AcceptedChatResponseControl,
    responseEvidence?: () => ChatResponseAcknowledgment | undefined): Promise<State> {
    if (this.closing) return Promise.reject(new DomainError(`${this.contract.prefix}_CLOSING`, `${this.contract.label} is shutting down.`, 503))
    const task = this.reserve(principal, source, conversationId, requestId, payload, perform, readCurrent, acceptedControl, responseEvidence)
    this.pending.add(task)
    void task.finally(() => { this.pending.delete(task) }).catch(() => { /* ignore: the owner awaits the original promise; this observer prevents a duplicate unhandled rejection. */ })
    return task
  }

  async drain(): Promise<void> {
    this.closing = true
    await Promise.allSettled([...this.pending])
  }

  /** Observation may settle the original fence, never replay the native effect or change its accepted choice. */
  async reconcileResponses(conversationId: string, modelRequestId: string, scope: ActivityScope,
    session: NativeSessionReference, identity: ChatResponseIdentity, proofs: readonly ChatResponseAcknowledgment[], state: State): Promise<void> {
    await this.reconcile(conversationId, modelRequestId, scope, session, identity, proofs, state)
  }

  async reconcileStoredResponses(conversationId: string, modelRequestId: string, scope: ActivityScope,
    session: NativeSessionReference, submission: NativeMessageSubmission, state: State): Promise<void> {
    if (session.harness !== 'claude' || submission.nativeSessionId !== session.nativeSessionId) return
    await this.reconcile(conversationId, modelRequestId, scope, session,
      { kind: 'message', nativeMessageId: submission.nativeMessageId }, [], state)
  }

  private async reconcile(conversationId: string, modelRequestId: string, scope: ActivityScope,
    session: NativeSessionReference, identity: ChatResponseIdentity | { kind: 'message'; nativeMessageId: string },
    proofs: readonly ChatResponseAcknowledgment[], state: State): Promise<void> {
    const rows = (await this.pool.query<{ principal_id: string; command_id: string; result: Outcome<State>; source: 'http' | 'mcp' }>(`
      select r.principal_id,r.command_id,r.result,a.source from management_command_receipts r
      join lateral (select source from management_audit where principal_id=r.principal_id and action=r.operation
        and target_key=r.target_key and details->>'commandId'=r.command_id and details->>'phase'='reserved'
        order by sequence limit 1) a on true
      where r.target_key=$1 and r.operation=$2
        and (r.result->>'status' in ('pending','uncertain')
          or (r.result->>'status'='completed' and not (r.result ? 'providerAcknowledgment')))
        and r.result#>>'{acceptedControl,modelRequestId}'=$3`, [conversationId, this.contract.operation, modelRequestId])).rows
    for (const row of rows) {
      const parsed = AcceptedChatResponseControlSchema.safeParse(row.result.acceptedControl)
      if (!parsed.success) continue
      const control = parsed.data
      if (control.conversationId !== conversationId || JSON.stringify(control.scope) !== JSON.stringify(scope)
        || control.native.harness !== session.harness || control.native.providerVersion !== session.providerVersion
        || control.native.sessionId !== session.nativeSessionId
        || (identity.kind === 'turn' ? control.native.turnId !== identity.nativeTurnId || control.native.messageId !== undefined
          : control.native.messageId !== identity.nativeMessageId
            || 'generation' in identity && control.native.generation !== identity.generation
            || control.native.turnId !== undefined)) continue
      const relevant = proofs.filter((proof) => proof.nativeSessionId === session.nativeSessionId && proof.nativeRequestId === control.native.requestId)
      const stored = exactAcknowledgment(control, row.result.providerAcknowledgment)
      if (row.result.providerAcknowledgment !== undefined && !stored) continue
      const acknowledgments = [...relevant.map((proof) => exactAcknowledgment(control, proof)), ...(stored ? [stored] : [])]
      if (!acknowledgments.length || acknowledgments.some((proof) => !proof)) continue
      const outcome = { ...row.result, status: 'completed', state: this.contract.parse(state), providerAcknowledgment: acknowledgments[0] }
      await this.pool.query(`with reconciled as (
        update management_command_receipts set result=$5::jsonb
        where principal_id=$1 and operation=$2 and command_id=$3 and target_key=$4 and result=$6::jsonb returning target_key
      ) insert into management_audit(principal_id,source,action,target_key,outcome,details)
        select $1,$7,$2,target_key,'succeeded',jsonb_build_object('commandId',$3::text,'phase','reconciled') from reconciled`,
      [row.principal_id, this.contract.operation, row.command_id, conversationId, JSON.stringify(outcome), JSON.stringify(row.result), row.source])
    }
  }

  private async reserve(principal: ManagementPrincipal, source: 'http' | 'mcp', conversationId: string, requestId: string,
    payload: unknown, perform: (markDispatchAttempt: () => void) => Promise<State>,
    readCurrent?: () => Promise<State>,
    acceptedControl?: AcceptedChatResponseControl,
    responseEvidence?: () => ChatResponseAcknowledgment | undefined): Promise<State> {
    // Current scope/authority is checked even for conflicts, rejections and receipt replay.
    if (readCurrent) await readCurrent()
    const control = acceptedControl ? AcceptedChatResponseControlSchema.parse(acceptedControl) : undefined
    if (control && control.conversationId !== conversationId) throw new DomainError(
      `${this.contract.prefix}_CONTROL_SCOPE_CONFLICT`, 'Accepted response metadata changed its conversation scope.', 409)
    const hash = commandInputHash(payload)
    const key = [principal.id, this.contract.operation, requestId]
    // All control kinds share the same namespace; changing kind or target also conflicts.
    const admitted = await this.pool.query(`with claimed as (
      insert into management_command_receipts (principal_id,operation,command_id,target_key,input_hash,result)
      select $1,$2,$3,$4,$5,$7::jsonb
      where not exists (select 1 from management_audit where principal_id=$1 and action=$2
        and details->>'commandId'=$3 and details->>'phase'='reserved')
      on conflict (principal_id,operation,command_id) do nothing returning 1
    ) insert into management_audit (principal_id,source,action,target_key,outcome,details)
      select $1,$6,$2,$4,'uncertain',jsonb_build_object('commandId',$3::text,'phase','reserved') from claimed returning 1`,
    [...key, conversationId, hash, source, JSON.stringify({ status: 'pending', ...(control ? { acceptedControl: control } : {}) })])
    if (!admitted.rowCount) {
      const prior = (await this.pool.query<Receipt<State>>(`select target_key,input_hash,result from management_command_receipts
        where principal_id=$1 and operation=$2 and command_id=$3`, key)).rows[0]
      if (!prior) {
        const expired = await this.pool.query(`select details->>'commandId' as command_id from management_audit
          where principal_id=$1 and action=$2 and details->>'commandId'=$3 and details->>'phase'='reserved' limit 1`, key)
        if (expired.rows.length) throw expiredCommandResult()
        throw unconfirmed(requestId, this.contract.prefix)
      }
      if (prior.target_key !== conversationId || prior.input_hash !== hash) {
        throw new DomainError(`${this.contract.prefix}_REQUEST_CONFLICT`, 'This request ID was already used for a different control or input.', 409)
      }
      if (prior.result.status === 'completed') return this.contract.parse(
        readCurrent ? await readCurrent() : prior.result.state)
      if (prior.result.status === 'rejected') {
        const error = prior.result.error
        throw new DomainError(error.code, error.message, error.status, error.details)
      }
      const accepted = AcceptedChatResponseControlSchema.safeParse(prior.result.acceptedControl)
      const proof = accepted.success ? exactAcknowledgment(accepted.data, prior.result.providerAcknowledgment) : undefined
      if (accepted.success && accepted.data.conversationId === conversationId && proof && readCurrent) {
        const state = this.contract.parse(await readCurrent())
        const recovered = { ...prior.result, status: 'completed', state, providerAcknowledgment: proof }
        const saved = await this.pool.query(`with recovered as (
          update management_command_receipts set result=$4::jsonb
          where principal_id=$1 and operation=$2 and command_id=$3 and result=$5::jsonb returning target_key
        ) insert into management_audit(principal_id,source,action,target_key,outcome,details)
          select $1,$6,$2,target_key,'succeeded',jsonb_build_object('commandId',$3::text,'phase','reconciled') from recovered returning 1`,
        [...key, JSON.stringify(recovered), JSON.stringify(prior.result), source])
        if (saved.rowCount === 1) return state
      }
      if (readCurrent && this.contract.recoverOutcome) {
        const state = this.contract.parse(await readCurrent())
        if (this.contract.recoverOutcome(state, payload, requestId, principal.id)) {
          const result = { ...prior.result, status: 'completed', state }
          await this.pool.query(`with recovered as (
            update management_command_receipts set result=$5::jsonb
            where principal_id=$1 and operation=$2 and command_id=$3 and result=$4::jsonb returning target_key
          ) insert into management_audit(principal_id,source,action,target_key,outcome,details)
            select $1,$6,$2,target_key,$7,jsonb_build_object('commandId',$3::text,'phase','reconciled') from recovered`,
          [...key, JSON.stringify(prior.result), JSON.stringify(result), source,
            this.contract.auditOutcome?.(state, payload) ?? 'succeeded'])
          return state
        }
      }
      throw unconfirmed(requestId, this.contract.prefix)
    }

    let outcome: Outcome<State>
    let dispatchAttempted = false
    try {
      outcome = { status: 'completed', state: this.contract.parse(await perform(() => { dispatchAttempted = true })) }
    } catch (error) {
      // Domain validation failures are replayable rejections. Unclassified transport/storage
      // errors do not prove that the external effect failed; never retry them.
      if (error instanceof DomainError && !dispatchAttempted) outcome = { status: 'rejected', error: {
        code: error.code, message: error.message, status: error.status,
        ...(error.details ? { details: error.details } : {}),
      } }
      else if (error && typeof error === 'object' && 'certainty' in error && error.certainty === 'definite'
        || error instanceof HarnessExecutionError && ['NATIVE_RESPONSE_DELIVERY_FAILED', 'NATIVE_RESPONSE_INVALID'].includes(error.result.error?.code ?? '')) {
        outcome = { status: 'rejected', error: { code: 'NATIVE_RESPONSE_DELIVERY_FAILED',
          message: 'The native provider definitely rejected this control.', status: 409 } }
      } else outcome = { status: 'uncertain' }
    }
    if (control) {
      outcome = { ...outcome, acceptedControl: control }
      const acknowledgment = exactAcknowledgment(control, responseEvidence?.())
      if (acknowledgment) outcome.providerAcknowledgment = acknowledgment
      if (control.native.harness === 'claude' && outcome.status === 'completed' && !acknowledgment) {
        outcome = { status: 'uncertain', acceptedControl: control }
      }
    }
    const completedByObservation = async (): Promise<{ state: State } | undefined> => {
      if (!control) return undefined
      const prior = (await this.pool.query<Receipt<State>>(`select target_key,input_hash,result
        from management_command_receipts where principal_id=$1 and operation=$2 and command_id=$3`, key)).rows[0]
      if (!prior || prior.target_key !== conversationId || prior.input_hash !== hash
        || prior.result.status !== 'completed' || !isDeepStrictEqual(prior.result.acceptedControl, control)) return undefined
      const acknowledgment = exactAcknowledgment(control, prior.result.providerAcknowledgment)
      if (!acknowledgment || outcome.providerAcknowledgment
        && !isDeepStrictEqual(acknowledgment, outcome.providerAcknowledgment)) return undefined
      return { state: this.contract.parse(readCurrent ? await readCurrent() : prior.result.state) }
    }
    if (control?.native.harness === 'claude' && outcome.providerAcknowledgment) {
      try {
        const journal = await this.pool.query(`update management_command_receipts set result=$4::jsonb
          where principal_id=$1 and operation=$2 and command_id=$3 and result->>'status'='pending' returning 1`,
        [...key, JSON.stringify({ status: 'pending', acceptedControl: control, providerAcknowledgment: outcome.providerAcknowledgment })])
        if (journal.rowCount !== 1) {
          const completed = await completedByObservation()
          if (completed) return completed.state
          throw unconfirmed(requestId, this.contract.prefix)
        }
      } catch {
        const completed = await completedByObservation()
        if (completed) return completed.state
        // A lost storage write leaves the original response fenced against another native send.
        throw unconfirmed(requestId, this.contract.prefix)
      }
    }
    const auditOutcome = () => {
      if (outcome.status === 'completed') return this.contract.auditOutcome?.(outcome.state, payload) ?? 'succeeded'
      if (outcome.status === 'rejected') return 'failed'
      return 'uncertain'
    }
    const save = () => this.pool.query(`with settled as (
        update management_command_receipts set result=$4::jsonb
        where principal_id=$1 and operation=$2 and command_id=$3 and result->>'status'='pending' returning target_key
      ) insert into management_audit (principal_id,source,action,target_key,outcome,details)
        select $1,$5,$2,target_key,$6,jsonb_build_object('commandId',$3::text) from settled returning 1`,
      [...key, JSON.stringify(outcome), source, auditOutcome()])
    try {
      const saved = await save()
      if (saved.rowCount !== 1) throw unconfirmed(requestId, this.contract.prefix)
    } catch {
      // A qualified ACK permits one storage-only retry even when the turn has
      // finished. The pending receipt remains the fence; perform is never repeated.
      const completed = await completedByObservation()
      if (completed) return completed.state
      if (outcome.status !== 'completed' || !outcome.providerAcknowledgment) throw unconfirmed(requestId, this.contract.prefix)
      try { if ((await save()).rowCount !== 1) throw unconfirmed(requestId, this.contract.prefix) }
      catch { throw unconfirmed(requestId, this.contract.prefix) }
    }
    if (outcome.status === 'completed') return this.contract.parse(
      readCurrent ? await readCurrent() : outcome.state)
    if (outcome.status === 'rejected') {
      const error = outcome.error
      throw new DomainError(error.code, error.message, error.status, error.details)
    }
    throw unconfirmed(requestId, this.contract.prefix)
  }
}
