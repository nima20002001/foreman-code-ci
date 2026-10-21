import { COORDINATION_RESULT_PROTOCOL } from '@foreman-code/contracts'
import { insertAcceptedPlacements } from '../placement/persistence.js'
import type { RunPlacementAdmissionPort, PreparedRunPlacementAdmission } from '../placement/startPort.js'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { IdSchema } from '@foreman-code/contracts'
import type { RunDropdownTrigger } from '@foreman-code/contracts/run-snapshots'
import { insertRunBoardSnapshot } from './boardSnapshot.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import {
  AcceptedRepeatStartV1Schema, AcceptedWorkflowRunV3Schema, ExecutableWorkflowV3Schema,
  GraphDigestSchema, RunStartV3InputSchema, RunStartCanceledResultSchema, SavedRunVersionSnapshotSchema, canonicalGraphJson,
  sameWorkflowValue, workflowRequiresWorkspaceDirectory,
  type AcceptedRepeatStartV1, type AcceptedWorkflowRunV3, type RunStartV3Input, type RunStartCanceledResult,
} from '@foreman-code/contracts/wave25'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { acceptRunAuthority, bindRunAuthority } from '../access/runAuthority.js'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { assertClaudeFullAccess, assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import { assertGraphTransaction, beforeGraphCommit, withExclusiveGraphConnection, type GraphTransactionSql } from '../run-graph/connection.js'
import { assertRepeatCanonicalReceiptLocked, requireRepeatCanonicalReceiptBeforeCommit, type RepeatCanonicalReceipt } from '../run-graph/repeatReceipts.js'
import { requiredLocationAccess, type WorkspaceLocationService } from '../workspaces/location.js'
import {
  IMMUTABLE_WORKFLOW_VERSION_COLUMNS, readImmutableAgentConfiguration, readImmutableWorkflowVersion,
  type ImmutableAgentConfigurationRow, type ImmutableWorkflowVersionRow,
} from '../workflows/immutableRead.js'
import { readLockedRepeatStartSnapshot, type PreparedRepeatStartLocation } from '../workflows/repeatStartRead.js'
import { assertWorkflowRecovered } from './recoveryPolicy.js'
import { repeatDigest } from './repeatResolution.js'
import { readAcceptedRepeatRunLocked } from './repeatStartRead.js'
import { validateReviewerBootstrap } from '../workflows/reviewerBootstrap.js'
import { WorkerExecutionPolicy } from '../settings/workerExecution.js'
import { prepareRunStart } from './startPreparation.js'
import { RUN_START_LOCK_WAIT_MS, waitForRunStartLock, type RunStartLockWait } from './startLocks.js'
import { authorizeRunStart, lockRunStartCommand } from './startCommand.js'
import type { AcceptedProviderAccountBindings, AccountBindingAcceptance } from '../provider-accounts/acceptedBindings.js'
import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { ignoreError } from '../diagnostics/ignoredError.js'
import { requireRunStartAvailable } from './maintenance.js'
import { withRunSourceUse } from '../sources/runSourceUse.js'

/** Internal canonical producer, not a rollout flag or an admission capability.
 * The production management arm intentionally supplies no producer at this base.
 * Install it only with the existing engine's complete v3 lifecycle composition.
 * A no-op producer cannot pass the mandatory same-transaction receipt readback. */
export interface RepeatStartPublication {
  readonly workerExecution?: WorkerExecutionPolicy
  readonly placementAdmission?: RunPlacementAdmissionPort
  readonly accountBindings?: AcceptedProviderAccountBindings
  readonly preparedAccountBindings?: Readonly<Record<string, AcceptedProviderAccountBinding>>
  /** Open existing G1 with historyCoverage='from_admission', publish the queued
   * v3 Run and empty/lazy occurrence projection, on THIS branded transaction.
   * Register the G1 finalizer before returning its validated semantic digest.
   * Do not allocate an owner/checkpoint, launch native work, or eagerly enter
   * unselected repeat blocks. The existing graph enters them after COMMIT. */
  initializeLocked(sql: GraphTransactionSql, accepted: AcceptedRepeatStartV1): Promise<{ semanticDigest: string }>
}
export interface RepeatStartOptions {
  maximumResidentRuns?: number
  triggerJobId?: string
  /** Internal direction response; holds the original Run lock through acceptance. */
  continuation?: {
    lock(sql: GraphTransactionSql): Promise<(runId: string) => Promise<void>>
  }
  /** Internal SCH-04 composition only, never a field in public Start input. */
  schedule?: ScheduleStartGuard
}
/** Internal composition only. Never accepted from an HTTP/MCP request. Both
 * callbacks run on manual Start's branded transaction; throwing rolls it back. */
export interface ScheduleStartGuard {
  readonly occurrenceId: string
  readonly signal?: AbortSignal
  readonly preparation: RepeatStartPreparation
  beforeAcceptance(sql: GraphTransactionSql): Promise<void>
  afterAcceptance(sql: GraphTransactionSql, run: AcceptedWorkflowRunV3): Promise<void>
}
export interface RepeatStartOutcome { value: AcceptedWorkflowRunV3; replayed: boolean }
export interface RepeatStartPreparation {
  value?: {
    key: string
    preparedPlacements: PreparedRunPlacementAdmission | undefined
    prepared: AccountStartLocation
  }
}
type AccountStartLocation = PreparedRepeatStartLocation & {
  accountBindings?: Record<string, AcceptedProviderAccountBinding>
}
interface ReceiptRow { input_hash: string; target_key: string; result: unknown }
const locationColumns = 'id,execution_location,execution_location_identity,location_revision::text,archived_at'

/** The source identity is permanent even after batch retention or a reset. */
export function repeatStartReceipt(run: AcceptedWorkflowRunV3): RepeatCanonicalReceipt {
  return { scope: { workspaceId: run.workspaceId, workflowId: run.workflowId, workflowVersionId: run.workflowVersionId,
    runId: run.id, executionSemanticsVersion: 3 }, evidence: { sourceKind: 'run', sourceId: run.id, sourceRevision: '0' },
  sourceDigest: repeatDigest(run), effect: null }
}
function conflict(code: string, message: string): never { throw new DomainError(code, message, 409) }

/** Only a newly accepted queued record can be the immutable command result. */
function acceptedReceipt(raw: unknown, input: RunStartV3Input): AcceptedWorkflowRunV3 {
  const run = AcceptedWorkflowRunV3Schema.parse(raw)
  if (run.executionState !== 'queued' || run.outcome !== 'pending' || run.startedAt !== undefined
    || run.finishedAt !== undefined || run.result !== undefined || run.workspaceId !== input.workspaceId
    || run.workflowId !== input.workflowId || run.workflowVersionId !== input.workflowVersionId
    || run.executionLocation.locationRevision !== input.expectedLocationRevision
    || !sameWorkflowValue(run.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)
    || !sameWorkflowValue(run.input, input.input)) {
    return conflict('RUN_START_RECEIPT_CONFLICT', 'The stored Start result does not match this exact accepted command.')
  }
  return run
}
function immutableRun(run: AcceptedWorkflowRunV3) {
  return { id: run.id, workspaceId: run.workspaceId, workflowId: run.workflowId, workflowVersionId: run.workflowVersionId,
    executionSemanticsVersion: run.executionSemanticsVersion, agentConfigurationVersionIds: run.agentConfigurationVersionIds,
    ...(run.resultProtocol ? { resultProtocol: run.resultProtocol } : {}),
    executionLocation: run.executionLocation, authorizationPrincipalId: run.authorizationPrincipalId, approval: run.approval,
    executionCondition: run.executionCondition, input: run.input, createdAt: run.createdAt }
}

/** Replay is independent of today's workflow/draft/Agent heads and filesystem.
 * It still proves immutable Run/version/configuration/authority and canonical
 * initialization backing. Run membership or a successful audit alone is not a
 * receipt and cannot authorize another Run or dispatch. */
export async function readStartReceipt(sql: GraphTransactionSql, principalId: string, input: RunStartV3Input,
  hash: string, target: string): Promise<AcceptedWorkflowRunV3 | RunStartCanceledResult | undefined> {
  const rows = await sql.query<ReceiptRow>(`select input_hash,target_key,result from management_command_receipts
    where principal_id=$1 and operation='run.start' and command_id=$2`, [principalId, input.commandId])
  if (rows.rows.length > 1) return conflict('RUN_START_RECEIPT_CONFLICT', 'The Start command has contradictory receipts.')
  const receipt = rows.rows[0]
  if (!receipt) {
    const orphaned = await sql.query(`select 1 from management_audit where principal_id=$1 and action='run.start'
      and outcome='succeeded' and details->>'commandId'=$2 limit 1`, [principalId, input.commandId])
    if (orphaned.rowCount) return conflict('RUN_START_RECEIPT_MISSING', 'Start has durable success evidence but no exact command receipt. No new Run was created.')
    return undefined
  }
  if (receipt.input_hash !== hash || receipt.target_key !== target) {
    return conflict('COMMAND_ID_CONFLICT', 'This command ID was already used with different input.')
  }
  const canceled = RunStartCanceledResultSchema.safeParse(receipt.result)
  if (canceled.success) return canceled.data
  const run = acceptedReceipt(receipt.result, input)
  const current = await readAcceptedRepeatRunLocked(sql, run.id)
  SavedRunVersionSnapshotSchema.parse({ run, version: current.version })
  if (!sameWorkflowValue(immutableRun(run), immutableRun(current.run))) {
    return conflict('RUN_START_RECEIPT_CONFLICT', 'The accepted command and durable Run disagree on immutable pins.')
  }
  const binding = await sql.query<{ caller_principal_id: string }>(`select caller_principal_id from run_authority_principals
    where principal_id=$1 and run_id=$2 for share`, [run.authorizationPrincipalId, run.id])
  if (binding.rows.length !== 1 || binding.rows[0]?.caller_principal_id !== principalId) {
    return conflict('RUN_START_RECEIPT_CONFLICT', 'The accepted Run authority is not bound to this Start caller.')
  }
  await sql.query('select run_id from run_graph_heads where run_id=$1 for share', [run.id])
  await assertRepeatCanonicalReceiptLocked(sql, repeatStartReceipt(run))
  return run
}

async function readPreparationInputs(pool: pg.Pool, input: RunStartV3Input, signal: AbortSignal) {
  signal.throwIfAborted()
  const client = await pool.connect()
  try {
    signal.throwIfAborted()
    const rows = await client.query<ImmutableWorkflowVersionRow>(
      `select ${IMMUTABLE_WORKFLOW_VERSION_COLUMNS} from workflow_versions where id=$1 and workspace_id=$2 and workflow_id=$3`,
      [input.workflowVersionId, input.workspaceId, input.workflowId])
    if (!rows.rows[0]) throw new DomainError('WORKFLOW_VERSION_NOT_FOUND', 'The pinned workflow version was not found.', 404)
    const version = readImmutableWorkflowVersion(rows.rows[0], { id: input.workflowVersionId, workspaceId: input.workspaceId, workflowId: input.workflowId })
    signal.throwIfAborted()
    if (!('executionSemanticsVersion' in version) || version.executionSemanticsVersion !== 3) {
      return conflict('EXECUTION_SEMANTICS_UNSUPPORTED', 'The v3 Start contract requires an immutable semantics-3 version.')
    }
    if (!sameWorkflowValue(version.agentConfigurationVersionIds, input.expectedAgentConfigurationVersionIds)) {
      return conflict('WORKFLOW_CONFIGURATION_STALE', 'The supplied configuration pins do not match the saved version.')
    }
    const configs = await client.query<ImmutableAgentConfigurationRow>(
      'select id,workspace_id,agent_id,version,record from agent_configuration_versions where workspace_id=$1 and id=any($2::text[]) order by id',
      [input.workspaceId, Object.values(version.agentConfigurationVersionIds)])
    const configurations = configs.rows.map((row) => readImmutableAgentConfiguration(row, {
      workspaceId: input.workspaceId, id: version.agentConfigurationVersionIds[row.agent_id]!, agentId: row.agent_id,
    }))
    const before = await client.query<PreparedRepeatStartLocation['row']>(`select ${locationColumns} from workspaces where id=$1`, [input.workspaceId])
    const row = before.rows[0]
    if (!row) throw new DomainError('WORKSPACE_NOT_FOUND', 'The workspace was not found.', 404)
    return { version, configurations, row }
  } finally { client.release() }
}

async function prepareLocation(pool: pg.Pool, locations: WorkspaceLocationService,
  input: RunStartV3Input, signal: AbortSignal,
  placements?: PreparedRunPlacementAdmission,
  accounts?: AcceptedProviderAccountBindings): Promise<AccountStartLocation> {
  const saved = await readPreparationInputs(pool, input, signal)
  const { version, configurations, row } = saved
  const accountBindings: Record<string, AcceptedProviderAccountBinding> = {}
  if (accounts) {
    for (const configuration of configurations) {
      const binding = await accounts.prepare(configuration.harness, configuration.harnessProfileSelection, { signal })
      if (binding) accountBindings[configuration.id] = binding
      signal.throwIfAborted()
    }
  }
  signal.throwIfAborted()
  for (const configuration of configurations) assertClaudeFullAccess(configuration.harness)
  ExecutableWorkflowV3Schema.parse({ version, configurations })
  for (const configuration of configurations) assertNativeWorkflowConfiguration(configuration.harness, version.approval,
    version.approval.handler === 'orchestrator' && configuration.agentId === version.approval.designatedOrchestratorAgentId)
  if (version.approval.handler === 'orchestrator') validateReviewerBootstrap(version.definition, version.approval,
    configurations.find((config) => config.agentId === version.approval.designatedOrchestratorAgentId)?.harness, version.entryNodeId)
  const useAssignedLocation = placements !== undefined && !workflowRequiresWorkspaceDirectory(version.definition)
  const location = useAssignedLocation
    ? await locations.snapshotAssigned(pool, input.workspaceId, input.expectedLocationRevision, signal)
    : await locations.snapshot(pool, input.workspaceId, input.expectedLocationRevision,
      requiredLocationAccess(configurations), signal)
  signal.throwIfAborted()
  const after = await readPreparationInputs(pool, input, signal)
  if (!sameWorkflowValue(row, after.row)) {
    return conflict('LOCATION_REVISION_CONFLICT', 'The location changed during validation.')
  }
  if (!sameWorkflowValue(saved, after)) {
    return conflict('RUN_START_PREPARATION_CONFLICT', 'Saved Start inputs changed during preparation.')
  }
  signal.throwIfAborted()
  return { row, location, ...(accounts ? { accountBindings } : {}) }
}

async function prepareStart(pool: pg.Pool, locations: WorkspaceLocationService, input: RunStartV3Input,
  principal: ManagementPrincipal, source: 'http' | 'mcp', publication: RepeatStartPublication, schedule?: ScheduleStartGuard) {
  const key = commandInputHash({ ...input, commandId: null, principalId: principal.id })
  schedule?.signal?.throwIfAborted()
  const cached = schedule?.preparation.value
  // Only the occurrence command changes on an eligibility retry. Live row,
  // placement, authorization and schedule checks still run in each transaction.
  if (cached?.key === key) return cached
  const value = await prepareRunStart(async (signal, sourcePreparationStarted) => {
    const preparedPlacements = await publication.placementAdmission?.prepare(input, principal, signal,
      { source, sourcePreparationStarted })
    signal.throwIfAborted()
    const prepared = await prepareLocation(pool, locations, input, signal, preparedPlacements, publication.accountBindings)
    signal.throwIfAborted()
    return { key, preparedPlacements, prepared }
  }, schedule?.signal)
  if (schedule) schedule.preparation.value = value
  return value
}

/** The v3 INSERT and canonical initialization share the existing Start G1
 * transaction. This function does not acquire RunOwnership or invoke the graph. */
export async function insertRepeatRun(sql: GraphTransactionSql, input: AcceptedRepeatStartV1,
  publication: RepeatStartPublication, admissionTrigger: RunDropdownTrigger = 'manual',
  placementAdmission?: PreparedRunPlacementAdmission): Promise<AcceptedWorkflowRunV3> {
  assertGraphTransaction(sql)
  await requireRunStartAvailable(sql)
  const accepted = AcceptedRepeatStartV1Schema.parse(JSON.parse(canonicalGraphJson(input)))
  const run = acceptedReceipt(accepted.run, accepted.snapshot.request)
  const receipt = repeatStartReceipt(run)
  await sql.query(`insert into runs(id,workspace_id,workflow_id,workflow_version_id,execution_state,record,
    runner_id,working_directory,location_revision) values($1,$2,$3,$4,'queued',$5::jsonb,$6,$7,$8)`,
  [run.id, run.workspaceId, run.workflowId, run.workflowVersionId, canonicalGraphJson(run),
    run.executionLocation.runnerId, run.executionLocation.rootPath, run.executionLocation.locationRevision])
  const providerAccountBindings: Record<string, AcceptedProviderAccountBinding> = {}
  if (publication.accountBindings) {
    const entries: (AccountBindingAcceptance & { key: string })[] = []
    for (const configuration of accepted.snapshot.executable.configurations) {
      entries.push({ id: `${run.id}:agent:${configuration.agentId}`, key: `agent:${configuration.agentId}`,
        configuration: configuration.harness, selection: configuration.harnessProfileSelection,
        options: { prepared: publication.preparedAccountBindings?.[configuration.id] } })
    }
    for (const node of accepted.snapshot.executable.version.definition.nodes) {
      if (node.kind === 'job') continue
      const configuration = accepted.snapshot.executable.configurations.find(value => value.agentId === node.agentId)
      if (!configuration) throw new DomainError('RUN_CONFIGURATION_MISSING', 'The node configuration is unavailable.', 409)
      entries.push({ id: `${run.id}:${node.id}`, key: node.id,
        configuration: configuration.harness, selection: configuration.harnessProfileSelection,
        options: { prepared: publication.preparedAccountBindings?.[configuration.id] } })
    }
    const bindings = await publication.accountBindings.acceptMany(sql, 'run-node', entries)
    for (const entry of entries) {
      const binding = bindings.get(entry.id)
      if (binding) providerAccountBindings[entry.key] = binding
    }
  }
  // Required admission write: failure rolls back the Run, authority and command.
  // Internal scheduled admission must pass 'schedule'; never accept it from HTTP/MCP input.
  await insertRunBoardSnapshot(sql, accepted, admissionTrigger,
    publication.accountBindings ? providerAccountBindings : undefined)
  if (placementAdmission) await insertAcceptedPlacements(sql, run.id, accepted.snapshot.executable.version.definition.nodes.filter(node => node.kind !== 'job'),
    run.agentConfigurationVersionIds, placementAdmission.bind(run.id), placementAdmission.fence(sql))
  else if (accepted.snapshot.executable.version.definition.nodes.some(node => node.kind !== 'job' && node.placement)) {
    return conflict('PLACEMENT_ADMISSION_UNAVAILABLE', 'Saved Agent placement requires authenticated source/root admission.')
  }
  // Do not let an adapter mutate the candidate whose digest/pins we retained.
  const published = await publication.initializeLocked(sql, AcceptedRepeatStartV1Schema.parse(JSON.parse(canonicalGraphJson(accepted))))
  const semanticDigest = GraphDigestSchema.parse(published.semanticDigest)
  requireRepeatCanonicalReceiptBeforeCommit(sql, { ...receipt, semanticDigest })
  beforeGraphCommit(sql, async () => {
    const current = await readAcceptedRepeatRunLocked(sql, run.id)
    if (!sameWorkflowValue(current.run, run)) return conflict('RUN_START_RECEIPT_CONFLICT', 'The queued Run changed inside Start publication.')
  })
  return run
}

/** Same operation/key/hash/locks/audit as existing Run Start. A returned new Run
 * has a KNOWN COMMIT; a rejected/unknown COMMIT never grants dispatch. A retry
 * reads the same command receipt and never dispatches it a second time.
 * Absent production composition permits only a verified replay, not a new Run. */
export async function admitRepeatRun(pool: pg.Pool, locations: WorkspaceLocationService,
  principal: ManagementPrincipal, source: 'http' | 'mcp' | 'schedule', raw: RunStartV3Input,
  publication: RepeatStartPublication | undefined, options: RepeatStartOptions = {}): Promise<RepeatStartOutcome> {
  const input = RunStartV3InputSchema.parse(JSON.parse(canonicalGraphJson(raw)))
  if ((source === 'schedule') !== Boolean(options.schedule)) {
    throw new DomainError('SCHEDULE_ADMISSION_INVALID', 'Scheduled Start requires its internal atomic guard.', 409)
  }
  const triggerJobId = options.triggerJobId === undefined ? undefined : IdSchema.parse(options.triggerJobId)
  if (triggerJobId !== undefined) {
    throw new DomainError('REPEAT_TRIGGER_UNSUPPORTED', 'Legacy trigger jobs cannot enter current Run Start; workflow schedules require the atomic dispatcher.', 409)
  }
  const maximumResidentRuns = options.maximumResidentRuns ?? 32
  if (!Number.isInteger(maximumResidentRuns) || maximumResidentRuns < 1 || maximumResidentRuns > 128) {
    throw new Error('maximumResidentRuns must be an integer between 1 and 128')
  }
  const authorize = (caller: ManagementPrincipal) => authorizeRunStart(caller, input)
  authorize(principal)
  const hash = commandInputHash({ ...input, ...(triggerJobId === undefined ? {} : { triggerJobId }),
    ...(options.schedule ? { scheduleOccurrenceId: options.schedule.occurrenceId } : {}) })
  const target = `workflow:${input.workflowId}:version:${input.workflowVersionId}`
  const liveAuthority = async (sql: GraphTransactionSql) => {
    const live = await readLiveManagementPrincipal(sql, principal.id)
    authorize(live)
    const valid = await sql.query('select 1 where clock_timestamp() < $1::timestamptz',
      [new Date(Math.min(Date.parse(principal.expiresAt), Date.parse(live.expiresAt))).toISOString()])
    if (valid.rowCount !== 1) throw new DomainError('AUTH_REVOKED', 'Start authority expired before commit.', 403)
  }
  const commandLock = async (sql: GraphTransactionSql, wait: RunStartLockWait) => {
    await lockRunStartCommand(sql, principal, input, wait)
  }
  const lockWait: RunStartLockWait = { deadline: performance.now() + RUN_START_LOCK_WAIT_MS,
    ...(options.schedule?.signal ? { signal: options.schedule.signal } : {}) }
  let admissionBegan = false
  try {
    const replay = await withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
      await commandLock(sql, lockWait)
      return readStartReceipt(sql, principal.id, input, hash, target)
    }))
    if (replay && 'status' in replay) return conflict('RUN_START_CANCELED', 'This Start was canceled. Review current settings and explicitly start again.')
    if (replay) return { value: replay, replayed: true }
    if (!publication || typeof publication.initializeLocked !== 'function') {
      return conflict('REPEAT_START_RUNTIME_UNAVAILABLE', 'New v3 Runs remain disabled until canonical publication and the complete existing-engine lifecycle are composed.')
    }
    // Hierarchy routing follows its saved definition. New-Run result-protocol pinning remains off.
    return await withRunSourceUse(pool, input.workspaceId, async () => {
      const sourceTransport = source === 'http' ? 'http' : 'mcp'
      const preparationStarted = performance.now()
      const { preparedPlacements, prepared } = await prepareStart(pool, locations, input, principal, sourceTransport, publication,
        options.schedule)
      // Preparation has its own deadline; keep the remaining shared lock-wait budget.
      lockWait.deadline += performance.now() - preparationStarted
      options.schedule?.signal?.throwIfAborted()
      return await withExclusiveGraphConnection(pool, (connection) => connection.transaction(async (sql) => {
        options.schedule?.signal?.throwIfAborted()
        if (options.schedule?.signal) beforeGraphCommit(sql, async () => options.schedule!.signal!.throwIfAborted())
        await commandLock(sql, lockWait)
        const replayed = await readStartReceipt(sql, principal.id, input, hash, target)
        if (replayed && 'status' in replayed) return conflict('RUN_START_CANCELED', 'This Start was canceled. Review current settings and explicitly start again.')
        if (replayed) return { value: replayed, replayed: true }
        await waitForRunStartLock(sql, `admission:runner:${prepared.location.runnerId}`, lockWait)
        await waitForRunStartLock(sql, `admission:workspace:${input.workspaceId}`, lockWait)
        const completeContinuation = await options.continuation?.lock(sql)
        await assertWorkflowRecovered(sql, input.workspaceId, input.workflowId)
        const live = await sql.query<{ count: string }>(`select count(*)::text as count from runs r where r.runner_id=$1
          and (r.execution_state in ('queued','running','waiting') or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending))`,
        [prepared.location.runnerId])
        const count = live.rows[0]?.count
        if (!count || !/^[0-9]+$/.test(count)) return conflict('RUNNER_ADMISSION_UNCERTAIN', 'Runner capacity could not be established.')
        if (BigInt(count) >= BigInt(maximumResidentRuns)) return conflict('RUNNER_ADMISSION_FULL', 'The runner has reached its bounded active-Run capacity.')
        const authority = await acceptRunAuthority(sql, principal)
        authorize(authority.principal)
        await options.schedule?.beforeAcceptance(sql)
        // acceptRunAuthority creates a NEW tokenless principal. Pass that exact
        // principal to the helper; patching the caller snapshot's ID is not a proof.
        const snapshot = await readLockedRepeatStartSnapshot(sql, authority.principal, input, prepared)
        const version = snapshot.executable.version
        const workerExecution = publication.workerExecution ?? new WorkerExecutionPolicy()
        for (const node of version.definition.nodes) {
          if (node.kind !== 'job' && node.placement) workerExecution.requireEnabled(node.placement.hostRef)
        }
        const run = AcceptedWorkflowRunV3Schema.parse({ resultProtocol: COORDINATION_RESULT_PROTOCOL, id: `run-${randomUUID()}`, workspaceId: input.workspaceId,
          workflowId: input.workflowId, workflowVersionId: version.id, executionSemanticsVersion: 3,
          agentConfigurationVersionIds: version.agentConfigurationVersionIds, executionLocation: snapshot.workspace.location,
          authorizationPrincipalId: authority.principal.id, approval: version.approval,
          executionCondition: version.definition.executionCondition, executionState: 'queued', outcome: 'pending',
          input: input.input, createdAt: new Date().toISOString() })
        admissionBegan = true
        await insertRepeatRun(sql, AcceptedRepeatStartV1Schema.parse({ snapshot, run }), {
          ...publication, ...(prepared.accountBindings ? { preparedAccountBindings: prepared.accountBindings } : {}),
        },
          source === 'schedule' ? 'schedule' : 'manual', preparedPlacements)
        await bindRunAuthority(sql, run.id, authority)
        await sql.query(`insert into management_command_receipts(principal_id,operation,command_id,target_key,input_hash,result)
          values($1,'run.start',$2,$3,$4,$5::jsonb)`, [principal.id, input.commandId, target, hash, canonicalGraphJson(run)])
        await sql.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
          values($1,$2,'run.start',$3,'succeeded',$4::jsonb)`, [principal.id, source, target, JSON.stringify({ commandId: input.commandId })])
        beforeGraphCommit(sql, async () => {
          await liveAuthority(sql)
          const accepted = await readLiveManagementPrincipal(sql, authority.principal.id)
          authorize(accepted)
          const valid = await sql.query('select 1 where clock_timestamp() < $1::timestamptz', [accepted.expiresAt])
          if (valid.rowCount !== 1) throw new DomainError('AUTH_REVOKED', 'Accepted Run authority expired before commit.', 403)
        })
        await options.schedule?.afterAcceptance(sql, run)
        await completeContinuation?.(run.id)
        return { value: run, replayed: false }
      }))
    })
  } catch (error) {
    // Audit is diagnostic, not an admission/negative-submission receipt. An
    // exception after staging may be a lost COMMIT reply; retain that uncertainty.
    await pool.query(`insert into management_audit(principal_id,source,action,target_key,outcome,details)
      values($1,$2,'run.start',$3,'failed',$4::jsonb)`, [principal.id, source, target,
    JSON.stringify({ commandId: input.commandId, code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR',
      ...(admissionBegan ? { admissionOutcome: 'unconfirmed' } : {}) })])
      .catch(ignoreError('engine', 'record failed run start audit', { commandId: input.commandId }))
    throw error
  }
}
