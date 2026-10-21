import { recoverPersistedClaudeCompaction } from '../../harnesses/claudeSdk/recoverCompaction.js'
import { randomUUID } from 'node:crypto'
import { mergeContextSnapshot } from './context.js'
import { isNativeReadUnavailable, readNativeCapabilities, readNativeSnapshot } from './nativeSnapshot.js'
import type { SessionControlBinding } from './binding.js'
import type pg from 'pg'
import {
  CompactionStateSchema, SessionControlRequestSchema, SessionControlStateSchema, SessionPreferencesSchema,
  compactionBlocksSend, unavailableSessionControls,
  type SessionControlState, type SessionControlRequest, type NativeSessionReference,
} from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../../harnesses/port.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '../../errors.js'
import { NativeConversationControlCommands } from '../nativeControlCommands.js'
import { componentLogger } from '../../diagnostics/logger.js'
import { isDefiniteCompactionRejection } from '../../harnesses/errors.js'

export type { SessionControlBinding }

const reservationOwner = randomUUID()

export class SessionControlStore {
  private readonly compacting = new Set<string>()
  private readonly commands: NativeConversationControlCommands<SessionControlState>

  constructor(private readonly pool: Pick<pg.Pool, 'query'>, private readonly role: 'operator' | 'agent') {
    this.commands = new NativeConversationControlCommands(pool, {
      operation: role === 'operator' ? 'operator_chat_control' : 'agent_chat_control',
      parse: value => SessionControlStateSchema.parse(value), prefix: 'SESSION', label: 'Session controls',
      recoverOutcome: (state, payload, requestId, principalId) => {
        const request = SessionControlRequestSchema.parse(payload)
        if (request.kind !== 'compact') return state.lastRequestId === requestId
          && state.lastRequestPrincipalId === principalId
        return state.compaction?.requestId === requestId && state.compaction.principalId === principalId
          && !compactionBlocksSend(state.compaction)
      },
      auditOutcome: (state, payload) => {
        if (!payload || typeof payload !== 'object' || !('kind' in payload) || payload.kind !== 'compact') return 'succeeded'
        if (state.compaction?.status === 'failed') return 'failed'
        if (state.compaction && ['completed', 'no-op'].includes(state.compaction.status)) return 'succeeded'
        return 'uncertain'
      },
    })
  }

