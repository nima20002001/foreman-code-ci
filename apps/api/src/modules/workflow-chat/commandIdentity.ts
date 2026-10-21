import type { TransactionSql } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'

/** All chat operations use one actor command namespace, even when their response lives in a different table. */
export async function assertChatCommandKind(tx: TransactionSql, principalId: string, commandId: string,
  kind: 'post' | 'delivery' | 'control'): Promise<void> {
  const other = await tx.query(`select 1 from (
    select 'post' as kind from workflow_chat_posts where principal_id=$1 and command_id=$2
    union all select 'delivery' from chat_delivery_commands where principal_id=$1 and command_id=$2
    union all select 'control' from chat_control_commands where principal_id=$1 and command_id=$2
  ) commands where kind<>$3 limit 1`, [principalId, commandId, kind])
  if (other.rowCount) throw new DomainError('CHAT_COMMAND_CONFLICT', 'This command already identifies another chat operation.', 409)
}
