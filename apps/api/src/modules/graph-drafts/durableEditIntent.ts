import { randomUUID } from 'node:crypto'
import { withTransaction } from '../../infrastructure/transaction.js'
import pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  CurrentJournalAdvanceInputSchema as GraphEditAdvanceInputSchema,
  CurrentJournalDiscardInputSchema as GraphEditDiscardInputSchema,
  CurrentJournalReadInputSchema as GraphEditReadInputSchema,
  CurrentJournalStopSchema as GraphEditStopSchema, sameWorkflowValue,
  type CurrentJournalAdvanceInput as GraphEditAdvanceInput,
  type CurrentJournalDiscardInput as GraphEditDiscardInput,
  type CurrentJournal as GraphEditIntent, type CurrentJournalReadInput as GraphEditReadInput,
  type CurrentJournalRunState as GraphEditRunState,
} from '@foreman-code/contracts/wave25'
import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { commandInputHash, type PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { RunManagementService } from '../runs/management.js'
import { lockActiveWorkspace } from '../workspaces/admission.js'
import { readAffectedGraphRuns } from './saveAdmission.js'
import { ignoreError } from '../diagnostics/ignoredError.js'

export type EditIntentSource = 'http' | 'mcp'
type Source = EditIntentSource
type Scope = { workspaceId: string; workflowId: string }
type StopEntry = GraphEditIntent['stops'][number]
export type EditStageScope = Scope & {
  draftId: string; commandId: string; expectedRevision: number; expectedWorkflowVersionId: string | null
}
export type DurableEditIntent = Omit<GraphEditIntent, 'stagedDraft' | 'saveInput' | 'result'> & {
  stagedDraft: unknown
  saveInput: Scope & { commandId: string }
  result?: unknown
}
export type EditIntentReadResult<I extends DurableEditIntent> = {
  intent: I | null; current: GraphEditRunState[]; canStop: boolean; affectedSetChanged: boolean
}
export interface EditIntentBoundary<S extends EditStageScope, I extends DurableEditIntent> {
  kind: 'current'
  stageSchema: { parse(raw: unknown): S }
  intentSchema: { parse(raw: unknown): I }
  readResultSchema: { parse(raw: unknown): EditIntentReadResult<I> }
  resultSchema: { parse(raw: unknown): NonNullable<I['result']> }
  prepare(client: pg.PoolClient, principal: ManagementPrincipal, input: S, saveCommandId: string, source: Source):
    Promise<Pick<I, 'savedWorkflowRevision' | 'stagedDraft' | 'agentPins' | 'saveInput'>>
  stagedAgentIds(draft: I['stagedDraft']): string[]
  requiresRunSettlement(client: pg.PoolClient, draft: I['stagedDraft']): boolean | Promise<boolean>
  authorize(principal: ManagementPrincipal, input: Scope, write: boolean): void
  authorizeContent(principal: ManagementPrincipal, intent: I): void
  authorizePublication(client: pg.PoolClient, principal: ManagementPrincipal, intent: I): Promise<void>
  assertStopReady?(pin: GraphEditIntent['affected'][number]): void
  saveInputHash(input: I['saveInput'], intentId: string): string
  resultScope(result: NonNullable<I['result']>): Scope
  publish(principal: ManagementPrincipal, source: Source, input: I['saveInput'], intentId: string): Promise<unknown>
}
const isFinished = (intent: DurableEditIntent) => intent.state === 'saved' || intent.state === 'discarded'
export function sameAffectedSet(intent: Pick<GraphEditIntent, 'affected'>, current: GraphEditRunState[]): boolean {
  // SQL and persisted plans have deterministic Run-ID order; pins, not outcomes, are compared.
  return sameWorkflowValue(intent.affected, current.map((item) => item.pin))
}

/** Durable authoring intent, NOT a new lifecycle/Stop owner. Each transition
 * uses fresh grants. No transaction/ordinary pool lease is held over Stop.
 * The separate session lock serializes advance/discard across tabs/processes;
 * a crash releases it, and the same persisted command identities resume. */
export class DurableEditIntentService<S extends EditStageScope, I extends DurableEditIntent> {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly drafts: EditIntentBoundary<S, I>) {}

  private async affectedRuns(client: pg.PoolClient, intent: Pick<I, 'workspaceId' | 'workflowId' | 'stagedDraft'>) {
    if (!await this.drafts.requiresRunSettlement(client, intent.stagedDraft)) return []
    return readAffectedGraphRuns(client, { workspaceId: intent.workspaceId, workflowId: intent.workflowId,
      stagedAgentIds: this.drafts.stagedAgentIds(intent.stagedDraft) })
  }

  private authorize(principal: ManagementPrincipal, input: { workspaceId: string; workflowId: string }, write: boolean) {
    requireAuthorization(principal, 'graph:read', input)
    this.drafts.authorize(principal, input, write)
    if (write) {
      requireAuthorization(principal, 'graph:edit', input)
      requireAuthorization(principal, 'graph:save', input)
    }
  }
  private authorizeContent(principal: ManagementPrincipal, intent: I, write: boolean) {
    this.authorize(principal, intent, write)
    this.drafts.authorizeContent(principal, intent)
    for (const pin of intent.affected) requireAuthorization(principal, 'runs:read', pin)
  }
  private authorizeCurrent(principal: ManagementPrincipal, current: GraphEditRunState[]) {
    for (const item of current) requireAuthorization(principal, 'runs:read', item.pin)
  }
  private async transaction<T>(principal: ManagementPrincipal, work: (client: pg.PoolClient, live: ManagementPrincipal) => Promise<T>) {
    return withTransaction(this.pool, async (client) => {
      const live = await readLiveManagementPrincipal(client, principal.id)
      const result = await work(client, live)
      return result
    })
  }
  private async withLease<T>(principalId: string, intentId: string, work: () => Promise<T>): Promise<T> {
    const pool = new pg.Pool({ ...this.pool.options, max: 1, application_name: 'graphql-edit-intent' })
    const client = await pool.connect().catch(async (error: unknown) => { await pool.end(); throw error })
    const key = `graph-edit-intent:${JSON.stringify([principalId, intentId])}`
    let releaseError: Error | undefined
    try {
      await client.query('select pg_advisory_lock(hashtext($1))', [key])
      return await work()
    } finally {
      try { await client.query('select pg_advisory_unlock(hashtext($1))', [key]) }
      catch { releaseError = new Error('Intent lease unlock failed.') }
      client.release(releaseError)
      await pool.end()
    }
  }
  private async load(client: Pick<pg.PoolClient, 'query'>, principalId: string,
    input: { workspaceId: string; workflowId: string; intentId: string }, lock = false): Promise<I> {
    const row = await client.query<{ record: unknown }>(`select record from graph_edit_intents
      where id=$1 and principal_id=$2 and workspace_id=$3 and workflow_id=$4${lock ? ' for update' : ''}`,
    [input.intentId, principalId, input.workspaceId, input.workflowId])
    if (!row.rows[0]) throw new DomainError('GRAPH_EDIT_INTENT_NOT_FOUND', 'The private edit intent is unavailable in this scope.', 404)
    const raw = row.rows[0].record
    const current = !!raw && typeof raw === 'object' && 'kind' in raw && raw.kind === 'current'
    if (!current) throw new DomainError('GRAPH_EDIT_INTENT_KIND_CONFLICT',
      'An intent of another supported edit kind occupies this scope. Reconcile it through its matching read surface.', 409)
    const intent = this.drafts.intentSchema.parse(raw)
    if (intent.id !== input.intentId || intent.ownerPrincipalId !== principalId
      || intent.workspaceId !== input.workspaceId || intent.workflowId !== input.workflowId) {
      throw new DomainError('GRAPH_EDIT_INTENT_INVALID', 'The stored edit intent has inconsistent identity.', 409)
    }
    return intent
  }
  private async write(client: Pick<pg.PoolClient, 'query'>, intent: I) {
    const record = this.drafts.intentSchema.parse({ ...intent, updatedAt: new Date().toISOString() })
    const result = await client.query(`update graph_edit_intents set state=$2,record=$3::jsonb,updated_at=now()
      where id=$1 and principal_id=$4 and workspace_id=$5 and workflow_id=$6`,
    [record.id, record.state, JSON.stringify(record), record.ownerPrincipalId, record.workspaceId, record.workflowId])
    if (result.rowCount !== 1) throw new DomainError('GRAPH_EDIT_INTENT_NOT_FOUND', 'The edit intent disappeared.', 409)
    return record
  }
  private async readback(client: pg.PoolClient, live: ManagementPrincipal, intent: I): Promise<EditIntentReadResult<I>> {
    this.authorizeContent(live, intent, false)
    const current = await this.affectedRuns(client, intent)
    this.authorizeCurrent(live, current)
    const canStop = current.filter((item) => !item.settled).every((item) => isAuthorized(live, 'runs:stop', item.pin))
    const settlementRequired = await this.drafts.requiresRunSettlement(client, intent.stagedDraft)
    return this.drafts.readResultSchema.parse({ intent, current, canStop,
      affectedSetChanged: settlementRequired && !sameAffectedSet(intent, current) })
  }

  async read(principal: ManagementPrincipal, raw: GraphEditReadInput): Promise<EditIntentReadResult<I>> {
    const input = GraphEditReadInputSchema.parse(raw)
    return this.transaction(principal, async (client, live) => {
      this.authorize(live, input, false)
      let id = input.intentId
      if (!id) {
        // An old draft instance may have been discarded in another tab. Retain
        // its unresolved intent instead of silently hiding it on the new board.
        const row = await client.query<{ id: string }>(`select id from graph_edit_intents
          where principal_id=$1 and workspace_id=$2 and workflow_id=$3
            and (state not in ('saved','discarded') or record->>'kind'=$4)
          order by (state not in ('saved','discarded')) desc,created_at desc,id desc limit 1`,
        [live.id, input.workspaceId, input.workflowId, this.drafts.kind])
        id = row.rows[0]?.id
      }
      if (!id) return { intent: null, current: [], canStop: false, affectedSetChanged: false }
      return this.readback(client, live, await this.load(client, live.id, { ...input, intentId: id }))
    })
  }

  async stage(principal: ManagementPrincipal, source: Source, raw: S): Promise<EditIntentReadResult<I>> {
    const input = this.drafts.stageSchema.parse(raw)
    this.authorize(principal, input, true)
    const execution = await this.commands.execute({ principal, source, operation: 'graph.stage_edits', commandId: input.commandId,
      targetKey: `draft:${input.draftId}`, payload: input,
      authorize: async (client) => {
        principal = await readLiveManagementPrincipal(client, principal.id)
        this.authorize(principal, input, true)
      },
      perform: async (client) => {
        // prepare holds the same workspace/workflow locks as Start and Save,
        // applies existing typed operations in memory, and performs no publication.
        const prepared = await this.drafts.prepare(client, principal, input, randomUUID(), source)
        const existing = await client.query<{ id: string }>(`select id from graph_edit_intents
          where workspace_id=$1 and workflow_id=$2 and state not in ('saved','discarded') limit 1`,
        [input.workspaceId, input.workflowId])
        if (existing.rows[0]) throw new DomainError('GRAPH_EDIT_INTENT_EXISTS',
          'This workflow already has staged edits. Resolve them before staging another edit.', 409)
        const current = await this.affectedRuns(client, { ...input, stagedDraft: prepared.stagedDraft })
        this.authorizeCurrent(principal, current)
        const saveInput = prepared.saveInput
        const id = `graph-edit-${randomUUID()}`, now = new Date().toISOString()
        const advanceCommandId = randomUUID(), discardCommandId = randomUUID()
        const commandScope = { workspaceId: input.workspaceId, workflowId: input.workflowId, draftId: input.draftId, intentId: id }
        const intent = this.drafts.intentSchema.parse({ kind: 'current', id, ownerPrincipalId: principal.id,
          workspaceId: input.workspaceId, workflowId: input.workflowId, draftId: input.draftId,
          stageCommandId: input.commandId, stageInputHash: commandInputHash(input),
          advanceCommandId, advanceInputHash: commandInputHash({ ...commandScope, action: 'stop_and_save', commandId: advanceCommandId }),
          discardCommandId, discardInputHash: commandInputHash({ ...commandScope, action: 'discard_edits', commandId: discardCommandId }),
          expectedRevision: input.expectedRevision, expectedWorkflowVersionId: input.expectedWorkflowVersionId,
          savedWorkflowRevision: prepared.savedWorkflowRevision, stagedDraft: prepared.stagedDraft, agentPins: prepared.agentPins,
          affected: current.map((item) => item.pin), stops: current.filter((item) => !item.settled).map((item) => {
            const stopInput = { workspaceId: item.pin.workspaceId, runId: item.pin.runId, commandId: randomUUID() }
            return { input: stopInput }
          }),
          saveInput, saveInputHash: this.drafts.saveInputHash(saveInput, id),
          state: 'staged', saveAttempted: false, createdAt: now, updatedAt: now })
        this.authorizeContent(principal, intent, true)
        await client.query(`insert into graph_edit_intents(id,principal_id,workspace_id,workflow_id,draft_id,state,record)
          values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
        [id, principal.id, input.workspaceId, input.workflowId, input.draftId, intent.state, JSON.stringify(intent)])
        await this.commands.recordAudit(principal.id, source, 'graph.edit_stop_tracking', `edit-intent:${id}`,
          'succeeded', { stageCommandId: input.commandId }, client)
        return { intentId: id }
      } })
    // Do not return the stage receipt's old state after a replay.
    return this.read(principal, { action: 'read_edits', workspaceId: input.workspaceId, workflowId: input.workflowId,
      draftId: input.draftId, intentId: execution.value.intentId })
  }

  private assertCommand(intent: I, input: GraphEditAdvanceInput | GraphEditDiscardInput) {
    if (intent.draftId !== input.draftId || input.commandId !== (input.action === 'stop_and_save' ? intent.advanceCommandId : intent.discardCommandId)
      || commandInputHash(input) !== (input.action === 'stop_and_save' ? intent.advanceInputHash : intent.discardInputHash)) {
      throw new DomainError('COMMAND_ID_CONFLICT', 'Reconcile the exact persisted intent command and draft identity.', 409)
    }
  }

  /** Recheck even before stopping. Final publication calls this again under
   * the SAME admission transaction as Agent/version writes. New Runs never
   * expand a stale Stop plan, even if they have subsequently completed. */
  private async fresh(client: pg.PoolClient, live: ManagementPrincipal, intent: I) {
    this.authorizeContent(live, intent, true)
    await lockActiveWorkspace(client, intent.workspaceId)
    const parent = (await client.query<{ revision: string; current_version_id: string | null; archived_at: Date | null }>(
      'select revision::text,current_version_id,archived_at from workflows where workspace_id=$1 and id=$2 for update',
      [intent.workspaceId, intent.workflowId])).rows[0]
    if (!parent || parent.archived_at) throw new DomainError('WORKFLOW_UNAVAILABLE', 'The workflow is unavailable for publication.', 409)
    if (Number(parent.revision) !== intent.savedWorkflowRevision || parent.current_version_id !== intent.expectedWorkflowVersionId) {
      throw new DomainError('WORKFLOW_BASE_CONFLICT', 'The saved workflow changed. The exact staged payload and commands are retained.', 409)
    }
    await this.drafts.authorizePublication(client, live, intent)
    const current = await this.affectedRuns(client, intent)
    this.authorizeCurrent(live, current)
    const settlementRequired = await this.drafts.requiresRunSettlement(client, intent.stagedDraft)
    if (settlementRequired && !sameAffectedSet(intent, current)) throw new DomainError('AFFECTED_RUN_SET_CHANGED',
      'The affected Run/version set changed after planning. No newly discovered Run will be stopped by this intent.', 409)
    return current
  }

  private async stopTrackingEnabled(client: Pick<pg.PoolClient, 'query'>, intent: I) {
    const rows = await client.query(`select 1 from management_audit
      where principal_id=$1 and action='graph.edit_stop_tracking' and target_key=$2
        and details->>'stageCommandId'=$3 limit 1`,
    [intent.ownerPrincipalId, `edit-intent:${intent.id}`, intent.stageCommandId])
    return rows.rows.length > 0
  }

  private async stopWasAttempted(client: Pick<pg.PoolClient, 'query'>, intent: I, entry: StopEntry) {
    const rows = await client.query(`select 1 from management_audit
      where principal_id=$1 and action='graph.edit_stop_attempt' and target_key=$2 and details->>'commandId'=$3`,
    [intent.ownerPrincipalId, `edit-intent:${intent.id}`, entry.input.commandId])
    return rows.rows.length > 0
  }

  private async stopReceipt(client: Pick<pg.PoolClient, 'query'>, intent: I, entry: StopEntry) {
    const receipt = await client.query<{ target_key: string; result: unknown }>(`select target_key,result
      from management_command_receipts where principal_id=$1 and operation='run.stop' and command_id=$2`,
    [intent.ownerPrincipalId, entry.input.commandId])
    const row = receipt.rows[0]
    if (!row) {
      if (entry.receipt) throw new Error('The previously observed exact Stop receipt is unavailable; retain uncertainty.')
      return undefined
    }
    if (row.target_key !== `run:${entry.input.runId}`) {
      throw new DomainError('COMMAND_ID_CONFLICT', 'The Stop receipt contradicts the exact planned command.', 409)
    }
    const parsed = GraphEditStopSchema.shape.receipt.unwrap().parse(row.result)
    if (parsed.runId !== entry.input.runId) {
      throw new DomainError('COMMAND_ID_CONFLICT', 'Contradictory Stop receipt evidence is retained, never overwritten.', 409)
    }
    return parsed
  }

  private async assertStopsReconciled(client: pg.PoolClient, intent: I) {
    for (const entry of intent.stops) {
      const receipt = await this.stopReceipt(client, intent, entry)
      if (!entry.receipt && (receipt || await this.stopWasAttempted(client, intent, entry)
        || !await this.stopTrackingEnabled(client, intent))) {
        throw new Error('Reconcile the exact Stop receipt before publication; settlement does not resolve a submitted or untracked Stop.')
      }
    }
  }

  private async stopSubmissionPending(client: pg.PoolClient, intent: I): Promise<boolean> {
    for (const entry of intent.stops) {
      if (await this.stopReceipt(client, intent, entry)) continue
      if (await this.stopWasAttempted(client, intent, entry)) return true
      if (intent.state !== 'staged' && !await this.stopTrackingEnabled(client, intent)) return true
    }
    return false
  }

  async advance(principal: ManagementPrincipal, source: Source, raw: GraphEditAdvanceInput,
    stop: RunManagementService['stop']): Promise<EditIntentReadResult<I>> {
    const input = GraphEditAdvanceInputSchema.parse(raw)
    this.authorize(principal, input, true)
    return this.withLease(principal.id, input.intentId, async () => {
      let intent = await this.transaction(principal, async (client, live) => {
        this.authorize(live, input, true)
        const value = await this.load(client, live.id, input)
        this.authorizeContent(live, value, true); this.assertCommand(value, input)
        return value
      })
      if (isFinished(intent)) return this.read(principal, { action: 'read_edits', workspaceId: input.workspaceId, workflowId: input.workflowId, draftId: input.draftId, intentId: input.intentId })
      try {
        // A save may already have committed; never revisit Stop before its
        // exact receipt is reconciled. The save receipt and saved journal state
        // commit together, so a read after a lost reply is sufficient too.
        if (!intent.saveAttempted) {
          await this.transaction(principal, async (client, live) => {
            const current = await this.fresh(client, live, intent)
            for (const item of current.filter((item) => !item.settled)) requireAuthorization(live, 'runs:stop', item.pin)
            // A pre-upgrade untouched Stage cannot have submitted Stop. An
            // already-advanced untracked intent has no such proof.
            if (intent.state === 'staged' && !await this.stopTrackingEnabled(client, intent)) {
              await this.commands.recordAudit(live.id, source, 'graph.edit_stop_tracking', `edit-intent:${intent.id}`,
                'succeeded', { stageCommandId: intent.stageCommandId }, client)
            }
            intent = await this.write(client, { ...intent, state: 'stopping', error: undefined })
            return current
          })
          for (let index = 0; index < intent.stops.length; index++) {
            const entry = intent.stops[index]!
            const decision = await this.transaction(principal, async (client, live) => {
              const current = await this.fresh(client, live, intent)
              for (const item of current.filter((item) => !item.settled)) requireAuthorization(live, 'runs:stop', item.pin)
              const receipt = await this.stopReceipt(client, intent, entry)
              if (receipt) return { principal: live, submit: false, receipt }
              const attempted = await this.stopWasAttempted(client, intent, entry)
              const tracked = await this.stopTrackingEnabled(client, intent)
              const settlementRequired = await this.drafts.requiresRunSettlement(client, intent.stagedDraft)
              // Reclassified presentation edits retain prior Stop obligations,
              // while an untouched plan does not submit an unnecessary Stop.
              if (!settlementRequired && !attempted && tracked) {
                return { principal: live, submit: false, receipt: undefined }
              }
              const run = current.find((item) => item.pin.runId === entry.input.runId)
              const pin = run?.pin ?? intent.affected.find((item) => item.runId === entry.input.runId)
              if (!pin || settlementRequired && !run) {
                throw new DomainError('GRAPH_EDIT_INTENT_INVALID', 'The planned Stop is outside the affected Run set.', 409)
              }
              if (run?.settled && !attempted) {
                if (!tracked) {
                  throw new Error('An untracked Stop may have been submitted before upgrade; its missing receipt remains uncertain.')
                }
                return { principal: live, submit: false, receipt: undefined }
              }
              // A settled Run with a possible prior submission still needs the
              // SAME Stop command. Recheck its Stop grant even after settlement.
              requireAuthorization(live, 'runs:stop', pin)
              this.drafts.assertStopReady?.(pin)
              if (!attempted) {
                // COMMIT this write-ahead submission fact BEFORE calling Stop.
                // It proves possible submission, not acceptance or native exit.
                // Audit storage avoids changing the public intent/Stop schemas.
                await this.commands.recordAudit(live.id, source, 'graph.edit_stop_attempt', `edit-intent:${intent.id}`,
                  'uncertain', { commandId: entry.input.commandId, targetKey: `run:${entry.input.runId}` }, client)
              }
              return { principal: live, submit: true, receipt: undefined }
            })
            if (!decision.submit && !decision.receipt) continue // proven natural completion before any submission
            // Existing Stop service only: no replacement identity, direct
            // lifecycle SQL or inferred cancellation acknowledgement.
            let stopError: unknown
            if (decision.submit) {
              try { await stop(decision.principal, source, entry.input) } catch (error) { stopError = error }
            }
            const parsed = decision.receipt ?? await this.stopReceipt(this.pool, intent, entry)
            if (!parsed) throw stopError ?? new Error('Stop acknowledgement is uncertain; its exact command is retained.')
            intent = await this.transaction(principal, async (client, live) => {
              this.authorizeContent(live, intent, true)
              return this.write(client, { ...intent, stops: intent.stops.map((item, i) => i === index ? { ...item, receipt: parsed } : item) })
            })
          }
        }
        const ready = await this.transaction(principal, async (client, live) => {
          const current = await this.fresh(client, live, intent)
          const settled = current.every((item) => item.settled)
          await this.assertStopsReconciled(client, intent)
          intent = await this.write(client, { ...intent, state: settled ? 'saving' : 'waiting',
            saveAttempted: intent.saveAttempted || settled, error: undefined })
          return settled
        })
        if (ready) await this.drafts.publish(principal, source, intent.saveInput, intent.id)
      } catch (error) {
        // Domain rejections are known non-publications. Transport/database
        // failures can have committed: retain the exact save command and read
        // durable state before recording uncertainty, never overwrite success.
        await this.transaction(principal, async (client, live) => {
          const latest = await this.load(client, live.id, input, true)
          this.authorizeContent(live, latest, true)
          if (isFinished(latest)) return
          const uncertain = !(error instanceof DomainError) || await this.stopSubmissionPending(client, latest)
          await this.write(client, { ...latest, state: uncertain ? 'uncertain' : 'blocked',
            error: { code: error instanceof DomainError ? error.code : 'COMMAND_UNCERTAIN',
              message: error instanceof DomainError ? error.message : 'The reply is uncertain. Reconcile this exact intent; its payload and command identities are retained.', uncertain } })
          await this.commands.recordAudit(live.id, source, 'graph.stop_and_save', `edit-intent:${latest.id}`,
            uncertain ? 'uncertain' : 'failed', { commandId: input.commandId,
              code: error instanceof DomainError ? error.code : 'COMMAND_UNCERTAIN' }, client)
        }).catch(ignoreError('engine', 'record uncertain graph edit intent', { intentId: input.intentId, commandId: input.commandId })) // Revocation withholds readback; it must not delete the intent.
        if (error instanceof DomainError && (error.code === 'ACCESS_DENIED' || error.code.startsWith('AUTH_'))) throw error
      }
      return this.read(principal, { action: 'read_edits', workspaceId: input.workspaceId,
        workflowId: input.workflowId, draftId: input.draftId, intentId: input.intentId })
    })
  }

  async discard(principal: ManagementPrincipal, source: Source, raw: GraphEditDiscardInput): Promise<EditIntentReadResult<I>> {
    const input = GraphEditDiscardInputSchema.parse(raw)
    return this.withLease(principal.id, input.intentId, async () => {
      await this.transaction(principal, async (client, live) => {
        const intent = await this.load(client, live.id, input, true)
        this.authorizeContent(live, intent, false)
        requireAuthorization(live, 'graph:edit', input)
        this.assertCommand(intent, input)
        if (intent.state === 'discarded') return
        if (intent.state === 'saved') throw new DomainError('GRAPH_EDIT_ALREADY_SAVED', 'This intent already published. Read its saved result before editing again.', 409)
        if (intent.saveAttempted && intent.state !== 'blocked') throw new DomainError('GRAPH_EDIT_SAVE_UNCERTAIN',
          'Reconcile the exact save command before discarding; its publication outcome is uncertain.', 409)
        await this.write(client, { ...intent, state: 'discarded', error: undefined })
        await this.commands.recordAudit(live.id, source, 'graph.discard_edits', `edit-intent:${intent.id}`,
          'succeeded', { commandId: input.commandId }, client)
      })
      // No Stop, shared draft mutation or layout mutation occurs on this path.
      return this.read(principal, { action: 'read_edits', workspaceId: input.workspaceId,
        workflowId: input.workflowId, draftId: input.draftId, intentId: input.intentId })
    })
  }

  async authorizeSave(client: pg.PoolClient, live: ManagementPrincipal, intentId: string,
    input: { workspaceId: string; workflowId: string }) {
    this.authorizeContent(live, await this.load(client, live.id, { ...input, intentId }), true)
  }

  /** Internal-only save admission, called inside the selected typed writer's
   * transaction BEFORE any Agent or version write. Public callers cannot pass
   * this context through the strict ordinary graph_save schema. */
  async publication(client: pg.PoolClient, live: ManagementPrincipal, intentId: string,
    input: I['saveInput']): Promise<I['stagedDraft']> {
    const intent = await this.load(client, live.id, { ...input, intentId }, true)
    this.authorizeContent(live, intent, true)
    if (intent.state !== 'saving' || !intent.saveAttempted || !sameWorkflowValue(input, intent.saveInput)
      || this.drafts.saveInputHash(input, intent.id) !== intent.saveInputHash) {
      throw new DomainError('GRAPH_EDIT_INTENT_CONFLICT', 'The exact staged publication command is not ready.', 409)
    }
    const current = await this.fresh(client, live, intent)
    if (current.some((item) => !item.settled)) throw new DomainError('WORKFLOW_RUNS_UNSETTLED',
      'Affected work is not fully settled. The exact payload and command identities remain staged.', 409)
    await this.assertStopsReconciled(client, intent)
    return intent.stagedDraft
  }
  async saved(client: pg.PoolClient, live: ManagementPrincipal, intentId: string, value: NonNullable<I['result']>) {
    const intent = await this.load(client, live.id, { ...this.drafts.resultScope(value), intentId }, true)
    if (intent.state !== 'saving') throw new DomainError('GRAPH_EDIT_INTENT_CONFLICT', 'The staged publication changed.', 409)
    await this.write(client, { ...intent, state: 'saved', result: this.drafts.resultSchema.parse(value), error: undefined })
  }
}
