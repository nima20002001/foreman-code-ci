import type pg from 'pg'
import { DeviceConnectionIdentitySchema, type DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import { WorkflowVersionV3Schema, sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { ExecutionFactsRequestSchema, ExecutionFactsResultSchema, ExecutionAuthorityRequestSchema, ExecutionAuthorityResultSchema, EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import { readPlacement } from './binding.js'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { configurationWithNodeSkills } from '../skills/nodeSkills.js'
import { readExecutionAuthoritySnapshot } from './executionAuthorityRead.js'
import { readExecutionPlacement, readNativePlacement } from './persistence.js'
import { readReconciledDispatchIntent } from '../runs/remote/persistence.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { withExclusiveGraphConnection, beforeGraphCommit } from '../run-graph/connection.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
export interface ExecutionRunAuthorityPort {
  revalidateRunAuthorization(principalId: string, workspaceId: string, workflowId: string, client: GraphSqlClient, atCommit: boolean): Promise<void>
}
import type { DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { withAuthorizationReadSnapshot } from '../access/authorizationReadSnapshot.js'
import type { AgentPlacementProducer } from './agentProducer.js'
import { DomainError, databaseReadFailure } from '../errors.js'
import { assertRemoteReviewAssignment, canCloseRetainedRemoteReviewer, remoteReviewerPolicy } from './remoteReviewerAuthority.js'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'

const denied = (): never => { throw new DomainError('REMOTE_AUTHORITY_DENIED', 'Exact original execution authority is unavailable or revoked.', 403) }
/** Read-only admission fence. This NEVER issues an entry capability, command,
 * new grant, allocation or lease; main and worker entry guards remain mandatory. */
export async function assertRemoteExecutionAuthority(sql: GraphSqlClient,
  locations: ExecutionRunAuthorityPort,
  raw: unknown, authenticated: Readonly<DeviceConnectionIdentity>, producer: AgentPlacementProducer,
  lock = true): Promise<{ cleanupOnly: true } | undefined> {
  if (lock) return checkRemoteExecutionAuthority(sql, locations, raw, authenticated, producer, lock)
  const input = ExecutionAuthorityRequestSchema.parse(raw)
  return withAuthorizationReadSnapshot(sql, input.intent.runId, readPlacement(input.placement),
    () => checkRemoteExecutionAuthority(sql, locations, input, authenticated, producer, lock))
}

async function checkRemoteExecutionAuthority(sql: GraphSqlClient,
  locations: ExecutionRunAuthorityPort,
  raw: unknown, authenticated: Readonly<DeviceConnectionIdentity>, producer: AgentPlacementProducer,
  lock: boolean): Promise<{ cleanupOnly: true } | undefined> {
  const input = ExecutionAuthorityRequestSchema.parse(raw), pin = readPlacement(input.placement)
  // Owner transactions that write keep these rows locked until COMMIT. A Worker's read-only admission
  // check reads the latest committed rows instead and must not queue behind a busy Run.
  const share = (clause: string) => lock ? ` ${clause}` : ''
  const snapshot = lock ? undefined : await readExecutionAuthoritySnapshot(sql, input.intent)
  const current = lock ? await readReconciledDispatchIntent(sql, input.intent.operationId, true) : snapshot?.current
  const persisted = lock ? await readExecutionPlacement(sql, input.intent.executionId) : snapshot?.placement
  if (!current || !persisted || !sameWorkflowValue(current, input.intent) || !sameWorkflowValue(pin, persisted)
    || pin.hostRef.kind !== 'device' || !pin.registration || authenticated.mainId !== pin.mainId
    || authenticated.deviceId !== pin.hostRef.deviceId || authenticated.workerInstallationId !== pin.registration.workerInstallationId
    || authenticated.keyRevision !== pin.registration.keyRevision || authenticated.authorizationRevision !== pin.registration.authorizationRevision) denied()
  const registration = await assertDeviceHostInstallation(sql, pin.hostRef, pin.registration!.workerInstallationId)
  if (!registration || registration.keyRevision !== pin.registration!.keyRevision
    || registration.authorizationRevision !== pin.registration!.authorizationRevision) denied()
  const row = snapshot?.row ?? (await sql.query<{ authorization_principal_id: string; workspace_id: string; workflow_id: string;
    execution_state: string; stopped: boolean; cleanup: boolean; failed: boolean }>(`select r.record->>'authorizationPrincipalId' as authorization_principal_id,
      r.workspace_id,r.workflow_id,r.execution_state,r.stop_requested_at is not null as stopped,
      exists(select 1 from run_cleanup_intents i where i.run_id=r.id and i.pending) as cleanup,
      exists(select 1 from approval_execution_state b where b.execution_id=e.id
        and b.failure_result is not null) as failed
      from runs r join harness_executions e on e.run_id=r.id where r.id=$1 and e.id=$2${share('for share of r,e')}`,
    [current!.runId, current!.executionId])).rows[0]
  if (!row) denied()
  const cleanup = (row!.cleanup || row!.failed) && (input.action === 'stop' || input.action === 'read')
  const grantCount = snapshot ? Number(snapshot.row.granted) : (await sql.query(`select 1 from execution_dispatch_owner_grants
    where execution_id=$1 and operation_id=$2 and grant_id=$3 and epoch=$4 and not revoked${share('for share')}`,
    [current!.executionId, current!.operationId, current!.owner.grantId, current!.owner.epoch])).rowCount
  if (grantCount !== 1) denied()
  const origin = snapshot ? snapshot.origin
    : (await sql.query<{ connection: unknown }>(`select connection from remote_dispatch_origins where operation_id=$1${share('for share')}`,
    [current!.operationId])).rows[0]
  if (!origin) denied()
  const connection = DeviceConnectionIdentitySchema.parse(origin!.connection)
  if (connection.mainId !== authenticated.mainId || connection.deviceId !== authenticated.deviceId
    || connection.workerInstallationId !== authenticated.workerInstallationId || connection.keyRevision !== authenticated.keyRevision
    || connection.authorizationRevision !== authenticated.authorizationRevision) denied()
  if (input.action !== 'read' && input.action !== 'stop' && connection.bootId !== authenticated.bootId) denied()
  // A reconnect of the same Worker boot keeps the original authority; only a changed boot is narrowed.
  const changedBoot = connection.bootId !== authenticated.bootId
  let resident: boolean
  {
    const stored = snapshot ? snapshot.stored
      : (await sql.query<{ receipt: unknown }>(
      `select receipt from remote_execution_receipts where operation_id=$1${share('for share')}`, [current!.operationId])).rows[0]
    const receipt = RemoteOperationReceiptSchema.safeParse(stored?.receipt)
    if (stored && (!receipt.success || !sameWorkflowValue(receipt.data.intent, current)
      || !sameWorkflowValue(receipt.data.connection, connection))) denied()
    resident = receipt.success && receipt.data.native !== undefined
    if (input.action === 'stop' && !row!.cleanup && !row!.failed
      && (!receipt.success || !await canCloseRetainedRemoteReviewer(sql, receipt.data))) denied()
  }
  // Cleanup observes and cancels the admitted owner even when it can no longer launch.
  if (!cleanup) {
    await locations.revalidateRunAuthorization(row!.authorization_principal_id, row!.workspace_id, row!.workflow_id,
      sql, true)
    // A restarted OS can read the admitted owner's closure; it cannot qualify that process to continue.
    if (!changedBoot) {
      await producer.assertPinsCurrent(sql, pin, await readLiveManagementPrincipal(sql, row!.authorization_principal_id),
        row!.workspace_id, resident ? { purpose: 'resident' } : undefined)
    }
  }
  if (input.action === 'start') {
    if (!await readNativePlacement(sql, current!.executionId)) denied()
    if (row!.stopped || !['running', 'waiting'].includes(row!.execution_state)) denied()
    const entryCount = snapshot ? Number(snapshot.row.entered) : (await sql.query(`select 1 from workflow_native_entries where execution_id=$1 and run_id=$2 and phase='entered'${share('for share')}`,
      [current!.executionId, current!.runId])).rowCount
    if (entryCount !== 1) denied()
  }
  if (input.action === 'retain-reviewer' || input.action === 'review') {
    if (row!.stopped || row!.cleanup || !['running', 'waiting'].includes(row!.execution_state)) denied()
    if (input.action === 'review') {
      if (!input.review) denied()
      await assertRemoteReviewAssignment(sql, input.intent, input.review!)
    }
  }
  return cleanup ? { cleanupOnly: true } : undefined
}
export function createExecutionAuthorityExtension(pool: pg.Pool,
  locations: ExecutionRunAuthorityPort, producer: AgentPlacementProducer): DeviceExtensionRegistration {
  return { ...EXECUTION_AUTHORITY_EXTENSION, role: 'server', async handle(raw, context) {
    if (context.bytes?.byteLength) denied()
    const facts = ExecutionFactsRequestSchema.safeParse(raw)
    const input = facts.success ? facts.data.authorization : ExecutionAuthorityRequestSchema.parse(raw)
    // Read-only admission: check, then verify again at COMMIT against the latest committed rows. No
    // row lock is needed because nothing is written and the Worker acts only after this reply.
    return withExclusiveGraphConnection(pool, connection => connection.transaction(async sql => {
      const authority = await assertRemoteExecutionAuthority(sql, locations, input, context.binding, producer, false)
      beforeGraphCommit(sql, async () => { await assertRemoteExecutionAuthority(sql, locations, input, context.binding, producer, false) })
      if (facts.success) {
        if ((await sql.query('select 1 from source_preparation_reconciliations where operation_id=$1',
          [input.intent.operationId])).rowCount) denied()
        const placement = await readExecutionPlacement(sql, input.intent.executionId)
        const native = await readNativePlacement(sql, input.intent.executionId)
        if (!placement || !native || placement.payload.kind !== 'agent') return denied()
        const row = (await sql.query<{ record: unknown; version: unknown }>(`select c.record,v.record as version
          from agent_configuration_versions c join runs r on r.id=$3
          join workflow_versions v on v.id=r.workflow_version_id where c.id=$1 and c.agent_id=$2`,
        [placement.payload.agentConfigurationVersionId, placement.payload.agentId, input.intent.runId])).rows[0]
        const pinned = AgentConfigurationVersionSchema.parse(row?.record)
        const version = WorkflowVersionV3Schema.parse(row?.version)
        const node = version.definition.nodes.find(item => item.id === input.intent.nodeId)
        if (!node || node.kind === 'job' || node.agentId !== pinned.agentId
          || version.agentConfigurationVersionIds[node.agentId] !== pinned.id) return denied()
        const configuration = node.skills
          ? configurationWithNodeSkills(pinned, node.skills, version.nodeSkillSnapshots?.[node.id]) : pinned
        const origin = (await sql.query<{ connection: unknown }>(
          'select connection from remote_dispatch_origins where operation_id=$1',
          [input.intent.operationId])).rows[0]
        const originalConnection = DeviceConnectionIdentitySchema.parse(origin?.connection)
        const stored = (await sql.query<{ receipt: unknown }>(
          'select receipt from remote_execution_receipts where operation_id=$1',
          [input.intent.operationId])).rows[0]
        const receipt = stored && RemoteOperationReceiptSchema.parse(stored.receipt)
        const resident = originalConnection.bootId === context.binding.bootId && receipt?.native !== undefined
        const harness = await producer.harnessFacts(sql, placement!, resident ? { purpose: 'resident' } : undefined)
        return { payload: ExecutionFactsResultSchema.parse({ version: 1, intent: input.intent, placement, executionPlacement: native, configuration, harness }) }
      }
      const policy = input.action === 'retain-reviewer' || input.action === 'review'
        ? await remoteReviewerPolicy(sql, input.intent) : undefined
      return { payload: ExecutionAuthorityResultSchema.parse({ version: 1, action: input.action,
        operationId: input.intent.operationId, attemptId: input.intent.attemptId, bindingHash: input.intent.bindingHash,
        owner: input.intent.owner, ...authority,
        ...(policy ? { reviewer: { agentId: policy.execution.agentId,
          expiresAt: new Date(Date.now() + 60_000).toISOString() } } : {}) }) }
    })).catch((error: unknown) => { throw databaseReadFailure(error) })
  } }
}
