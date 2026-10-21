import { DeviceConnectionIdentitySchema, type DeviceConnectionIdentity } from '@foreman-code/contracts/device-identity'
import { RemoteOperationReceiptSchema, type RemoteOperationReceipt } from '@foreman-code/contracts/remote-execution'
import type { DispatchIntent, AcceptedNodePlacement } from '@foreman-code/contracts/node-placement'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { beforeGraphCommit, isGraphTransactionFinalizing } from '../run-graph/connection.js'
import type { RunOwnership } from '../runs/ownership.js'
import { readReconciledDispatchIntent, persistVerifiedRemoteReceipt, auditRejectedRemoteReceipt } from '../runs/remote/persistence.js'
import type { RemoteResultCommitPort, RemoteResultTransaction, VerifiedRemoteEvidence } from '../runs/remote/resultBridge.js'
import { readAcceptedPlacement } from './persistence.js'
import { DomainError } from '../errors.js'
import { sameDeviceInstallation } from '../devices/deviceReconnect.js'

/** Live original owner/device/root/config/credential fences and the existing
 * native canonical writer, all on THIS branded main transaction. The writer
 * must consume verified remote original-source evidence, never a local capture
 * cast or a digest standing in for W11 physical/W09 artifact attestation. */
export interface RemoteReceiptDomain {
  assertCurrent(sql: GraphTransactionSql, intent: DispatchIntent, placement: AcceptedNodePlacement, connection: DeviceConnectionIdentity): Promise<void>
  publishNative(sql: GraphTransactionSql, owner: RunOwnership, evidence: VerifiedRemoteEvidence): Promise<void>
}
async function accepted(sql: GraphTransactionSql, intent: DispatchIntent) {
  const current = await readReconciledDispatchIntent(sql, intent.operationId, true)
  const placement = await readAcceptedPlacement(sql, intent.runId, intent.nodeId)
  if (!current || !placement || !sameWorkflowValue(current, intent) || placement.bindingHash !== intent.bindingHash) {
    throw new DomainError('REMOTE_BINDING_CONFLICT', 'The exact original dispatch and placement are required.', 409)
  }
  return placement
}
function matches(connection: DeviceConnectionIdentity, placement: AcceptedNodePlacement) {
  return placement.hostRef.kind === 'device' && placement.registration !== null && connection.mainId === placement.mainId
    && connection.deviceId === placement.hostRef.deviceId && connection.workerInstallationId === placement.registration.workerInstallationId
    && connection.keyRevision === placement.registration.keyRevision && connection.authorizationRevision === placement.registration.authorizationRevision
}
/** Existing owner invokes BEFORE the first prepare request. Read-only status
 * reconciliation never replaces this original delivery connection. */
export async function reserveRemoteDispatchOrigin(sql: GraphTransactionSql, owner: RunOwnership, intent: DispatchIntent,
  raw: DeviceConnectionIdentity, domain: Pick<RemoteReceiptDomain, 'assertCurrent'>): Promise<void> {
  owner.assertOwned()
  if (owner.runId !== intent.runId) throw new DomainError('REMOTE_RUN_OWNER_CONFLICT', 'Use the original Run owner.', 409)
  const placement = await accepted(sql, intent), connection = DeviceConnectionIdentitySchema.parse(raw)
  if (!matches(connection, placement)) throw new DomainError('REMOTE_CONNECTION_CONFLICT', 'Dispatch connection does not match the accepted registered device.', 409)
  await owner.readOneShotFence(sql)
  await sql.query('insert into remote_dispatch_origins(operation_id,connection) values($1,$2::jsonb) on conflict(operation_id) do nothing', [intent.operationId, JSON.stringify(connection)])
  const verify = async () => {
    owner.assertOwned(); await owner.readOneShotFence(sql)
    await accepted(sql, intent); await domain.assertCurrent(sql, intent, placement, connection)
    const rows = await sql.query<{ connection: unknown }>('select connection from remote_dispatch_origins where operation_id=$1', [intent.operationId])
    // A reconnect of the same Worker boot keeps the original delivery; a restarted boot must reconcile its journal.
    if (rows.rows.length !== 1 || !sameDeviceInstallation(DeviceConnectionIdentitySchema.parse(rows.rows[0]?.connection), connection)) {
      throw new DomainError('REMOTE_ORIGINAL_OPERATION_REQUIRED', 'The original operation cannot be delivered to a replacement connection; reconcile its original journal.', 409)
    }
  }
  await verify(); beforeGraphCommit(sql, verify)
}

