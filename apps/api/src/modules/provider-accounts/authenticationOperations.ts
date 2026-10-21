import { randomUUID } from 'node:crypto'
import { withTransaction } from '../../infrastructure/transaction.js'
import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import { commandInputHash } from '../commands/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { ProviderAccountAuthenticationOperationSchema, ProviderAccountAuthenticationPrepareInputSchema,
  ProviderAccountAuthenticationCancelInputSchema, ProviderAccountNativeAuthenticationObservationSchema,
  type ProviderAccountAuthenticationOperation, type ProviderAccountNativeAuthenticationObservation,
  type ProviderAccount } from '@foreman-code/contracts/provider-accounts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import type { ProviderAccountsRepository } from './repository.js'
import type { ProviderAccountCredentials } from './ports.js'
import type { ProviderAccountOperationNativePort } from './ports.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { sameDeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'

type Source = 'http' | 'mcp'
type Authorize = (sql: GraphSqlClient, principal: ManagementPrincipal, manage: boolean,
  accountId: string) => Promise<void>

export async function assertAccountUnused(sql: GraphSqlClient, accountId: string): Promise<void> {
  const used = await sql.query(`select 1 from (
    select account_id::text as account_id from provider_account_accepted_bindings where account_id=$1
    union all
    select a.record#>>'{harness,accountId}' from runs r
      join agent_configuration_versions a on a.id in (select jsonb_each_text.value
        from jsonb_each_text(r.record->'agentConfigurationVersionIds'))
      where a.record#>>'{harness,accountId}'=$1::text
    union all
    select a.record#>>'{harness,accountId}' from operator_conversations c
      join agent_configuration_versions a on a.id=c.agent_configuration_version_id
      where a.record#>>'{harness,accountId}'=$1::text and (c.native_session_id is not null
        or exists(select 1 from operator_conversation_turns t where t.conversation_id=c.id))
    union all
    select a.record#>>'{harness,accountId}' from operator_conversations c
      join operator_configuration_versions a on a.id=c.operator_configuration_version_id
      where a.record#>>'{harness,accountId}'=$1::text and (c.native_session_id is not null
        or exists(select 1 from operator_conversation_turns t where t.conversation_id=c.id))
  ) used limit 1`, [accountId])
  if (used.rowCount) throw new DomainError('PROVIDER_ACCOUNT_PRINCIPAL_LOCKED',
    'This account is used by saved work. Credential replacement requires qualified identity equality.', 409)
}

export class ProviderAccountAuthenticationOperations {
  constructor(private readonly pool: pg.Pool, private readonly repository: ProviderAccountsRepository,
    private readonly credentials: ProviderAccountCredentials, private readonly native: ProviderAccountOperationNativePort,
    private readonly commands: PostgresCommandCoordinator, private readonly authorize: Authorize) {}

  async read(id: string, sql: GraphSqlClient = this.pool): Promise<ProviderAccountAuthenticationOperation> {
    const row = (await sql.query<{ record: unknown }>(
      'select record from provider_account_authentication_operations where id=$1', [id])).rows[0]
    if (!row) throw new DomainError('PROVIDER_AUTHENTICATION_NOT_FOUND', 'The sign-in operation is unavailable.', 404)
    return ProviderAccountAuthenticationOperationSchema.parse(row.record)
  }

  private async account(accountId: string): Promise<ProviderAccount> {
    const snapshot = await this.repository.read()
    const account = snapshot.accounts.find(value => value.id === accountId)
    if (!account?.binding) throw new DomainError('PROVIDER_ACCOUNT_NOT_FOUND', 'The account is unavailable.', 404)
    return account
  }

