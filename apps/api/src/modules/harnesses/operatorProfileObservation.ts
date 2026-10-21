import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { OperatorConfigurationVersionSchema, type NativeSessionReference } from '@foreman-code/contracts'
import { nativeCorrelation } from '../conversations/operatorChatRepository.js'
import { DomainError } from '../errors.js'
import type { AcceptedProfileSelector } from './instanceSettings/acceptedProfile.js'
import type { OperatorNativeSessionStart } from './port.js'

export interface OperatorProfileObservation {
  kind: 'operator-observation'
  conversationId: string
  session: NativeSessionReference
  start: OperatorNativeSessionStart
}

/** Saved work authorizes observation and cancellation, including after owner revocation. */
export async function authorizeOperatorProfileObservation(client: pg.PoolClient,
  binding: OperatorProfileObservation, selector: AcceptedProfileSelector): Promise<void> {
  const row = (await client.query<{
    owner_principal_id: string | null
    active_request_id: string
    native_session_id: string
    provider_version: string
    harness: string
    active_native_turn_id: string | null
    accepted_configuration_id: string | null
    record: unknown
  }>(`select c.owner_principal_id,c.active_request_id,c.native_session_id,c.provider_version,c.harness,
      c.active_native_turn_id,coalesce(t.operator_configuration_version_id,
        t.payload->>'acceptedConfigurationVersionId') as accepted_configuration_id,v.record
    from operator_conversations c
    join operator_conversation_turns t on t.conversation_id=c.id and t.request_id=c.active_request_id
    join operator_configuration_versions v on v.id=c.operator_configuration_version_id
    where c.id=$1 and c.kind='operator'`, [binding.conversationId])).rows[0]
  const configuration = row ? OperatorConfigurationVersionSchema.parse(row.record) : undefined
  if (!row?.owner_principal_id || !configuration
    || row.accepted_configuration_id !== configuration.id
    || !isDeepStrictEqual(configuration, binding.start.configuration)
    || !isDeepStrictEqual(configuration.harnessProfileSelection, selector)
    || row.harness !== binding.session.harness || row.provider_version !== binding.session.providerVersion
    || row.native_session_id !== binding.session.nativeSessionId
    || row.active_native_turn_id !== (binding.start.nativeTurnId ?? null)
    || binding.start.correlationId !== nativeCorrelation(binding.conversationId, row.active_request_id)
    || Object.keys(binding.start.environment?.variables ?? {}).length) {
    throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The saved Operator session binding changed.', 409)
  }
}
