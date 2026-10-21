import { productionMaintenanceKey } from '@foreman-code/contracts/production-maintenance'
import type { TransactionSql } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'

export async function requireRunStartAvailable(sql: TransactionSql): Promise<void> {
  const result = await sql.query<{ available: boolean }>(
    'select pg_try_advisory_xact_lock_shared(hashtext($1), hashtext(current_schema())) as available',
    [productionMaintenanceKey],
  )
  if (result.rows[0]?.available !== true) {
    throw new DomainError('RUN_START_MAINTENANCE',
      'An installation is in progress. Retry the same Start command after it finishes.', 503)
  }
}