  async read(binding: SessionControlBinding): Promise<SessionControlState> {
    const { conversationId, session } = binding
    if (this.compacting.size) {
      const row = await this.pool.query<{ record: unknown }>(
        'select record from conversation_session_controls where conversation_id=$1', [conversationId])
      if (row.rows[0]) {
        const saved = SessionControlStateSchema.parse(row.rows[0].record)
        if (saved.compaction && this.compacting.has(saved.compaction.requestId)) {
          return { ...saved, busyReason: binding.busyReason }
        }
      }
    }
    const loaded = await readNativeCapabilities(binding)
    let manager = loaded ? binding.manager : undefined
    const capabilities = loaded?.capabilities
      ?? binding.pendingCapabilities ?? unavailableSessionControls(binding.profileKey)
    const defaultsRow = await this.pool.query<{ record: unknown }>(`select record from conversation_session_defaults
      where principal_id=$1 and role=$2 and subject=$3 and profile_key=$4`,
    [binding.principalId, this.role, binding.defaultSubject, binding.profileKey])
    const defaults = SessionPreferencesSchema.parse(defaultsRow.rows[0]?.record ?? {})
    const initial: SessionControlState = {
      conversationId, revision: 0, profileKey: binding.profileKey,
      desiredMode: binding.initialMode ?? 'regular', appliedMode: null, defaults, desired: defaults, applied: null,
      applicability: 'next-turn', capabilities, context: null, nativeSessionId: binding.session?.nativeSessionId ?? null, nativeProviderVersion: binding.session?.providerVersion ?? null, compaction: null, compactions: [], busyReason: binding.busyReason,
    }
    await this.pool.query(`insert into conversation_session_controls(conversation_id,record)
      values($1,$2::jsonb) on conflict do nothing`, [conversationId, JSON.stringify(initial)])
    const state = await this.saved(conversationId)
    const capabilitiesChanged = loaded?.capabilities
      && JSON.stringify(state.capabilities) !== JSON.stringify(loaded.capabilities)
    state.nativeSessionId = session?.nativeSessionId ?? null
    state.nativeProviderVersion = session?.providerVersion ?? null
    state.defaults = defaults
    if (loaded?.capabilities || !session || state.profileKey !== binding.profileKey) state.capabilities = capabilities
    state.busyReason = binding.busyReason
    if (state.profileKey !== binding.profileKey) {
      if (compactionBlocksSend(state.compaction)) {
        throw new DomainError('SESSION_CONTROL_PROFILE_CHANGED', 'Recover the previous profile’s compaction before changing this chat.', 409)
      }
      state.profileKey = binding.profileKey
      state.desired = initial.desired
      state.desiredMode = 'regular'
      state.applied = null
      state.appliedMode = null
      state.context = null
      state.applicability = 'new-session'
      state.compaction = null
      await this.save(state)
    }
    if (capabilitiesChanged) await this.saveCapabilities(state)
    if (state.compaction && compactionBlocksSend(state.compaction)
      && state.compaction.dispatchPhase && state.compaction.dispatchPhase !== 'dispatched'
      && (state.compaction.reservationOwner !== reservationOwner || !this.compacting.has(state.compaction.requestId))) {
      state.compaction = { ...state.compaction, status: 'failed',
        message: 'Compaction stopped before native dispatch. You can try again.', observedAt: new Date().toISOString() }
      await this.save(state)
    }
    if (state.compaction && compactionBlocksSend(state.compaction) && session && manager?.reconcileCompaction) {
      if (state.compaction.nativeSessionId !== session.nativeSessionId) {
        throw new DomainError('SESSION_CONTROL_TARGET_CHANGED', 'The compaction belongs to a different native session.', 409)
      }
      let reconciled: SessionControlState['compaction'] = null
      try {
        reconciled = CompactionStateSchema.parse(await manager.reconcileCompaction(session, state.compaction))
      } catch (error) {
        if (!isNativeReadUnavailable(error, session, { binding, manager })) throw error
        manager = undefined
      }
      if (reconciled) await this.saveReconciledCompaction(state, reconciled, session)
    }
    if (state.compaction && compactionBlocksSend(state.compaction) && !manager && binding.recoverCompaction) {
      const recovered = CompactionStateSchema.parse(await binding.recoverCompaction(state.compaction))
      if (recovered.requestId !== state.compaction.requestId || recovered.nativeSessionId !== state.compaction.nativeSessionId) {
        throw new DomainError('SESSION_CONTROL_TARGET_CHANGED', 'The recovered compaction belongs to another session.', 409)
      }
      // Native history does not own Main's command attribution.
      recovered.principalId = state.compaction.principalId
      if (JSON.stringify(recovered) !== JSON.stringify(state.compaction)) {
        state.compaction = recovered
        await this.save(state)
      }
    }
    if (state.compaction && compactionBlocksSend(state.compaction) && !manager
      && session?.harness === 'claude' && state.compaction.nativeSessionId === session.nativeSessionId) {
      const recovered = await recoverPersistedClaudeCompaction(state.compaction)
      if (JSON.stringify(recovered) !== JSON.stringify(state.compaction)) {
        state.compaction = recovered
        await this.save(state)
      }
    }
    const native = manager ? readNativeSnapshot(binding) : null
    const applied = native?.applied
    if (applied && JSON.stringify(applied) !== JSON.stringify(state.applied)) {
      state.applied = applied
      if (state.appliedMode === state.desiredMode && JSON.stringify(applied) === JSON.stringify(state.desired)) {
        state.applicability = 'applied'
      }
      await this.save(state)
    }
    if (state.compaction && !compactionBlocksSend(state.compaction)) await this.reconcileReceipt(binding, state)
    const rows = await this.pool.query<{ compaction: unknown }>(`select result#>'{state,compaction}' as compaction
      from management_command_receipts where target_key=$1 and operation=$2
      and result#>>'{state,compaction,requestId}'=command_id order by created_at desc limit 32`,
    [conversationId, this.role === 'operator' ? 'operator_chat_control' : 'agent_chat_control'])
    state.compactions = rows.rows.map(row => SessionControlStateSchema.shape.compaction.parse(row.compaction))
      .filter((entry): entry is NonNullable<SessionControlState['compaction']> => entry !== null).reverse()
    const context = native?.context
    if (!context && state.context && !state.context.stale) {
      state.context = { ...state.context, stale: true }
      await this.saveContext(state)
    }
    if (context && session) {
      const merged = mergeContextSnapshot(state.context, context, session.nativeSessionId, state.capabilities.model)
      if (JSON.stringify(merged) !== JSON.stringify(state.context)) {
        state.context = merged
        await this.saveContext(state)
      }
    }
    if (state.context && (!session || state.context.nativeSessionId !== session.nativeSessionId)) {
      state.context = { ...state.context, stale: true }
    }
    state.nativeStatus = 'not-started'
    if (session) state.nativeStatus = native ? 'loaded' : 'resume-required'
    return state
  }