  async prepare(principal: ManagementPrincipal, source: Source, accountId: string, raw: unknown) {
    const input = ProviderAccountAuthenticationPrepareInputSchema.parse(raw)
    const targetKey = await this.repository.key()
    const acceptedTarget = await this.repository.target()
    const payload = { ...input, accountId }
    let generation: number | undefined
    const reserved = await this.commands.execute({ principal, source, operation: 'provider.account.auth.prepare',
      commandId: input.commandId, targetKey, payload,
      replayResult: raw => {
        const operation = ProviderAccountAuthenticationOperationSchema.parse(raw)
        if (!sameDeviceProvisioningTarget(operation.binding.target, acceptedTarget)) {
          throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The original authentication belongs to another installation.', 409)
        }
        return operation
      },
      authorize: sql => this.authorize(sql, principal, true, accountId),
      ...(this.native.authenticationGeneration ? { prepare: async () => {
        const account = await this.account(accountId)
        const paths = account.binding?.profileRef !== accountId
          ? await this.registeredPaths(account) : this.credentials.paths(accountId)
        generation = await this.native.authenticationGeneration!({ account, ...paths })
      } } : {}),
      perform: async sql => {
        const snapshot = await this.repository.lock(sql)
        if (snapshot.revision !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'Provider accounts changed. Refresh before signing in.', 409)
        }
        const account = snapshot.accounts.find(value => value.id === accountId)
        if (!account?.binding || account.removedAt) {
          throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'This account was removed from selection.', 409)
        }
        if (account.legacyProfile) throw new DomainError('PROVIDER_ACCOUNT_PRINCIPAL_UNKNOWN',
          'This original native profile has unproved historical ownership. Its credentials remain unchanged.', 409)
        if (input.intent === 'sign-in' && account.authMode !== 'subscription') {
          throw new DomainError('ACCOUNT_API_KEY_REQUIRED', 'Use the existing local API-key provisioning flow.', 409)
        }
        await assertAccountUnused(sql, accountId)
        await sql.query('select pg_advisory_xact_lock(hashtext($1))', [`provider-auth:${targetKey}:${accountId}`])
        const active = await sql.query('select 1 from provider_account_authentication_operations '
          + 'where account_id=$1 and target_key=$2 and not native_closed', [accountId, targetKey])
        if (active.rowCount) throw new DomainError('PROVIDER_AUTHENTICATION_PENDING',
          'An authentication operation already owns this account. Recheck or cancel that operation.', 409)
        const now = new Date()
        const operation = ProviderAccountAuthenticationOperationSchema.parse({ id: randomUUID(),
          commandId: input.commandId, inputHash: commandInputHash(payload), binding: account.binding,
          intent: input.intent, state: 'reserved', revision: 1,
          generation: generation ?? account.observation?.generation ?? 1, nativeSequence: 0,
          cancelRequested: false, nativeClosed: false, createdAt: now.toISOString(), updatedAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 60 * 60_000).toISOString(), humanActionRequired: input.intent === 'sign-in' })
        await sql.query(`insert into provider_account_authentication_operations
          (id,principal_id,source,account_id,target_key,command_id,input_hash,record,native_closed)
          values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,false)`,
        [operation.id, principal.id, source, accountId, targetKey, input.commandId, operation.inputHash,
          JSON.stringify(operation)])
        if (input.intent === 'sign-in') account.status = 'login-pending'
        await this.repository.write(sql, snapshot, snapshot.revision)
        return operation
      },
    })
    // A reservation receipt never causes a second native dispatch after restart or lost acknowledgement.
    if (reserved.replayed) return { value: await this.status(principal, reserved.value.id, source), replayed: true }
    return { value: await this.dispatch(principal, source, reserved.value, 'prepare'), replayed: false }
  }

  async status(principal: ManagementPrincipal, id: string, source: Source = 'http') {
    const operation = await this.read(id)
    if (!sameDeviceProvisioningTarget(operation.binding.target, await this.repository.target())) {
      throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The operation belongs to another installation.', 409)
    }
    await this.authorize(this.pool, principal, false, operation.binding.accountId)
    if (operation.nativeClosed) return operation
    return this.dispatch(principal, source, operation, 'observe')
  }

  async cancel(principal: ManagementPrincipal, source: Source, raw: unknown) {
    const input = ProviderAccountAuthenticationCancelInputSchema.parse(raw)
    const original = await this.read(input.operationId)
    if (!sameDeviceProvisioningTarget(original.binding.target, await this.repository.target())) {
      throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The original operation belongs to another installation.', 409)
    }
    const result = await this.commands.execute({ principal, source, operation: 'provider.account.auth.cancel',
      commandId: input.commandId, targetKey: original.id, payload: input,
      authorize: sql => this.authorize(sql, principal, true, original.binding.accountId),
      perform: async sql => {
        await sql.query('select id from provider_account_authentication_operations where id=$1 for update', [original.id])
        const current = await this.read(original.id, sql)
        if (current.revision !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'The authentication operation changed. Recheck it first.', 409)
        }
        if (current.nativeClosed) return current
        const next = { ...current, cancelRequested: true, state: 'outcome-unknown' as const,
          humanActionRequired: false, revision: current.revision + 1, updatedAt: new Date().toISOString() }
        await this.write(sql, next)
        await sql.query('update provider_account_authentication_operations set cancel_principal_id=$2 where id=$1',
          [current.id, principal.id])
        return next
      },
    })
    if (result.value.nativeClosed) return result
    return { value: await this.dispatch(principal, source, result.value, result.replayed ? 'observe' : 'cancel'),
      replayed: result.replayed }
  }

  private async dispatch(principal: ManagementPrincipal, source: Source,
    operation: ProviderAccountAuthenticationOperation, action: 'prepare' | 'observe' | 'cancel') {
    const accountId = operation.binding.accountId
    await this.authorize(this.pool, principal, action !== 'observe', accountId)
    const account = await this.account(accountId)
    if (!isDeepStrictEqual(account.binding, operation.binding)) {
      throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The original account binding changed.', 409)
    }
    const paths = account.binding?.profileRef !== accountId
      ? await this.registeredPaths(account) : this.credentials.paths(accountId)
    const input = { account, ...paths, operation }
    let observation: ProviderAccountNativeAuthenticationObservation
    try {
      if (account.authMode === 'api-key' && operation.intent === 'sign-out' && action !== 'cancel') {
        if (action === 'prepare') await this.credentials.clearApiKey(accountId)
        const exists = await this.credentials.apiKey(accountId)
        observation = { operationId: operation.id, binding: operation.binding, generation: operation.generation,
          sequence: operation.nativeSequence + 1, state: exists ? 'outcome-unknown' : 'completed', nativeClosed: !exists }
      } else if (action === 'prepare' && this.native.prepareAuthentication) {
        observation = await this.native.prepareAuthentication(input)
      } else if (action === 'observe' && this.native.observeAuthentication) {
        observation = await this.native.observeAuthentication(input)
      } else if (action === 'cancel' && this.native.cancelAuthentication) {
        observation = await this.native.cancelAuthentication(input)
      } else {
        if (action === 'prepare') {
          if (operation.intent === 'sign-in') await this.native.login(input)
          else await this.native.logout(input)
        } else if (action === 'cancel') await this.native.cancelLogin(accountId)
        observation = { operationId: operation.id, binding: operation.binding, generation: operation.generation,
          sequence: operation.nativeSequence + 1, state: 'outcome-unknown', nativeClosed: false }
      }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      if (error.status === 403) {
        await this.commands.recordDenied(principal.id, source, 'provider.account.auth.dispatch', operation.id)
        error.denialAudited = true
        throw error
      }
      observation = { operationId: operation.id, binding: operation.binding, generation: operation.generation,
        sequence: operation.nativeSequence + 1, state: 'outcome-unknown', nativeClosed: false }
    }
    if (observation.state === 'completed' && observation.nativeClosed && !operation.cancelRequested
      && account.authMode !== 'api-key' && this.native.observeAccount) {
      const observed = await this.native.observeAccount({ account, ...paths })
      if (observed.generation === operation.generation) observation = { ...observation, account: observed }
    }
    return this.publish(principal, source, operation, observation)
  }

  private async registeredPaths(account: ProviderAccount) {
    if (!this.native.resolveProfile) throw new DomainError('PROVIDER_PROFILE_UNAVAILABLE',
      'The original native profile must be resolved on its owning installation.', 409)
    return this.native.resolveProfile(account)
  }

  private async publish(principal: ManagementPrincipal, source: Source,
    original: ProviderAccountAuthenticationOperation, raw: ProviderAccountNativeAuthenticationObservation) {
    const observation = ProviderAccountNativeAuthenticationObservationSchema.parse(raw)
    try {
      return await withTransaction(this.pool, async (sql) => {
        await this.authorize(sql, principal, false, original.binding.accountId)
        const owner = (await sql.query<{ principal_id: string; cancel_principal_id: string | null }>(
          'select principal_id,cancel_principal_id from provider_account_authentication_operations where id=$1 for update',
          [original.id])).rows[0]
        const current = await this.read(original.id, sql)
        if (!owner) throw new DomainError('PROVIDER_AUTHENTICATION_NOT_FOUND', 'The operation is unavailable.', 404)
        const acceptedOwner = await readLiveManagementPrincipal(sql,
          current.cancelRequested ? owner.cancel_principal_id ?? owner.principal_id : owner.principal_id)
        await this.authorize(sql, acceptedOwner, true, original.binding.accountId)
        if (observation.operationId !== current.id || !isDeepStrictEqual(observation.binding, current.binding)
          || observation.generation !== current.generation) {
          throw new DomainError('PROVIDER_AUTHENTICATION_STALE', 'The native result belongs to another operation or generation.', 409)
        }
        if (current.nativeClosed || observation.sequence <= current.nativeSequence) {
          return current
        }
        let state = observation.state
        if (current.cancelRequested) state = observation.nativeClosed ? 'canceled' : 'outcome-unknown'
        else if (current.state === 'expired' || Date.parse(current.expiresAt) <= Date.now()) state = 'expired'
        const next = ProviderAccountAuthenticationOperationSchema.parse({ ...current, state,
          nativeClosed: observation.nativeClosed, nativeSequence: observation.sequence,
          humanActionRequired: state === 'awaiting-human', revision: current.revision + 1,
          updatedAt: new Date().toISOString() })
        await this.write(sql, next)
        if (observation.account && !current.cancelRequested && state !== 'expired') {
          const snapshot = await this.repository.lock(sql)
          const account = snapshot.accounts.find(value => value.id === current.binding.accountId)
          if (!account?.binding || !isDeepStrictEqual(account.binding, current.binding)) {
            throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The observed slot binding changed.', 409)
          }
          const observed = observation.account
          if (observed.bindingRevision !== current.binding.bindingRevision || observed.generation !== current.generation) {
            throw new DomainError('PROVIDER_ACCOUNT_OBSERVATION_STALE', 'The account observation is stale.', 409)
          }
          const previous = account.observation
          const newer = !previous || observed.generation > previous.generation
            || (observed.generation === previous.generation && observed.sequence > previous.sequence)
          if (newer) {
            const changedSubject = account.observation?.subject
              && account.observation.subject.subject !== observed.subject?.subject
            if (changedSubject) {
              await assertAccountUnused(sql, account.id)
            }
            account.observation = observed
            account.status = observed.status
            account.identity = observed.identity
            account.possibleDuplicateAccountIds = observed.subject ? snapshot.accounts.filter(other =>
              other.id !== account.id && other.provider === account.provider
              && other.observation?.subject?.subject === observed.subject!.subject
              && isDeepStrictEqual(other.binding?.target, account.binding!.target)).map(other => other.id) : []
            await this.repository.write(sql, snapshot, snapshot.revision)
          }
        }
        return next
      })
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await this.commands.recordDenied(principal.id, source, 'provider.account.auth.publish', original.id)
        error.denialAudited = true
      }
      throw error
    }
  }

  private async write(sql: GraphSqlClient, operation: ProviderAccountAuthenticationOperation) {
    await sql.query('update provider_account_authentication_operations set record=$2::jsonb,native_closed=$3 where id=$1',
      [operation.id, JSON.stringify(operation), operation.nativeClosed])
  }
}
