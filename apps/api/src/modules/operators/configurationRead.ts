import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { isAuthorized, requireAuthorization } from '../access/policy.js'
import { DomainError } from '../errors.js'

/** The public default is harness metadata. Other immutable configuration pins
 * are readable only through the caller's owned history or validated active chat binding. */
export async function authorizeOperatorConfigurationRead(database: GraphSqlClient, principal: ManagementPrincipal, configurationVersionId: string): Promise<void> {
  requireAuthorization(principal, 'harnesses:read')
  const current = (await database.query<{ current_configuration_version_id: string }>(
    'select current_configuration_version_id from application_operators where id=$1', ['application-operator'])).rows[0]
  if (current?.current_configuration_version_id === configurationVersionId) return
  if (!isAuthorized(principal, 'operator_chat:read')) {
    // Native chat delegates retain their own identity and narrowed read grant.
    // Only their live, submitted conversation can supply historical pins.
    requireAuthorization(principal, 'operator_handoff:read')
    const bound = await database.query(`select 1 from operator_chat_credentials credential
      join management_principals delegate on delegate.id=credential.principal_id
      join operator_conversations c on c.id=credential.conversation_id
      join management_principals owner on owner.id=c.owner_principal_id
      join operator_conversation_turns active on active.conversation_id=c.id and active.request_id=c.active_request_id
      where delegate.id=$1 and delegate.delegated_from=owner.id
        and delegate.revoked_at is null and delegate.expires_at>now()
        and owner.revoked_at is null and owner.expires_at>now()
        and c.kind='operator' and c.deleted_at is null and c.record->>'status'='open'
        and c.active_phase='submitted' and c.turn_state in ('active','blocked') and not c.cancel_requested
        and c.native_session_id is not null and active.result is null
        and (c.operator_configuration_version_id=$2 or exists(select 1 from operator_conversation_turns t
          where t.conversation_id=c.id and t.operator_configuration_version_id=$2)) limit 1`, [principal.id, configurationVersionId])
    if (bound.rows.length) return
    throw new DomainError('ACCESS_DENIED', 'This Operator configuration is not readable in the caller’s conversation context.', 403)
  }
  const owned = await database.query(`select 1 from operator_conversations c
    where c.kind='operator' and c.owner_principal_id=$1 and c.deleted_at is null
      and (c.operator_configuration_version_id=$2 or exists(select 1 from operator_conversation_turns t
        where t.conversation_id=c.id and t.operator_configuration_version_id=$2)) limit 1`, [principal.id, configurationVersionId])
  if (!owned.rows.length) throw new DomainError('ACCESS_DENIED', 'This Operator configuration is not readable in the caller’s conversation context.', 403)
}