  async reconcileForRetirement(conversationId: string, manager: NativeHarnessSessionManager,
    session: NativeSessionReference, signal: AbortSignal): Promise<void> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from conversation_session_controls where conversation_id=$1', [conversationId])
    if (!result.rows[0]) return
    const state = SessionControlStateSchema.parse(result.rows[0].record)
    if (!state.compaction) return
    const principalId = state.compaction.principalId
    if (compactionBlocksSend(state.compaction)) {
      if (state.compaction.nativeSessionId !== session.nativeSessionId) {
        throw new DomainError('SESSION_CONTROL_TARGET_CHANGED', 'The compaction belongs to a different native session.', 409)
      }
      if (principalId) manager.setSessionControlPrincipal?.(principalId)
      if (manager.reconcileCompaction) {
        const reconciled = CompactionStateSchema.parse(await manager.reconcileCompaction(session, state.compaction, signal))
        await this.saveReconciledCompaction(state, reconciled, session)
      }
      if (compactionBlocksSend(state.compaction)) {
        throw new DomainError('SESSION_COMPACT_UNCONFIRMED', 'Native compaction is unconfirmed; chat cleanup remains owned.', 409)
      }
    }
    await this.reconcileReceipt({ conversationId, principalId }, state)
  }

  private async saveReconciledCompaction(state: SessionControlState,
    reconciled: NonNullable<SessionControlState['compaction']>, session: NativeSessionReference) {
    if (reconciled.requestId !== state.compaction!.requestId || reconciled.nativeSessionId !== session.nativeSessionId) {
      throw new DomainError('SESSION_CONTROL_TARGET_CHANGED', 'The native compaction result belongs to a different request or session.', 409)
    }
    if (JSON.stringify(reconciled) !== JSON.stringify(state.compaction)) {
      state.compaction = { ...state.compaction, ...reconciled, principalId: state.compaction!.principalId }
      await this.save(state)
    }
  }

  async execute(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: SessionControlRequest,
    bind: () => Promise<SessionControlBinding>, signal?: AbortSignal): Promise<SessionControlState> {
    const input = SessionControlRequestSchema.parse(raw)
    const binding = await bind()
    const result = await this.commands.execute(principal, source, binding.conversationId, input.requestId, input,
      async markDispatch => {
        const current = await bind()
        const state = await this.read(current)
        if (state.revision !== input.expectedRevision) {
          throw new DomainError('SESSION_CONTROL_CONFLICT', 'Session settings changed. Refresh and try again.', 409)
        }
        if (state.profileKey !== current.profileKey) {
          throw new DomainError('SESSION_CONTROL_PROFILE_CHANGED', 'The native profile changed. Refresh the conversation.', 409)
        }
        if (compactionBlocksSend(state.compaction)) {
          throw new DomainError('SESSION_COMPACT_UNCONFIRMED', 'Read the pending compaction before sending another command.', 409)
        }
        if (input.kind === 'compact') return this.compact(current, state, input.requestId, markDispatch, signal)
        if (input.kind === 'mode') {
          if (!state.capabilities.plan.supported) {
            throw new DomainError('SESSION_PLAN_UNSUPPORTED', state.capabilities.plan.reason ?? 'Plan is unavailable.', 409)
          }
          state.desiredMode = input.mode
          state.applicability = 'next-turn'
        } else {
          this.validatePreferences(state, input)
          if (input.kind === 'save-default') {
            state.defaults = input.preferences
            state.lastRequestId = input.requestId
            state.lastRequestPrincipalId = current.principalId
            await this.saveDefaults(current, state)
            return state
          }
          state.desired = input.preferences
          state.applicability = current.session ? 'safe-resume' : 'next-turn'
        }
        state.lastRequestId = input.requestId
        state.lastRequestPrincipalId = current.principalId
        await this.save(state)
        if (input.kind === 'preferences' && current.session && current.session.harness !== 'claude' && !current.busyReason
          && current.manager?.applySessionPreferences) {
          markDispatch()
          await current.manager.applySessionPreferences(current.session, input.preferences, signal)
          const applied = current.manager.appliedSessionPreferences?.(current.session)
          if (applied) state.applied = applied
          state.applicability = applied && JSON.stringify(applied) === JSON.stringify(state.desired)
            ? 'applied' : 'next-turn'
          await this.save(state)
        }
        return state
      }, async () => this.read(await bind()))
    return { ...result, completedRequestId: input.requestId }
  }

  private async compact(binding: SessionControlBinding, state: SessionControlState, requestId: string,
    markDispatch: () => void, signal?: AbortSignal): Promise<SessionControlState> {
    const progress = async (compaction: NonNullable<SessionControlState['compaction']>) => {
      const parsed = CompactionStateSchema.parse(compaction)
      if (parsed.requestId !== requestId || parsed.nativeSessionId !== (binding.session?.nativeSessionId ?? null)) {
        throw new DomainError('SESSION_CONTROL_TARGET_CHANGED', 'The native result does not match this compaction.', 409)
      }
      state.compaction = { ...state.compaction, ...parsed, principalId: binding.principalId, dispatchPhase: parsed.dispatchPhase
        ?? (state.compaction?.dispatchPhase === 'dispatched' ? 'dispatched' : 'preflight') }
      await this.save(state)
    }
    const initial = { requestId, principalId: binding.principalId, nativeSessionId: binding.session?.nativeSessionId ?? null,
      nativeOperationId: null, status: 'accepted' as const, dispatchPhase: 'reserved' as const,
      reservationOwner, beforeTokens: null,
      message: 'Compaction is starting.', observedAt: new Date().toISOString() }
    if (binding.busyReason) throw new DomainError('SESSION_BUSY', binding.busyReason, 409)
    if (!binding.session) {
      await progress({ ...initial, status: 'no-op', message: 'There is no native session to compact yet.' })
      return state
    }
    if (!state.capabilities.compact.supported || !binding.manager?.compactSession) {
      throw new DomainError('SESSION_COMPACT_UNSUPPORTED', state.capabilities.compact.reason ?? 'Compaction is unavailable.', 409)
    }
    state.compaction = initial
    let dispatchAttempted = false
    this.compacting.add(requestId)
    try { await this.claimCompaction(state) }
    catch (error) { this.compacting.delete(requestId); throw error }
    try {
      await progress(await binding.manager.compactSession(binding.session, { requestId, clientCorrelationId: `session-control:${this.role}:${binding.conversationId}:${binding.principalId}:${requestId}`, onProgress: progress, onDispatch: async () => {
        await progress({ ...state.compaction!, dispatchPhase: 'dispatched' })
        dispatchAttempted = true
        markDispatch()
      } }, signal))
    } catch (error) {
      const definite = !dispatchAttempted || isDefiniteCompactionRejection(error)
      let message = 'Compaction is unconfirmed. Recover by reading this conversation.'
      if (definite) message = 'The native provider rejected compaction.'
      if (!dispatchAttempted) message = 'Compaction stopped before native dispatch. You can try again.'
      await progress({ ...state.compaction!, status: definite ? 'failed' : 'uncertain', message })
    } finally {
      this.compacting.delete(requestId)
    }
    return state
  }

  private validatePreferences(state: SessionControlState, input: Extract<SessionControlRequest, { kind: 'preferences' | 'save-default' }>) {
    const preferences = input.preferences
    const capabilities = state.capabilities
    if (preferences.autoCompact !== 'default' && !capabilities.autoCompact.supported
      || preferences.autoCompactTokens !== null && !capabilities.autoCompactBudget.supported
      || preferences.contextBudget !== null && !capabilities.contextBudgets.includes(preferences.contextBudget)
      || preferences.contextProfile !== null && !capabilities.contextProfiles.some(profile => profile.id === preferences.contextProfile)) {
      throw new DomainError('SESSION_PREFERENCE_UNSUPPORTED', 'This native profile does not support the selected context option.', 422)
    }
    const budget = preferences.contextBudget ?? preferences.autoCompactTokens
    const capacity = preferences.contextProfile === null
      ? capabilities.nativeDefaultCapacity ?? capabilities.modelCapacity
      : capabilities.contextProfiles.find(profile => profile.id === preferences.contextProfile)?.capacity ?? null
    if (budget !== null && capacity !== null && budget > capacity) {
      throw new DomainError('SESSION_BUDGET_TOO_LARGE', 'The budget exceeds this model’s supported capacity.', 422)
    }
    if (input.kind === 'preferences' && preferences.contextBudget !== null && state.context?.usedTokens !== null
      && state.context?.usedTokens !== undefined && preferences.contextBudget < state.context.usedTokens) {
      throw new DomainError('SESSION_BUDGET_TOO_SMALL', 'Compact this session before lowering its context budget.', 422)
    }
  }

  async hasPendingCompaction(conversationId: string): Promise<boolean> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from conversation_session_controls where conversation_id=$1', [conversationId])
    return !!result.rows[0] && compactionBlocksSend(SessionControlStateSchema.parse(result.rows[0].record).compaction)
  }

  async assertSendAllowed(conversationId: string): Promise<void> {
    if (await this.hasPendingCompaction(conversationId)) {
      throw new DomainError('SESSION_COMPACT_UNCONFIRMED', 'Compaction is still pending. Read its status before sending.', 409)
    }
  }

  async observeContext(conversationId: string, incoming: NonNullable<SessionControlState['context']>, profileKey: string) {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from conversation_session_controls where conversation_id=$1', [conversationId])
    if (!result.rows[0]) return
    const state = SessionControlStateSchema.parse(result.rows[0].record)
    if (state.profileKey !== profileKey) return
    const sessionId = state.nativeSessionId ?? incoming.nativeSessionId
    const merged = mergeContextSnapshot(state.context, incoming, sessionId, state.capabilities.model)
    if (JSON.stringify(merged) === JSON.stringify(state.context)) return
    state.context = merged
    state.nativeSessionId = sessionId
    await this.saveContext(state)
  }

  async preferences(conversationId: string) {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from conversation_session_controls where conversation_id=$1', [conversationId])
    return result.rows[0] ? SessionControlStateSchema.parse(result.rows[0].record).desired : undefined
  }

  private async recordAppliedSettings(conversationId: string,
    target: { requestId: string; nativeSessionId: string | null }, profileKey: string,
    applied: Pick<SessionControlState, 'appliedMode'>) {
    // Merge only the acknowledgment while the same session and request still own the conversation.
    await this.pool.query(`with target as materialized (
      select id from operator_conversations where id=$1 and active_request_id=$2
        and native_session_id is not distinct from $3::text and deleted_at is null for update
    ) update conversation_session_controls as controls
      set record=controls.record || $5::jsonb || jsonb_build_object(
        'revision', (controls.record->>'revision')::bigint+1,
        'applicability', case when controls.record->>'desiredMode'=$5::jsonb->>'appliedMode'
          and controls.record->'desired'=controls.record->'applied'
          then 'applied' else controls.record->>'applicability' end)
      from target where controls.conversation_id=target.id and controls.record->>'profileKey'=$4`,
    [conversationId, target.requestId, target.nativeSessionId, profileKey, JSON.stringify(applied)])
  }

  async turnSettings(conversationId: string, target: { requestId: string; nativeSessionId: string | null },
    selectedMode?: SessionControlState['desiredMode']) {
    await this.assertSendAllowed(conversationId)
    const result = await this.pool.query<{ record: unknown }>(
      'select record from conversation_session_controls where conversation_id=$1', [conversationId])
    if (!result.rows[0]) return selectedMode ? { sessionMode: selectedMode } : {}
    const state = SessionControlStateSchema.parse(result.rows[0].record)
    const sessionMode = selectedMode ?? state.desiredMode
    const applied = { appliedMode: sessionMode }
    return { sessionMode, sessionPreferences: state.desired, onSettingsApplied: async () => {
      try {
        await this.recordAppliedSettings(conversationId, target, state.profileKey, applied)
      } catch (error) {
        // Bookkeeping failure cannot turn native acceptance into a failed message.
        componentLogger('db').warn({ err: error, conversationId, requestId: target.requestId },
          'Could not record applied session settings')
      }
    } }
  }

  private async claimCompaction(state: SessionControlState): Promise<void> {
    const revision = state.revision
    const saved = { ...state, revision: revision + 1 }
    const result = await this.pool.query(`with target as materialized (
      select id,active_request_id,pending_interaction from operator_conversations where id=$1 for update
    ), idle as (
      select id from target where active_request_id is null and pending_interaction is null
        and not exists(select 1 from operator_conversation_turns where conversation_id=$1 and delivery='queued')
    ) update conversation_session_controls set record=$2::jsonb from idle
      where conversation_id=idle.id and (record->>'revision')::bigint=$3`,
    [state.conversationId!, JSON.stringify(saved), revision])
    if (result.rowCount !== 1) throw new DomainError('SESSION_BUSY', 'The conversation changed or another turn started. Refresh its status.', 409)
    state.revision = saved.revision
  }

  private async reconcileReceipt(binding: { conversationId: string; principalId: string | undefined }, state: SessionControlState) {
    const compaction = state.compaction!
    await this.pool.query(`with settled as (
      update management_command_receipts set result=result || jsonb_build_object('status','completed','state',$5::jsonb)
      where principal_id=$1 and operation=$2 and command_id=$3 and target_key=$4
        and (result->>'status' in ('pending','uncertain')
          or result->>'status'='completed' and result#>>'{state,compaction,requestId}'=$3
            and result#>>'{state,compaction,status}' in ('accepted','running','uncertain'))
      returning target_key
    ) insert into management_audit(principal_id,source,action,target_key,outcome,details)
      select $1,coalesce((select source from management_audit where principal_id=$1 and action=$2
        and target_key=$4 and details->>'commandId'=$3 order by sequence limit 1),'http'),$2,target_key,$6,
        jsonb_build_object('commandId',$3::text,'phase','reconciled') from settled`,
    [compaction.principalId ?? binding.principalId, this.role === 'operator' ? 'operator_chat_control' : 'agent_chat_control',
      compaction.requestId, binding.conversationId, JSON.stringify(state),
      compaction.status === 'failed' ? 'failed' : 'succeeded'])
  }

  private async saveDefaults(binding: SessionControlBinding, state: SessionControlState) {
    const revision = state.revision
    const saved = { ...state, revision: revision + 1 }
    const result = await this.pool.query(`with saved as (
      update conversation_session_controls set record=jsonb_set($2::jsonb,'{context}',
        case when record->>'profileKey'=$2::jsonb->>'profileKey' then record->'context' else $2::jsonb->'context' end)
      where conversation_id=$1 and (record->>'revision')::bigint=$3 returning conversation_id
    ) insert into conversation_session_defaults(principal_id,role,subject,profile_key,record)
      select $4,$5,$6,$7,$8::jsonb from saved where true
      on conflict(principal_id,role,subject,profile_key) do update set record=excluded.record`,
    [state.conversationId, JSON.stringify(saved), revision, binding.principalId, this.role,
      binding.defaultSubject, binding.profileKey, JSON.stringify(state.defaults)])
    if (result.rowCount !== 1) {
      throw new DomainError('SESSION_CONTROL_CONFLICT', 'Session settings changed. Refresh the conversation.', 409)
    }
    state.revision = saved.revision
  }

  private async saved(conversationId: string): Promise<SessionControlState> {
    const result = await this.pool.query<{ record: unknown }>(
      'select record from conversation_session_controls where conversation_id=$1', [conversationId])
    return SessionControlStateSchema.parse(result.rows[0]?.record)
  }

  private async save(state: SessionControlState): Promise<void> {
    const revision = state.revision
    const saved = { ...state, revision: revision + 1 }
    const result = await this.pool.query(`update conversation_session_controls set record=jsonb_set($2::jsonb,'{context}',
      case when record->>'profileKey'=$2::jsonb->>'profileKey' then record->'context' else $2::jsonb->'context' end)
      where conversation_id=$1 and (record->>'revision')::bigint=$3`,
    [state.conversationId!, JSON.stringify(saved), revision])
    if (result.rowCount !== 1) throw new DomainError('SESSION_CONTROL_CONFLICT', 'Session settings changed. Refresh the conversation.', 409)
    state.revision = saved.revision
  }

  private async saveContext(state: SessionControlState): Promise<void> {
    if (!state.context) return
    const patch = { context: state.context, nativeSessionId: state.nativeSessionId,
      nativeProviderVersion: state.nativeProviderVersion }
    const result = await this.pool.query<{ record: unknown }>(`update conversation_session_controls
      set record=record || $2::jsonb || jsonb_build_object('context', case
        when record#>>'{context,nativeSessionId}'=$2::jsonb#>>'{context,nativeSessionId}'
          and record#>>'{context,model}'=$2::jsonb#>>'{context,model}'
          and ((record#>>'{context,generation}'=$2::jsonb#>>'{context,generation}'
              and (record#>>'{context,sequence}')::bigint>($2::jsonb#>>'{context,sequence}')::bigint)
            or (record#>>'{context,generation}'<>$2::jsonb#>>'{context,generation}'
              and record#>>'{context,observedAt}'>$2::jsonb#>>'{context,observedAt}'))
        then record->'context' else $2::jsonb->'context' end)
      where conversation_id=$1 and record->>'profileKey'=$3 returning record`,
    [state.conversationId, JSON.stringify(patch), state.profileKey])
    if (result.rowCount !== 1) throw new DomainError('SESSION_CONTROL_PROFILE_CHANGED',
      'The native profile changed. Refresh the conversation.', 409)
    const { capabilities, busyReason, defaults } = state
    Object.assign(state, SessionControlStateSchema.parse(result.rows[0]!.record), { capabilities, busyReason, defaults })
  }

  private async saveCapabilities(state: SessionControlState): Promise<void> {
    const patch = { capabilities: state.capabilities, nativeSessionId: state.nativeSessionId,
      nativeProviderVersion: state.nativeProviderVersion }
    const result = await this.pool.query<{ record: unknown }>(`update conversation_session_controls
      set record=record || $2::jsonb where conversation_id=$1 and record->>'profileKey'=$3 returning record`,
    [state.conversationId, JSON.stringify(patch), state.profileKey])
    if (result.rowCount !== 1) throw new DomainError('SESSION_CONTROL_PROFILE_CHANGED',
      'The native profile changed. Refresh the conversation.', 409)
    const { defaults, busyReason } = state
    Object.assign(state, SessionControlStateSchema.parse(result.rows[0]!.record), { defaults, busyReason })
  }
}
