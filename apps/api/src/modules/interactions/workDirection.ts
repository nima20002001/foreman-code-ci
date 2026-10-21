import { WorkDirectionRequestSchema, WorkDirectionResponseSchema, withInteractionResponse,
  type DurableInteraction, type InteractionResponseValue } from '@foreman-code/contracts'
import { canonicalGraphJson, RunStartV3InputSchema, type RunStartV3Input } from '@foreman-code/contracts/wave25'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { requireAuthorization } from '../access/policy.js'
import { beforeGraphCommit, type GraphTransactionSql } from '../run-graph/connection.js'
import { openRunGraphPublication } from '../run-graph/publication.js'
import { readPublicProjectionLocked } from '../run-graph/compactSnapshot.js'
import { readAcceptedRepeatRunLocked } from '../runs/repeatStartRead.js'
import type { RepeatStartOptions } from '../runs/repeatStartAdmission.js'
import { requestWorkflowStopLocked } from '../runs/repeatLifecycle.js'
import { fail, lockInteraction, readContext, scopeForRun } from './wave25/context.js'
import { transact } from './wave25/transaction.js'
import { nextInteraction, publishInteraction } from './wave25/publication.js'
import { assertInteractionResponseActive, type InteractionResponseOptions } from './cancellation.js'

export interface WorkDirectionActions {
  start(principal: ManagementPrincipal, source: 'http' | 'mcp', input: RunStartV3Input,
    options: Pick<RepeatStartOptions, 'continuation'>): Promise<{ run: { id: string } }>
  wake(): Promise<void>
}

type Response = { interactionId: string; optionId: string; expectedRevision: number;
  response?: InteractionResponseValue | undefined }

export class WorkDirectionRepository {
  private actions: WorkDirectionActions | undefined
  constructor(private readonly pool: pg.Pool) {}

  useActions(actions: WorkDirectionActions): void { this.actions = actions }

  async available(interaction: DurableInteraction): Promise<boolean> {
    return (await this.pool.query(`select 1 from run_work_direction_waits d join runs r on r.id=d.run_id
      where r.id=$1 and r.execution_state='waiting' and r.record->>'outcome'='pending'
        and r.stop_requested_at is null
        and not exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)`,
    [interaction.runId])).rowCount === 1
  }

  private async authorize(sql: GraphTransactionSql, principalId: string, interaction: DurableInteraction) {
    const live = await readLiveManagementPrincipal(sql, principalId)
    requireAuthorization(live, 'interactions:read', interaction)
    requireAuthorization(live, 'interactions:respond', interaction)
    if (interaction.selectedOptionId === 'stop') requireAuthorization(live, 'runs:stop', interaction)
    if (interaction.selectedOptionId === 'continue') {
      requireAuthorization(live, 'runs:start', { workspaceId: interaction.workspaceId, workflowId: interaction.workflowId })
      requireAuthorization(live, 'workflows:read', interaction)
      requireAuthorization(live, 'workspace_locations:read', { workspaceId: interaction.workspaceId })
    }
    return live
  }

  private async continuationInput(sql: GraphTransactionSql, interaction: DurableInteraction,
    response: InteractionResponseValue | undefined): Promise<RunStartV3Input> {
    if (!this.actions) return fail('WORK_DIRECTION_START_UNAVAILABLE', 'Continue is unavailable until Run Start is configured.')
    const direction = WorkDirectionResponseSchema.parse(response).direction
    const { run } = await readAcceptedRepeatRunLocked(sql, interaction.runId)
    const workflow = (await sql.query<{ revision: string; current_version_id: string }>(
      'select revision::text,current_version_id from workflows where id=$1', [run.workflowId])).rows[0]
    if (!workflow || workflow.current_version_id !== run.workflowVersionId) {
      return fail('REVISION_CONFLICT', 'The saved workflow changed. Finish or stop this Run before starting the updated workflow.')
    }
    return RunStartV3InputSchema.parse({ workspaceId: run.workspaceId, workflowId: run.workflowId,
      workflowVersionId: run.workflowVersionId, commandId: interaction.id, executionSemanticsVersion: 3,
      expectedWorkflowRevision: Number(workflow.revision),
      expectedAgentConfigurationVersionIds: run.agentConfigurationVersionIds,
      expectedLocationRevision: run.executionLocation.locationRevision,
      input: { ...run.input, workDirection: {
        previousRunId: run.id, direction, unresolved: WorkDirectionRequestSchema.parse(interaction.request).unresolved,
      } },
    })
  }

