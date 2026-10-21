import type { SubagentNativeRecoverySource, SubagentControlResolver } from '../subagents/types.js'
import { withTransaction } from '../../infrastructure/transaction.js'
import { recoverSubagentCommands } from '../subagents/recovery.js'
import { RunSubagentService } from '../subagents/service.js'
import { RunActivitySchema } from '@foreman-code/contracts'
import { RunStopInputSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'
import { RunStartV3InputSchema, SavedWorkflowRunSchema, CurrentJournalStopSchema, canonicalGraphJson,
  type RunStartV3Input } from '@foreman-code/contracts/wave25'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { RunHistoryService } from './history.js'
import { decodeRunHistoryCursor, encodeRunHistoryCursor } from './historyCursor.js'
import { RunInspectionService } from './inspection.js'
import { RunActivitiesService } from './activities.js'
import { RunHandoffReadService } from './handoffRead.js'
import { readCurrentRunDetails, withCurrentRunRead } from './currentRead.js'
import {
  readAcceptedRepeatRunLocked, readAcceptedRepeatRunSnapshot, readRecordedRepeatRunSnapshot,
} from './repeatStartRead.js'
import { admitRepeatRun, type RepeatStartOptions } from './repeatStartAdmission.js'
import { resolveRunStart } from './startResolution.js'
import { hasAction, isAuthorized, requireAuthorization } from '../access/policy.js'
import { intersectGrants } from '../access/operatorDelegation.js'
import { authorizedPage } from '../access/authorizedPage.js'
import { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { LangGraphWorkflowEngine } from './engine.js'
import type { PostgresRunRepository } from './postgres.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { CurrentRunProductionBinding, CurrentRuntimeAvailability } from './currentProduction.js'

import { createScheduleDispatcher } from '../schedules/runtime.js'
import type { WorkflowScheduleDispatcher } from '../schedules/dispatcher.js'
import type { ScheduleDispatchErrorReporter } from '../schedules/dispatchErrors.js'

type RunListScope = { workspaceId: string; workflowId?: string | undefined }
type RunListInput = RunListScope & { cursor?: string | undefined; limit: number }

function requireRunListScope(principal: ManagementPrincipal, scope: RunListScope): void {
  const allowed = hasAction(principal, 'runs:read') && principal.grants.some((grant) => {
    if (!grant.actions.includes('runs:read')) return false
    if (grant.scope.workspaceIds && !grant.scope.workspaceIds.includes(scope.workspaceId)) return false
    if (grant.scope.workflowIds && (scope.workflowId === undefined
      ? grant.scope.workflowIds.length === 0 : !grant.scope.workflowIds.includes(scope.workflowId))) return false
    return !grant.scope.runIds || grant.scope.runIds.length > 0
  })
  if (!allowed) throw new DomainError('ACCESS_DENIED', 'Run listing is not authorized for this scope.', 403)
}

export class RunManagementService {
  readonly subagents: RunSubagentService
  readonly history: RunHistoryService
  private scheduleDispatcher: WorkflowScheduleDispatcher | undefined
  readonly inspection: RunInspectionService
  readonly activities: RunActivitiesService
  readonly handoffs: RunHandoffReadService
  constructor(
    private readonly pool: pg.Pool,
    private readonly commands: PostgresCommandCoordinator,
    _runs: PostgresRunRepository,
    private readonly engine: LangGraphWorkflowEngine,
    private readonly locations: WorkspaceLocationService,
    private readonly currentProduction?: CurrentRunProductionBinding,
    subagentRecovery?: SubagentNativeRecoverySource,
    subagentControls?: SubagentControlResolver,
  ) {
    this.subagents = new RunSubagentService(pool, subagentControls, subagentRecovery)
    this.history = new RunHistoryService(pool)
    this.inspection = new RunInspectionService(pool)
    this.activities = new RunActivitiesService(pool)
    this.handoffs = new RunHandoffReadService(pool)
  }

  recoverSubagentCommands(): Promise<number> { return recoverSubagentCommands(this.pool) }

  /** Internal API lifecycle, not a remotely callable Start endpoint. */
  startScheduleDispatcher(reportError: ScheduleDispatchErrorReporter): void {
    if (!this.currentProduction || this.scheduleDispatcher) return
    this.scheduleDispatcher = createScheduleDispatcher(this.pool, this.locations, this.currentProduction, this.engine, reportError)
    this.scheduleDispatcher.start()
  }
  async stopScheduleDispatcher(): Promise<void> {
    await this.scheduleDispatcher?.stop()
    await this.subagents.close()
  }

  /** Report the actual schedule composition separately from native readiness. */
  scheduleAvailability(): { configured: boolean; runtimeAdmission: boolean } {
    return { configured: this.currentProduction !== undefined,
      runtimeAdmission: this.scheduleDispatcher !== undefined && this.availability().runtimeAdmission }
  }

  private visibleRun(principal: ManagementPrincipal, run: ReturnType<typeof SavedWorkflowRunSchema.parse>) {
    const visible = { ...run }
    delete visible.authorizationPrincipalId
    if (!isAuthorized(principal, 'workspace_locations:read', { workspaceId: run.workspaceId })) {
      delete visible.executionLocation
    }
    return visible
  }

  async list(principal: ManagementPrincipal, input: RunListInput) {
    const page = await this.listPage(principal, input)
    // Listing committed facts must not queue behind lifecycle writers or credential cleanup.
    const items = await Promise.all(page.items.map(({ run }) => withCurrentRunRead(
      this.pool, principal, run.workspaceId, run.id, 'runs:read',
      async (_sql, snapshot, live) => this.visibleRun(live, snapshot.run), readRecordedRepeatRunSnapshot,
    )))
    requireRunListScope(principal, input)
    return { ...page, items }
  }

  private async listPage(principal: ManagementPrincipal, input: RunListInput) {
    requireRunListScope(principal, input)
    return withTransaction(this.pool, async (client) => {
      const live = await readLiveManagementPrincipal(client, principal.id)
      requireRunListScope(live, input)
      const effective = { ...live, grants: intersectGrants(principal.grants, live.grants),
        expiresAt: new Date(Math.min(Date.parse(principal.expiresAt), Date.parse(live.expiresAt))).toISOString() }
      requireRunListScope(effective, input)
      const page = await this.readListRows(client, effective, input)
      requireRunListScope(principal, input)
      requireRunListScope(live, input)
      return page
    })
  }

  private async readListRows(client: pg.PoolClient, principal: ManagementPrincipal, input: RunListInput) {
    const scope = { workspaceId: input.workspaceId, workflowId: input.workflowId }
    const page = await authorizedPage({
      principal, action: 'runs:read', cursor: input.cursor, limit: input.limit,
      read: async (value, limit) => {
        const cursor = decodeRunHistoryCursor(scope, value)
        const rows = (await client.query<{
          id: string; workspace_id: string; workflow_id: string; record: unknown; admitted_at: string
        }>(`select id,workspace_id,workflow_id,record,
            to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as admitted_at
          from runs where workspace_id = $1 and ($2::text is null or workflow_id = $2)
            and record->'executionSemanticsVersion'='3'::jsonb
            and ($3::timestamptz is null or
              (created_at,id collate "C") < ($3::timestamptz,$4::text collate "C"))
          order by created_at desc,id collate "C" desc limit $5`,
        [input.workspaceId, input.workflowId ?? null, cursor?.admittedAt ?? null, cursor?.runId ?? null, limit])).rows
        return rows.map((row) => {
          const run = SavedWorkflowRunSchema.parse(row.record)
          if (run.id !== row.id || run.workspaceId !== row.workspace_id || run.workflowId !== row.workflow_id) {
            throw new DomainError('RUN_PIN_CONFLICT', 'A Run list record does not match its persisted scope.', 409)
          }
          return { run, admittedAt: row.admitted_at }
        })
      },
      id: (item) => encodeRunHistoryCursor(scope, { admittedAt: item.admittedAt, runId: item.run.id }),
      resource: ({ run }) => ({ workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id }),
    })
    return page
  }

  get(principal: ManagementPrincipal, workspaceId: string, runId: string) {
    return readCurrentRunDetails(this.pool, principal, workspaceId, runId)
  }

  async events(principal: ManagementPrincipal, input: { workspaceId: string; runId: string; afterSequence?: number | undefined; limit: number }) {
    return withCurrentRunRead(this.pool, principal, input.workspaceId, input.runId, 'runs:read', async (sql) => {
    const rows = await sql.query<{
      sequence: string; source: string; kind: string; harness_execution_id: string | null;
      occurred_at: Date; payload: Record<string, unknown>
    }>(
      `select sequence::text, source, kind, harness_execution_id, occurred_at, payload
       from run_activity where run_id = $1 and sequence > $2 order by run_activity.sequence limit $3`,
      [input.runId, input.afterSequence ?? -1, input.limit + 1],
    )
    const items = rows.rows.slice(0, input.limit).map((row) => RunActivitySchema.parse({
      id: `activity-${input.runId}-${row.sequence}`, runId: input.runId, sequence: Number(row.sequence),
      source: row.source, kind: row.kind,
      ...(row.harness_execution_id ? { harnessExecutionId: row.harness_execution_id } : {}),
      occurredAt: row.occurred_at.toISOString(), payload: row.payload,
    }))
    return { items, pageInfo: { nextCursor: rows.rows.length > input.limit ? String(items.at(-1)!.sequence) : null } }
    })
  }

  availability(): CurrentRuntimeAvailability {
    return this.currentProduction?.availability() ?? { runtimeAdmission: false, stopAvailable: false }
  }
  assertCurrentStopReady(): void {
    if (!this.currentProduction) throw new DomainError('REPEAT_STOP_RUNTIME_UNAVAILABLE',
      'Current V3 Stop requires A’s qualified native lifecycle and cleanup binding. No Stop was submitted.', 409)
    this.currentProduction.assertStopReady()
  }

  async start(principal: ManagementPrincipal, source: 'http' | 'mcp',
    raw: RunStartV3Input & { triggerJobId?: string | undefined },
    options: Pick<RepeatStartOptions, 'continuation'> = {}) {
    // No absent/retired/unknown tag can choose another execution path.
    if (raw.executionSemanticsVersion !== 3) throw new DomainError('EXECUTION_SEMANTICS_UNSUPPORTED',
      'Current execution requires explicit semantics 3.', 409)
    const { triggerJobId, ...value } = raw
    const input = RunStartV3InputSchema.parse(value)
    requireAuthorization(principal, 'runs:start', { workspaceId: input.workspaceId, workflowId: input.workflowId })
    requireAuthorization(principal, 'workspace_locations:read', { workspaceId: input.workspaceId })
    const production = this.currentProduction
    // The unchanged admission layer verifies exact SQL receipts BEFORE trying a
    // new publication. Replay neither invokes the native owner nor dispatches.
    // New Run initialization always calls A's REAL publisher on this same G1.
    const publication = production ? { ...production.startPublication, initializeLocked: async (...args: Parameters<typeof production.startPublication.initializeLocked>) => {
      production.assertStartReady()
      return production.startPublication.initializeLocked(...args)
    } } : undefined
    const execution = await admitRepeatRun(this.pool, this.locations, principal, source, input, publication,
      { ...options, ...(triggerJobId === undefined ? {} : { triggerJobId }) })
    if (!execution.replayed) {
      // Only a KNOWN admission COMMIT reaches dispatch. This is the existing
      // configured engine entry for every current graph, not a repeat engine.
      if (!production) throw new DomainError('REPEAT_START_RUNTIME_UNAVAILABLE', 'No current production binding is installed.', 409)
      setImmediate(() => { void this.engine.start(execution.value.id)
        .catch((error: unknown) => production.reportDispatchFailure(execution.value.id, error)) })
    }
    return { run: this.visibleRun(principal, execution.value), accepted: true as const, replayed: execution.replayed }
  }

  async resolveStart(principal: ManagementPrincipal, source: 'http' | 'mcp', input: RunStartV3Input) {
    const result = await resolveRunStart(this.pool, principal, source, input)
    return result.status === 'accepted' ? { ...result, run: this.visibleRun(principal, result.run) } : result
  }

  async stop(principal: ManagementPrincipal, source: 'http' | 'mcp', raw: { workspaceId: string; runId: string; commandId: string }) {
    const input = RunStopInputSchema.parse(raw)
    const run = await withCurrentRunRead(this.pool, principal, input.workspaceId, input.runId, 'runs:stop',
      async (_sql, snapshot) => snapshot.run, readAcceptedRepeatRunSnapshot)
    const resource = { workspaceId: input.workspaceId, workflowId: run.workflowId, runId: input.runId }
    requireAuthorization(principal, 'runs:stop', resource)
    const receiptSchema = CurrentJournalStopSchema.shape.receipt.unwrap()
    const execution = await this.commands.execute({
      principal, source, operation: 'run.stop', commandId: input.commandId, dedicatedConnection: true,
      targetKey: `run:${input.runId}`, payload: input,
      replayResult: (value) => {
        const receipt = receiptSchema.parse(value)
        if (receipt.runId !== input.runId) throw new DomainError('COMMAND_ID_CONFLICT', 'The Stop receipt belongs to a different Run.', 409)
        return receipt
      },
      // Live authority is checked even when returning a prior exact receipt.
      authorize: async (client) => {
        const live = await readLiveManagementPrincipal(client, principal.id)
        requireAuthorization(live, 'runs:stop', resource)
      },
      perform: async () => {
        this.assertCurrentStopReady()
        const receipt = receiptSchema.parse(await this.currentProduction!.stop({ principal, source, input, run,
          authorizeLocked: async (sql) => {
            await sql.query('select id from runs where id=$1 for update', [input.runId])
            const current = (await readAcceptedRepeatRunLocked(sql, input.runId)).run
            const immutable = (value: typeof run) => ({ id: value.id, workspaceId: value.workspaceId, workflowId: value.workflowId,
              workflowVersionId: value.workflowVersionId, executionSemanticsVersion: value.executionSemanticsVersion,
              agentConfigurationVersionIds: value.agentConfigurationVersionIds, executionLocation: value.executionLocation,
              authorizationPrincipalId: value.authorizationPrincipalId, approval: value.approval,
              executionCondition: value.executionCondition, input: value.input, createdAt: value.createdAt })
            if (canonicalGraphJson(immutable(current)) !== canonicalGraphJson(immutable(run))) {
              throw new DomainError('RUN_PIN_CONFLICT', 'Stop cannot change any accepted immutable Run pin.', 409)
            }
            const live = await readLiveManagementPrincipal(sql, principal.id)
            requireAuthorization(live, 'runs:stop', resource)
          },
        }))
        if (receipt.runId !== input.runId) throw new DomainError('COMMAND_ID_CONFLICT', 'The native Stop result changed its exact command scope.', 409)
        return receipt
      },
    })
    // Acceptance/replay is not process closure. A owns durable native cleanup;
    // B must not run any legacy terminalizer after a returned receipt.
    return { ...execution.value, processStopped: false as const, replayed: execution.replayed }
  }
}
