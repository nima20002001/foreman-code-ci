import type { SqlQuery } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'

type TransferOwner = 'source.package.admit' | 'job.output.admit' | 'job.inputs.bind'

/** Resolves the admission owner before its source or Job authority checks the transfer. */
export async function requireRsyncTransferOwner(sql: SqlQuery, transferId: string): Promise<TransferOwner> {
  const owners = (await sql.query<{ operation: TransferOwner }>(`select operation from management_command_receipts
    where operation in ('source.package.admit','job.output.admit') and result->'intent'->>'transferId'=$1
    union all
    select operation from management_command_receipts
    where operation='job.inputs.bind' and result->'transfers' @> $2::jsonb`,
  [transferId, JSON.stringify([{ intent: { transferId } }])])).rows
  if (owners.length !== 1) {
    throw new DomainError('RSYNC_TRANSFER_DENIED', 'Exactly one original source or Job admission must own the transfer.', 403)
  }
  return owners[0]!.operation
}
