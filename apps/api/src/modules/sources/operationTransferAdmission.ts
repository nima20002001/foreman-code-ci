import { isDeepStrictEqual } from 'node:util'
import { withTransaction } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import { TransferIntentSchema, TransferContextSchema, type TransferIntent, type TransferContext } from '@foreman-code/contracts/byte-transfer'
import { SourceRootRecordSchema, type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { SourcePreparationIdentitySchema } from '@foreman-code/contracts/source-operations'
import type { z } from 'zod'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { transferContextForBinding, type AcceptedTransferAuthority } from '../byte-transfer/carrier.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { TransferOperation } from '../byte-transfer/service.js'
import type { MaterializationAttempt } from './ports.js'
import type { PostgresSourceOperationAuthority } from './operationAuthority.js'
type Identity = z.infer<typeof SourcePreparationIdentitySchema>
type Allocation = { root: SourceRootRecord; attempt: MaterializationAttempt; identity: Identity; intent: TransferIntent }
/** Original Main command ledger is reused, never a new worker DB/resource registry. */
export class PostgresSourcePackageTransfers implements AcceptedTransferAuthority {
  constructor(private readonly pool: pg.Pool, private readonly commands: PostgresCommandCoordinator,
    private readonly owners: PostgresSourceOperationAuthority, private readonly endpoint: () => DeviceEndpoint) {}
  private binding(root: SourceRootRecord) {
    const registration = root.registration, binding = this.endpoint().currentBinding(root.binding.deviceId!)
    if (!binding || !registration || binding.mainId !== root.binding.mainId || binding.deviceId !== root.binding.deviceId
      || binding.workerInstallationId !== registration.workerInstallationId || binding.keyRevision !== registration.keyRevision
      || binding.authorizationRevision !== registration.authorizationRevision) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source package transfer is not on its actual accepted current device.', 409)
    return binding
  }
  async revalidate(root: SourceRootRecord, attempt: MaterializationAttempt, identity: Identity) {
    await withTransaction(this.pool, async (sql) => { await this.owners.authorizePreparation(sql, root, attempt, identity); this.binding(root) })
  }
  private async allocation(id: string): Promise<Allocation> {
    const row = (await this.pool.query<{ result: unknown }>(`select result from management_command_receipts where operation='source.package.admit' and result->'intent'->>'transferId'=$1`, [id])).rows
    if (row.length !== 1) throw new DomainError('SOURCE_TRANSFER_UNKNOWN', 'The source transfer was not admitted by the original Main owner.', 409)
    const value = row[0]!.result as Allocation
    return { ...value, root: SourceRootRecordSchema.parse(value.root), identity: SourcePreparationIdentitySchema.parse(value.identity), intent: TransferIntentSchema.parse(value.intent) }
  }
  async intent(id: string, binding: Readonly<DeviceSessionBinding>): Promise<TransferIntent> {
    const allocation = await this.allocation(id)
    await this.authorize(allocation.intent, transferContextForBinding(binding), 'start'); return allocation.intent
  }
  async authorize(intent: TransferIntent, raw: TransferContext, operation: TransferOperation): Promise<void> {
    void operation
    const context = TransferContextSchema.parse(raw), allocation = await this.allocation(intent.transferId)
    if (!isDeepStrictEqual(allocation.intent, intent)) throw new DomainError('SOURCE_TRANSFER_CONFLICT', 'Source transfer identity changed under the original request.', 409)
    await this.revalidate(allocation.root, allocation.attempt, allocation.identity)
    const current = transferContextForBinding(this.binding(allocation.root))
    if (!isDeepStrictEqual(current, context)) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source transfer must use the actual current authenticated epoch/boot.', 409)
  }
}