  async respond(principal: ManagementPrincipal, source: 'http' | 'mcp', input: Response,
    options: InteractionResponseOptions = {}) {
    const run = (await this.pool.query<{ run_id: string }>(
      'select run_id from durable_interactions where id=$1', [input.interactionId])).rows[0]
    if (!run) return fail('INTERACTION_NOT_FOUND')
    const decision = await transact(this.pool, run.run_id, async (publication) => {
      const sql = publication.sql
      const current = await lockInteraction(sql, input.interactionId)
      if (current.kind !== 'work_direction') return fail('WORK_DIRECTION_WAIT_CONFLICT')
      const option = current.responseOptions.find((item) => item.optionId === input.optionId)
      if (!option) return fail('INTERACTION_OPTION_INVALID')
      const selected = withInteractionResponse(option, input.response)
      const nativeResponse = { optionId: option.optionId, semantic: option.semantic,
        ...(selected.response !== undefined ? { response: selected.response } : {}) }
      const chosen = { ...current, selectedOptionId: option.optionId }
      await this.authorize(sql, principal.id, chosen)
      beforeGraphCommit(sql, async () => {
        await this.authorize(sql, principal.id, chosen)
        assertInteractionResponseActive(options.signal)
      })
      assertInteractionResponseActive(options.signal)
      if (current.status === 'canceled') return fail('INTERACTION_CANCELED')
      if (current.status !== 'pending') {
        if (current.selectedOptionId !== input.optionId
          || canonicalGraphJson(current.nativeResponse) !== canonicalGraphJson(nativeResponse)) return fail('INTERACTION_ALREADY_DECIDED')
        await this.audit(sql, principal.id, source, current, true)
        return { interaction: current, replayed: true }
      }
      if (current.revision !== input.expectedRevision) return fail('REVISION_CONFLICT')
      const context = await readContext(sql, current, true)
      const startInput = option.optionId === 'continue' ? await this.continuationInput(sql, current, selected.response) : null
      const now = new Date().toISOString()
      const next = nextInteraction(current, { selectedOptionId: option.optionId, selectedSemantic: option.semantic,
        nativeResponse, auditReference: principal.id, decidedAt: now,
        status: startInput ? 'delivery_pending' : 'delivered', deliveryState: startInput ? 'pending' : 'delivered',
        ...(startInput ? {} : { deliveredAt: now }),
      })
      await publishInteraction(publication, context, current, next, { mutate: async (transaction) => {
        await transaction.query(`insert into run_work_direction_responses(interaction_id,principal_id,source,start_input)
          values($1,$2,$3,$4::jsonb)`, [current.id, principal.id, source, startInput ? JSON.stringify(startInput) : null])
        await this.audit(transaction, principal.id, source, next, false)
      } })
      if (option.optionId === 'stop') {
        const snapshot = await readAcceptedRepeatRunLocked(sql, current.runId)
        await requestWorkflowStopLocked(sql, current.runId,
          async () => { await this.authorize(sql, principal.id, next) }, { publication, snapshot })
      }
      return { interaction: next, replayed: false }
    })
    const interaction = await this.complete(decision.interaction)
    await this.actions?.wake()
    return { interaction, replayed: decision.replayed }
  }

  private async audit(sql: GraphTransactionSql, principalId: string, source: 'http' | 'mcp',
    interaction: DurableInteraction, replayed: boolean): Promise<void> {
    await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,$2,'interaction_respond',$3,'succeeded',$4::jsonb)`,
    [principalId, source, `interaction:${interaction.id}`, JSON.stringify({ replayed, optionId: interaction.selectedOptionId })])
  }

  private async lockContinuation(sql: GraphTransactionSql, interaction: DurableInteraction,
    principalId: string): Promise<(runId: string) => Promise<void>> {
    const scope = await scopeForRun(sql, interaction.runId)
    const publication = await openRunGraphPublication(sql, scope, readPublicProjectionLocked)
    const current = await lockInteraction(sql, interaction.id)
    await this.authorize(sql, principalId, current)
    beforeGraphCommit(sql, async () => { await this.authorize(sql, principalId, current) })
    if (current.status !== 'delivery_pending' || current.selectedOptionId !== 'continue') {
      return fail('WORK_DIRECTION_WAIT_CONFLICT')
    }
    const context = await readContext(sql, current, true)
    return async (runId) => {
      const next = nextInteraction(current, { status: 'delivered', deliveryState: 'delivered',
        deliveredAt: new Date().toISOString(), continuationRunId: runId })
      await publishInteraction(publication, context, current, next, { mutate: async (transaction) => {
        await transaction.query('update run_work_direction_responses set continuation_run_id=$2 where interaction_id=$1',
          [current.id, runId])
      } })
    }
  }

  /** A fixed Start command and input survive response retries and application restart. */
  async complete(interaction: DurableInteraction): Promise<DurableInteraction> {
    if (interaction.status !== 'delivery_pending') return interaction
    if (!this.actions) return fail('WORK_DIRECTION_START_UNAVAILABLE')
    const saved = (await this.pool.query<{ principal_id: string; source: 'http' | 'mcp'; start_input: unknown }>(
      'select principal_id,source,start_input from run_work_direction_responses where interaction_id=$1',
      [interaction.id])).rows[0]
    if (!saved || interaction.selectedOptionId !== 'continue') return fail('WORK_DIRECTION_WAIT_CONFLICT')
    const principal = await transact(this.pool, interaction.runId, async (publication) => {
      const current = await lockInteraction(publication.sql, interaction.id)
      if (current.status !== 'delivery_pending') return fail('WORK_DIRECTION_WAIT_CONFLICT')
      await readContext(publication.sql, current, true)
      return this.authorize(publication.sql, saved.principal_id, current)
    })
    const started = await this.actions.start(principal, saved.source, RunStartV3InputSchema.parse(saved.start_input), {
      continuation: { lock: (sql) => this.lockContinuation(sql, interaction, saved.principal_id) },
    })
    return transact(this.pool, interaction.runId, async (publication) => {
      const sql = publication.sql
      const current = await lockInteraction(sql, interaction.id)
      await this.authorize(sql, saved.principal_id, current)
      beforeGraphCommit(sql, async () => { await this.authorize(sql, saved.principal_id, current) })
      if (current.status !== 'delivered' || current.continuationRunId !== started.run.id) {
        return fail('WORK_DIRECTION_WAIT_CONFLICT')
      }
      return current
    })
  }
}