/** Concrete B bridge adapter: existing Run owner/G1, durable original connection,
 * reconciled dispatch owner, original native tuple, monotone sequence, bounded
 * denial audit, and receipt+native/edge acceptance on the same transaction. */
export class OwnedRemoteReceiptCommit implements RemoteResultCommitPort {
  constructor(private readonly owner: RunOwnership, private readonly incoming: RemoteOperationReceipt,
    private readonly authenticated: DeviceConnectionIdentity, private readonly domain: RemoteReceiptDomain) {}
  async transaction<T>(operationId: string, work: (transaction: RemoteResultTransaction) => Promise<T>): Promise<T> {
    const incoming = RemoteOperationReceiptSchema.parse(this.incoming)
    if (operationId !== incoming.intent.operationId || this.owner.runId !== incoming.intent.runId) throw new DomainError('REMOTE_RUN_OWNER_CONFLICT', 'Receipt must use the original operation and Run owner.', 409)
    this.owner.assertOwned()
    return this.owner.oneShotConnection().transaction(async sql => {
      let liveIntent: DispatchIntent | undefined, placement: AcceptedNodePlacement | undefined
      let authorityChecked = false
      const assertLive = async () => {
        if (authorityChecked && !isGraphTransactionFinalizing(sql)) return
        if (!liveIntent || !placement) throw new DomainError('REMOTE_BINDING_CONFLICT', 'Remote authority has not been loaded.', 409)
        this.owner.assertOwned(); await this.owner.readOneShotFence(sql)
        if (authorityChecked) {
          const current = await accepted(sql, liveIntent)
          if (!sameWorkflowValue(current, placement)) throw new DomainError(
            'REMOTE_BINDING_CONFLICT', 'Accepted host changed during result acceptance.', 409)
        }
        await this.domain.assertCurrent(sql, liveIntent, placement, this.authenticated)
        authorityChecked = true
      }
      const transaction: RemoteResultTransaction = {
        authority: async id => {
          const intent = await readReconciledDispatchIntent(sql, id, true)
          if (!intent || intent.runId !== this.owner.runId) return null
          const pin = await readAcceptedPlacement(sql, intent.runId, intent.nodeId)
          const origin = (await sql.query<{ connection: unknown }>('select connection from remote_dispatch_origins where operation_id=$1 for share', [id])).rows[0]
          if (!pin || !origin) return null
          const connection = DeviceConnectionIdentitySchema.parse(origin.connection)
          if (!matches(connection, pin)) return null
          const row = (await sql.query<{ receipt: unknown }>('select receipt from remote_execution_receipts where operation_id=$1 for update', [id])).rows[0]
          const previous = row ? RemoteOperationReceiptSchema.parse(row.receipt) : null
          if (previous && (!sameWorkflowValue(previous.connection, connection) || previous.intent.operationId !== id)) throw new DomainError('REMOTE_RECEIPT_CONFLICT', 'Stored worker evidence changed its original identity.', 409)
          liveIntent = intent; placement = pin
          let grantIsLive = true
          try { await assertLive() } catch (error) {
            if (!(error instanceof DomainError) || ![401, 403].includes(error.status)) throw error
            grantIsLive = false
          }
          return { intent, placement: pin, originalConnection: connection,
            originalIncarnationId: previous?.workerIncarnationId ?? incoming.workerIncarnationId,
            grantIsLive, lastSequence: previous?.sequence ?? 0, lastReceipt: previous,
            native: previous?.native ?? null, terminal: previous?.terminal ?? null }
        },
        reject: (receipt, reason) => auditRejectedRemoteReceipt(sql, receipt, reason),
        retain: async evidence => { await assertLive(); await this.domain.publishNative(sql, this.owner, evidence); beforeGraphCommit(sql, assertLive) },
        accept: async evidence => {
          await this.domain.publishNative(sql, this.owner, evidence)
          await persistVerifiedRemoteReceipt(sql, this.owner, evidence, assertLive)
        },
      }
      return work(transaction)
    })
  }
}
