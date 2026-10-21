import type { z } from 'zod'
import { withTransaction } from '../../infrastructure/transaction.js'
import { createHash, randomUUID } from 'node:crypto'
import type pg from 'pg'
import {
  ProviderAccountApiKeyInputSchema, ProviderAccountCommandInputSchema,
  ProviderAccountCreateInputSchema, ProviderAccountIdSchema, ProviderAccountRenameInputSchema,
  type AccountProvider, type ProviderAccount,
  ProviderAccountsSnapshotSchema, type ProviderAccountsSnapshot,
  type AcceptedProviderAccountBinding, type ProviderAccountBinding, type ProviderAccountAuthenticationOperation,
  type ProviderAccountObservation, type ProviderAccountModels,
  type ProviderAccountTarget, type ProviderAccountHumanHandoff,
} from '@foreman-code/contracts/provider-accounts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { hasAction, requireAuthorization, requireLiveAccountAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { ProviderAccountsRepository } from './repository.js'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { sameDeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { isDeepStrictEqual } from 'node:util'
import { ProviderAccountListInputSchema, ProviderAccountPageSchema, ProviderAccountGetInputSchema,
  ProviderAccountRegisterInputSchema, ProviderAccountDefaultInputSchema, ProviderAccountBindingSchema,
  ProviderAccountObservationSchema, ProviderAccountModelsSchema,
  ProviderAccountAuthenticationReadInputSchema, ProviderAccountAuthenticationPrepareInputSchema,
  ProviderAccountAuthenticationCancelInputSchema } from '@foreman-code/contracts/provider-accounts'
import { ProviderAccountDiscoveryInputSchema, ProviderAccountProfilesSchema, ProviderAccountTargetsSchema,
  ProviderAccountEligibilitySchema, ProviderAccountAuthenticationListInputSchema,
  ProviderAccountAuthenticationPageSchema, ProviderAccountAuthenticationOperationSchema,
  ProviderAccountHumanHandoffSchema } from '@foreman-code/contracts/provider-accounts'
import { assertAccountUnused, ProviderAccountAuthenticationOperations } from './authenticationOperations.js'
import { AcceptedProviderAccountBindings } from './acceptedBindings.js'
import type { ResolvedProviderAccount, ProviderAccountResolver, ProviderAccountOperationNativePort, ProviderAccountCredentials } from './ports.js'
import { legacyProviderAccountBinding, readProviderAccountBinding, type AccountBindingOwner } from './acceptedBindings.js'
import type { HarnessConfiguration } from '@foreman-code/contracts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'

export type { ResolvedProviderAccount, ProviderAccountResolver, ProviderAccountOperationNativePort, ProviderAccountCredentials }
type CommandSource = 'http' | 'mcp'
type Change = (snapshot: ProviderAccountsSnapshot, sql: GraphSqlClient) => Promise<void>

export class ProviderAccountsService implements ProviderAccountResolver {
  private routing?: {
    scope(principal: ManagementPrincipal, target: DeviceProvisioningTarget): Promise<ProviderAccountsService>
    targets(principal: ManagementPrincipal): Promise<ProviderAccountTarget[]>
    locate?(accountId: string, sql?: GraphSqlClient): Promise<ProviderAccountBinding | undefined>
    resolve?(binding: ProviderAccountBinding, sql?: GraphSqlClient, signal?: AbortSignal): Promise<ResolvedProviderAccount | null>
  }
  bindRouting(routing: NonNullable<ProviderAccountsService['routing']>): void { this.routing = routing }

  private async remote(principal: ManagementPrincipal, target?: DeviceProvisioningTarget) {
    if (!target || sameDeviceProvisioningTarget(target, await this.repository.target())) return undefined
    if (!this.routing) await this.checkTarget(target)
    return this.routing!.scope(principal, target)
  }

  readonly acceptedBindings = new AcceptedProviderAccountBindings(this)
  private readonly authentication: ProviderAccountAuthenticationOperations
  constructor(
    private readonly pool: pg.Pool,
    private readonly repository: ProviderAccountsRepository,
    private readonly credentials: ProviderAccountCredentials,
    private readonly native: ProviderAccountOperationNativePort,
    private readonly commands: PostgresCommandCoordinator,
    private readonly targetAuthorization?: (sql: GraphSqlClient, principal: ManagementPrincipal, manage: boolean,
      accountId?: string) => Promise<void>,
  ) {
    this.authentication = new ProviderAccountAuthenticationOperations(pool, repository, credentials, native, commands,
      (sql, principal, manage, accountId) => this.authorize(sql, principal,
        manage ? 'provider_accounts:manage' : 'provider_accounts:read', accountId))
  }

  bindTarget(reader: (sql: GraphSqlClient) => Promise<DeviceProvisioningTarget>): void { this.repository.bindTarget(reader) }

  async runtimeBinding(kind: AccountBindingOwner, id: string, configuration: HarnessConfiguration,
    selection?: HarnessProfileSelection): Promise<AcceptedProviderAccountBinding | undefined> {
    return await readProviderAccountBinding(this.pool, kind, id)
      ?? legacyProviderAccountBinding(configuration, selection)
  }

  async assertAuthenticationEligibility(operation: ProviderAccountAuthenticationOperation): Promise<void> {
    const row = (await this.pool.query<{ principal_id: string; record: unknown }>(
      'select principal_id,record from provider_account_authentication_operations where id=$1', [operation.id])).rows[0]
    if (!row) throw new DomainError('PROVIDER_AUTHENTICATION_NOT_FOUND', 'The accepted operation is unavailable.', 404)
    const stored = ProviderAccountAuthenticationOperationSchema.parse(row.record)
    if (!isDeepStrictEqual(stored.binding, operation.binding) || stored.inputHash !== operation.inputHash
      || stored.commandId !== operation.commandId || stored.generation !== operation.generation
      || stored.intent !== operation.intent || stored.createdAt !== operation.createdAt
      || stored.expiresAt !== operation.expiresAt) {
      throw new DomainError('PROVIDER_AUTHENTICATION_STALE', 'The accepted operation identity changed.', 409)
    }
    if (stored.nativeClosed || stored.cancelRequested || Date.parse(stored.expiresAt) <= Date.now()) {
      throw new DomainError('PROVIDER_AUTHENTICATION_CLOSED', 'The original operation no longer permits authentication.', 409)
    }
    const principal = await readLiveManagementPrincipal(this.pool, row.principal_id)
    const remote = await this.remote(principal, stored.binding.target)
    if (remote) return remote.assertAuthenticationEligibility(operation)
    await this.authorize(this.pool, principal, 'provider_accounts:manage', operation.binding.accountId)
    const account = this.account(await this.repository.read(), operation.binding.accountId)
    if (account.removedAt) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'This account was removed from selection.', 409)
    await assertAccountUnused(this.pool, operation.binding.accountId)
  }

  private async authorize(sql: GraphSqlClient, principal: ManagementPrincipal,
    action: 'provider_accounts:read' | 'provider_accounts:manage' = 'provider_accounts:read',
    accountId?: string): Promise<void> {
    if (this.targetAuthorization) return this.targetAuthorization(sql, principal, action === 'provider_accounts:manage', accountId)
    const target = await this.repository.target(sql)
    const resource = { mainId: target.hostRef.mainId,
      applicationInstallationId: target.applicationInstallationId,
      ...(target.hostRef.kind === 'device' ? { deviceId: target.hostRef.deviceId } : {}),
      ...(accountId ? { providerAccountId: accountId } : {}) }
    requireAuthorization(principal, 'provider_accounts:read', resource)
    const current = await readLiveManagementPrincipal(sql, principal.id)
    requireAuthorization(current, 'provider_accounts:read', resource)
    requireAuthorization(current, action, resource)
    await requireLiveAccountAuthorization(sql, principal.id, action, resource)
  }

  private async checkTarget(target?: DeviceProvisioningTarget): Promise<void> {
    if (target && !sameDeviceProvisioningTarget(target, await this.repository.target())) {
      throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The account belongs to another computer or installation.', 409)
    }
  }

  private async authorizeMutation(principal: ManagementPrincipal, source: CommandSource, operation: string,
    accountId?: string, target?: DeviceProvisioningTarget): Promise<void> {
    try {
      await this.checkTarget(target)
      await this.authorize(this.pool, principal, 'provider_accounts:manage', accountId)
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await this.commands.recordDenied(principal.id, source, operation, await this.repository.key())
        error.denialAudited = true
      }
      throw error
    }
  }

  async auditDenied(principal: ManagementPrincipal, source: CommandSource, operation: string,
    accountId: string, error: DomainError) {
    if (error.denialAudited) return
    await this.commands.recordDenied(principal.id, source, operation, `provider-account:${accountId}`)
    error.denialAudited = true
  }

  async list(principal: ManagementPrincipal): Promise<ProviderAccountsSnapshot> {
    await this.authorize(this.pool, principal)
    const snapshot = await this.repository.read()
    for (const account of snapshot.accounts) {
      if (!account.removedAt) await this.observe(principal, account)
    }
    await this.authorize(this.pool, principal)
    return snapshot
  }

  async page(principal: ManagementPrincipal, raw: unknown) : Promise<z.infer<typeof ProviderAccountPageSchema>> {
    const input = ProviderAccountListInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.page(principal, raw)
    await this.checkTarget(input.target)
    await this.authorize(this.pool, principal)
    const snapshot = await this.repository.read()
    const accounts = snapshot.accounts.filter(account => (input.includeRemoved || !account.removedAt)
      && (!input.provider || account.provider === input.provider)).sort((a, b) => a.id.localeCompare(b.id))
    const filtered = input.cursor ? accounts.filter(account => account.id > input.cursor!) : accounts
    const selected = filtered.slice(0, input.limit)
    for (const account of selected) if (!account.removedAt) await this.observe(principal, account)
    await this.authorize(this.pool, principal)
    return ProviderAccountPageSchema.parse({ target: await this.repository.target(), revision: snapshot.revision, accounts: selected,
      defaults: snapshot.defaults, nextCursor: filtered.length > input.limit ? selected.at(-1)!.id : null })
  }

  async get(principal: ManagementPrincipal, raw: unknown): Promise<ProviderAccount> {
    const input = ProviderAccountGetInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.get(principal, raw)
    await this.checkTarget(input.target)
    await this.authorize(this.pool, principal, 'provider_accounts:read', input.accountId)
    const account = this.account(await this.repository.read(), input.accountId)
    if (!account.removedAt) await this.observe(principal, account)
    await this.authorize(this.pool, principal, 'provider_accounts:read', input.accountId)
    return account
  }

  private async observe(principal: ManagementPrincipal, account: ProviderAccount): Promise<void> {
    await this.authorize(this.pool, principal, 'provider_accounts:read', account.id)
    const pending = await this.pool.query('select 1 from provider_account_authentication_operations '
      + "where account_id=$1 and target_key=$2 and not native_closed and record->>'intent'='sign-in' limit 1",
    [account.id, await this.repository.key()])
    if (pending.rowCount) {
      // A committed sign-in reservation owns status until native closure is reconciled.
      account.status = 'login-pending'
      account.identity = null
      return
    }
    if (!this.native.observeAccount) {
      Object.assign(account, await this.status(account))
      return
    }
    let observation: ProviderAccountObservation
    try {
      observation = ProviderAccountObservationSchema.parse(await this.native.observeAccount({
        account, ...await this.profilePaths(account),
      }))
    } catch (error) {
      if (!(error instanceof DomainError) || error.status === 403) throw error
      // Failed observations cannot prove the currently signed-in principal.
      account.status = 'unavailable'
      account.identity = null
      account.observation = { bindingRevision: account.binding!.bindingRevision,
        generation: account.observation?.generation ?? 1,
        sequence: Math.max(Date.now(), (account.observation?.sequence ?? 0) + 1), observedAt: new Date().toISOString(),
        status: 'unavailable', identity: null, subject: null,
        readiness: error.code === 'PROVIDER_ACCOUNT_UNQUALIFIED' ? 'qualification-required' : 'unavailable' }
      return
    }
    await this.authorize(this.pool, principal, 'provider_accounts:read', account.id)
    return withTransaction(this.pool, async (sql) => {
      await this.authorize(sql, principal, 'provider_accounts:read', account.id)
      const snapshot = await this.repository.lock(sql)
      const current = this.account(snapshot, account.id)
      if (current.removedAt || !isDeepStrictEqual(current.binding, account.binding)
        || observation.bindingRevision !== account.binding?.bindingRevision) {
        throw new DomainError('PROVIDER_ACCOUNT_OBSERVATION_STALE', 'The account changed during observation.', 409)
      }
      if (current.observation?.subject && current.observation.subject.subject !== observation.subject?.subject) {
        try { await assertAccountUnused(sql, account.id) } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'PROVIDER_ACCOUNT_PRINCIPAL_LOCKED') throw error
          Object.assign(account, { status: 'unavailable', identity: null,
            observation: { ...observation, status: 'unavailable', subject: null, identity: null, readiness: 'unavailable' } })
          return
        }
      }
      const saved = await this.repository.observe(sql, account.id, observation)
      Object.assign(account, { observation: saved, status: saved.status, identity: saved.identity })
    })
  }

  async targets(principal: ManagementPrincipal): Promise<z.infer<typeof ProviderAccountTargetsSchema>> {
    if (!hasAction(await readLiveManagementPrincipal(this.pool, principal.id), 'provider_accounts:read')) {
      throw new DomainError('ACCESS_DENIED', 'The caller cannot read account targets.', 403)
    }
    if (this.routing) return ProviderAccountTargetsSchema.parse({ targets: await this.routing.targets(principal) })
    return ProviderAccountTargetsSchema.parse({ targets: [await this.localTargetCapabilities(principal)] })
  }

  async localTargetCapabilities(principal: ManagementPrincipal): Promise<ProviderAccountTarget> {
    const target = await this.repository.target()
    await this.authorize(this.pool, principal)
    const discovered = await this.native.discover?.(target)
    let canManage = true
    try { await this.authorize(this.pool, principal, 'provider_accounts:manage') } catch (error) {
      if (!(error instanceof DomainError) || error.status !== 403) throw error
      canManage = false
    }
    await this.authorize(this.pool, principal)
    return { target, label: target.hostRef.kind === 'main' ? 'Main' : 'Worker', connected: true,
      generation: discovered?.generation ?? 1, canRead: true, canManage,
      providers: discovered?.providers ?? (['codex', 'claude'] as const).map(provider => ({ provider,
        qualified: false, actions: [], reason: 'Account isolation qualification is unavailable.' })) }
  }

  async profiles(principal: ManagementPrincipal, raw: unknown): Promise<z.infer<typeof ProviderAccountProfilesSchema>> {
    const input = ProviderAccountDiscoveryInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.profiles(principal, raw)
    await this.authorize(this.pool, principal)
    const target = await this.repository.target()
    const value = await this.native.discover?.(target, input.provider)
    await this.authorize(this.pool, principal)
    return ProviderAccountProfilesSchema.parse({ target, profiles: value?.profiles ?? [] })
  }

  async eligibility(principal: ManagementPrincipal, raw: unknown): Promise<z.infer<typeof ProviderAccountEligibilitySchema>> {
    const input = ProviderAccountGetInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.eligibility(principal, raw)
    await this.authorize(this.pool, principal, 'provider_accounts:read', input.accountId)
    const account = this.account(await this.repository.read(), input.accountId)
    let canManage = true
    let canReauthenticate = true
    let reason: string | null = null
    try {
      await this.authorize(this.pool, principal, 'provider_accounts:manage', account.id)
    } catch (error) {
      if (!(error instanceof DomainError) || error.status !== 403) throw error
      canManage = false
      canReauthenticate = false
      reason = 'You have read access to this account.'
    }
    if (canManage) {
      try {
        if (account.removedAt || account.legacyProfile) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE',
          'This account is removed or has unproved historical ownership.', 409)
        if (account.authMode === 'api-key') throw new DomainError('ACCOUNT_API_KEY_REQUIRED',
          'Use the existing local API-key provisioning flow for this account.', 409)
        await assertAccountUnused(this.pool, account.id)
        const discovery = await this.native.discover?.(account.binding!.target, account.provider)
        if (discovery && !discovery.providers.some(value => value.provider === account.provider && value.actions.includes('sign-in'))) {
          throw new DomainError('PROVIDER_ACCOUNT_UNQUALIFIED', 'This installation has no qualified sign-in operation.', 409)
        }
        const pending = await this.pool.query('select 1 from provider_account_authentication_operations '
          + 'where account_id=$1 and not native_closed', [account.id])
        if (pending.rowCount) throw new DomainError('PROVIDER_AUTHENTICATION_PENDING',
          'Recheck or cancel the original authentication operation.', 409)
      } catch (error) {
        if (!(error instanceof DomainError)) throw error
        canReauthenticate = false
        reason = error.message
      }
    }
    await this.authorize(this.pool, principal, 'provider_accounts:read', account.id)
    if (canManage) {
      try { await this.authorize(this.pool, principal, 'provider_accounts:manage', account.id) } catch (error) {
        if (!(error instanceof DomainError) || error.status !== 403) throw error
        canManage = false
        canReauthenticate = false
        reason = 'You have read access to this account.'
      }
    }
    return ProviderAccountEligibilitySchema.parse({ accountId: account.id, target: account.binding!.target,
      canManage, canReauthenticate, reason })
  }

  async authenticationList(principal: ManagementPrincipal, raw: unknown):
    Promise<z.infer<typeof ProviderAccountAuthenticationPageSchema>> {
    const input = ProviderAccountAuthenticationListInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.authenticationList(principal, raw)
    await this.authorize(this.pool, principal, 'provider_accounts:read', input.accountId)
    this.account(await this.repository.read(), input.accountId)
    const rows = await this.pool.query<{ record: unknown }>(
      'select record from provider_account_authentication_operations where account_id=$1 and target_key=$2 '
      + 'and ($3::uuid is null or id>$3::uuid) order by id limit $4',
      [input.accountId, await this.repository.key(), input.cursor ?? null, input.limit + 1])
    const active = await this.pool.query<{ record: unknown }>(
      'select record from provider_account_authentication_operations where account_id=$1 and target_key=$2 and not native_closed',
      [input.accountId, await this.repository.key()])
    const currentOperation = active.rows[0] ? ProviderAccountAuthenticationOperationSchema.parse(active.rows[0].record) : null
    const operations = rows.rows.slice(0, input.limit).map(row => ProviderAccountAuthenticationOperationSchema.parse(row.record))
    await this.authorize(this.pool, principal, 'provider_accounts:read', input.accountId)
    return ProviderAccountAuthenticationPageSchema.parse({ target: await this.repository.target(), accountId: input.accountId,
      currentOperation, operations, nextCursor: rows.rows.length > input.limit ? operations.at(-1)!.id : null })
  }

  async humanHandoff(principal: ManagementPrincipal, raw: unknown): Promise<ProviderAccountHumanHandoff> {
    const input = ProviderAccountAuthenticationReadInputSchema.parse(raw)
    await this.checkTarget(input.target)
    const operation = await this.authentication.read(input.operationId)
    await this.authorizeMutation(principal, 'http', 'provider.account.auth.handoff', operation.binding.accountId, operation.binding.target)
    if (operation.binding.target.hostRef.kind !== 'main' || operation.nativeClosed || operation.cancelRequested
      || Date.parse(operation.expiresAt) <= Date.now() || !operation.humanActionRequired || !this.native.humanHandoff) {
      throw new DomainError('PROVIDER_HANDOFF_UNAVAILABLE', 'The original native handoff is unavailable on this computer.', 409)
    }
    const account = this.account(await this.repository.read(), operation.binding.accountId)
    const result = ProviderAccountHumanHandoffSchema.parse(await this.native.humanHandoff({
      account, ...await this.profilePaths(account), operation,
    }))
    await this.authorize(this.pool, principal, 'provider_accounts:manage', account.id)
    const current = await this.authentication.read(operation.id)
    if (result.operationId !== current.id || result.expiresAt !== current.expiresAt
      || !current.humanActionRequired || current.nativeClosed || current.cancelRequested
      || Date.parse(current.expiresAt) <= Date.now()) throw new DomainError('PROVIDER_HANDOFF_UNAVAILABLE',
      'The original human authentication operation is no longer pending.', 409)
    return result
  }

  private async status(account: ProviderAccount): Promise<Pick<ProviderAccount, 'status' | 'identity'>> {
    try {
      const paths = await this.profilePaths(account)
      if (account.authMode === 'api-key') {
        const apiKey = await this.credentials.apiKey(account.id)
        return { status: apiKey ? 'signed-in' : 'signed-out', identity: null }
      }
      const state = await this.native.status({ account, ...paths })
      return { status: state.status, identity: state.identity }
    } catch (error) {
      if (!(error instanceof DomainError)) throw error
      return { status: 'unavailable', identity: null }
    }
  }

  private async profilePaths(account: ProviderAccount) {
    if (account.binding?.profileRef !== account.id) {
      if (!this.native.resolveProfile) throw new DomainError('PROVIDER_PROFILE_UNAVAILABLE',
        'The owning native installation must resolve this registered profile.', 409)
      return this.native.resolveProfile(account)
    }
    await this.credentials.assertAvailable(account.id)
    return this.credentials.paths(account.id)
  }

  private account(snapshot: ProviderAccountsSnapshot, accountId: string): ProviderAccount {
    ProviderAccountIdSchema.parse(accountId)
    const account = snapshot.accounts.find(value => value.id === accountId)
    if (!account) throw new DomainError('PROVIDER_ACCOUNT_NOT_FOUND', 'The account is unavailable on this computer.', 404)
    return account
  }

  private async provision(principal: ManagementPrincipal, source: CommandSource, operation: string,
    account: ProviderAccount | undefined): Promise<void> {
    if (!account || !this.native.provisionAccount) return
    try {
      await this.authorize(this.pool, principal, 'provider_accounts:manage', account.id)
      const current = this.account(await this.repository.read(), account.id)
      await this.native.provisionAccount(current)
      await this.authorize(this.pool, principal, 'provider_accounts:manage', account.id)
    } catch (error) {
      if (error instanceof DomainError && error.status === 403) {
        await this.auditDenied(principal, source, operation, account.id, error)
      }
      throw error
    }
  }

  private async change(principal: ManagementPrincipal, source: CommandSource, operation: string,
    input: { commandId: string; expectedRevision: number; target?: DeviceProvisioningTarget | undefined;
      expectedDefaultRevision?: number | undefined; expectedLabelRevision?: number | undefined },
    payload: unknown, change: Change,
    options: { afterRollback?: () => Promise<void>; prepare?: () => Promise<void> } = {}) {
    const targetKey = await this.repository.key()
    const acceptedTarget = await this.repository.target()
    const accountId = (payload as { accountId?: string }).accountId
    await this.authorizeMutation(principal, source, operation, accountId, input.target)
    return this.commands.execute({
      principal, source, operation, commandId: input.commandId, targetKey, payload,
      resourceLock: `provider-account-credentials:${targetKey}`,
      replayResult: raw => {
        const snapshot = ProviderAccountsSnapshotSchema.parse(raw)
        if (snapshot.accounts.some(account => account.binding
          && !sameDeviceProvisioningTarget(account.binding.target, acceptedTarget))) {
          throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The original command belongs to another installation.', 409)
        }
        return snapshot
      },
      authorize: sql => this.authorize(sql, principal, 'provider_accounts:manage', accountId),
      perform: async sql => {
        const snapshot = await this.repository.lock(sql)
        if (input.expectedDefaultRevision === undefined && input.expectedLabelRevision === undefined
          && snapshot.revision !== input.expectedRevision) {
          throw new DomainError('REVISION_CONFLICT', 'Provider accounts changed. Refresh before saving.', 409)
        }
        await change(snapshot, sql)
        await this.authorize(sql, principal, 'provider_accounts:manage', accountId)
        return this.repository.write(sql, snapshot, snapshot.revision)
      },
      ...(options.afterRollback ? { afterRollback: options.afterRollback } : {}),
      ...(options.prepare ? { prepare: options.prepare } : {}),
    }).catch(async (error: unknown) => {
      if (error instanceof DomainError && error.status === 403) {
        await this.commands.recordDenied(principal.id, source, operation, targetKey)
      }
      throw error
    })
  }

  async create(principal: ManagementPrincipal, source: CommandSource, raw: unknown) : Promise<{ value: ProviderAccountsSnapshot; replayed: boolean }> {
    const input = ProviderAccountCreateInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.create(principal, source, raw)
    let createdId: string | undefined
    const result = await this.change(principal, source, 'provider.account.create', input, input, async (snapshot, sql) => {
      if (snapshot.accounts.length >= 100) throw new DomainError('ACCOUNT_LIMIT', 'The account limit has been reached.', 409)
      const account: ProviderAccount = { id: randomUUID(), provider: input.provider, name: input.name,
        authMode: input.authMode, isDefault: !snapshot.accounts.some(value => value.provider === input.provider),
        status: 'unavailable', identity: null, revision: 1 }
      account.binding = ProviderAccountBindingSchema.parse({ kind: 'slot', accountId: account.id,
        provider: account.provider, target: await this.repository.target(sql), profileRef: account.id,
        bindingRevision: 1, subject: null })
      account.removedAt = null
      await this.credentials.create(account)
      createdId = account.id
      snapshot.accounts.push(account)
      if (account.isDefault) {
        const scoped = snapshot.defaults!.find(value => value.provider === account.provider)!
        scoped.accountId = account.id
        scoped.revision += 1
      }
    }, { afterRollback: async () => {
      if (createdId) await this.credentials.removeCreatedHome(createdId)
    } })
    if (this.native.provisionAccount) {
      const account = result.value.accounts.find(value => value.id === createdId)
        ?? result.value.accounts.at(-1)
      await this.provision(principal, source, 'provider.account.create', account)
    }
    return result
  }

  async rename(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) : Promise<{ value: ProviderAccountsSnapshot; replayed: boolean }> {
    const input = ProviderAccountRenameInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.rename(principal, source, accountId, raw)
    return this.change(principal, source, 'provider.account.rename', input, { ...input, accountId }, async snapshot => {
      const account = this.account(snapshot, accountId)
      if (input.expectedLabelRevision !== undefined && account.revision !== input.expectedLabelRevision) {
        throw new DomainError('REVISION_CONFLICT', 'The account label changed. Refresh before saving.', 409)
      }
      account.name = input.name
      account.revision += 1
    })
  }

  async setDefault(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) : Promise<{ value: ProviderAccountsSnapshot; replayed: boolean }> {
    const input = ProviderAccountDefaultInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.setDefault(principal, source, accountId, raw)
    return this.change(principal, source, 'provider.account.default.set', input, { ...input, accountId }, async snapshot => {
      const selected = this.account(snapshot, accountId)
      if (selected.removedAt) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'This account was removed from selection.', 409)
      const scoped = snapshot.defaults!.find(value => value.provider === selected.provider)!
      if (input.expectedDefaultRevision !== undefined && scoped.revision !== input.expectedDefaultRevision) {
        throw new DomainError('REVISION_CONFLICT', 'The scoped default changed. Refresh before saving.', 409)
      }
      scoped.accountId = accountId
      scoped.revision += 1
      if (!this.native.provisionAccount) await this.credentials.assertAvailable(accountId)
      for (const account of snapshot.accounts.filter(value => value.provider === selected.provider)) {
        if (account.isDefault === (account.id === accountId)) continue
        account.isDefault = account.id === accountId
      }
    })
  }

  async refresh(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) : Promise<{ value: ProviderAccountsSnapshot; replayed: boolean }> {
    const input = ProviderAccountCommandInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.refresh(principal, source, accountId, raw)
    await this.authorizeMutation(principal, source, 'provider.account.refresh', accountId, input.target)
    const active = await this.pool.query<{ id: string }>('select id from provider_account_authentication_operations '
      + 'where account_id=$1 and not native_closed', [accountId])
    if (active.rows[0]) await this.authentication.status(principal, active.rows[0].id, source)
    const before = this.account(await this.repository.read(), accountId)
    const observed = await this.status(before)
    const observation = this.native.observeAccount
      ? ProviderAccountObservationSchema.parse(await this.native.observeAccount({
        account: before, ...await this.profilePaths(before),
      })) : undefined
    return this.change(principal, source, 'provider.account.refresh', input, { ...input, accountId }, async (snapshot, sql) => {
      const account = this.account(snapshot, accountId)
      if (account.removedAt || !isDeepStrictEqual(account.binding, before.binding)) {
        throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The observed account changed before publication.', 409)
      }
      if (observation && account.binding?.bindingRevision !== observation.bindingRevision) {
        throw new DomainError('PROVIDER_ACCOUNT_OBSERVATION_STALE', 'The observation names another binding revision.', 409)
      }
      const prior = account.observation
      if (observation && prior && (observation.generation < prior.generation
        || (observation.generation === prior.generation && observation.sequence <= prior.sequence))) return
      Object.assign(account, observed)
      if (observation) {
        if (account.observation?.subject
          && account.observation.subject.subject !== observation.subject?.subject) {
          await assertAccountUnused(sql, account.id)
        }
        account.observation = observation
        account.status = observation.status
        account.identity = observation.identity
        account.possibleDuplicateAccountIds = observation.subject ? snapshot.accounts.filter(other =>
          other.id !== account.id && other.provider === account.provider
          && other.observation?.subject?.subject === observation.subject!.subject
          && isDeepStrictEqual(other.binding?.target, account.binding?.target)).map(other => other.id) : []
      }
    })
  }

  async prepareAuthentication(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) : Promise<{ value: ProviderAccountAuthenticationOperation; replayed: boolean }> {
    const input = ProviderAccountAuthenticationPrepareInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.prepareAuthentication(principal, source, accountId, raw)
    await this.authorizeMutation(principal, source, 'provider.account.auth.prepare', accountId, input.target)
    return this.authentication.prepare(principal, source, accountId, raw).catch(async (error: unknown) => {
      if (error instanceof DomainError && error.status === 403) {
        await this.auditDenied(principal, source, 'provider.account.auth.prepare', accountId, error)
      }
      throw error
    })
  }

  async authenticationStatus(principal: ManagementPrincipal, raw: unknown, source: CommandSource = 'http') : Promise<ProviderAccountAuthenticationOperation> {
    const input = ProviderAccountAuthenticationReadInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.authenticationStatus(principal, raw, source)
    await this.checkTarget(input.target)
    return this.authentication.status(principal, input.operationId, source)
  }

  async cancelAuthentication(principal: ManagementPrincipal, source: CommandSource, raw: unknown) : Promise<{ value: ProviderAccountAuthenticationOperation; replayed: boolean }> {
    const input = ProviderAccountAuthenticationCancelInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.cancelAuthentication(principal, source, raw)
    const original = await this.authentication.read(input.operationId)
    await this.authorizeMutation(principal, source, 'provider.account.auth.cancel', original.binding.accountId, input.target)
    return this.authentication.cancel(principal, source, raw).catch(async (error: unknown) => {
      if (error instanceof DomainError && error.status === 403) {
        await this.auditDenied(principal, source, 'provider.account.auth.cancel', original.binding.accountId, error)
      }
      throw error
    })
  }

  async login(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) : Promise<{ value: ProviderAccountsSnapshot; replayed: boolean }> {
    const input = ProviderAccountCommandInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.login(principal, source, accountId, raw)
    const result = await this.prepareAuthentication(principal, source, accountId, { ...input, intent: 'sign-in' })
    await this.authorize(this.pool, principal, 'provider_accounts:read', accountId)
    return { value: await this.repository.read(), replayed: result.replayed }
  }

  async logout(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) : Promise<{ value: ProviderAccountsSnapshot; replayed: boolean }> {
    const input = ProviderAccountCommandInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.logout(principal, source, accountId, raw)
    const result = await this.prepareAuthentication(principal, source, accountId, { ...input, intent: 'sign-out' })
    await this.authorize(this.pool, principal, 'provider_accounts:read', accountId)
    return { value: await this.repository.read(), replayed: result.replayed }
  }

  async remove(principal: ManagementPrincipal, source: CommandSource, accountId: string, raw: unknown) : Promise<{ value: ProviderAccountsSnapshot; replayed: boolean }> {
    const input = ProviderAccountCommandInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.remove(principal, source, accountId, raw)
    const result = await this.change(principal, source, 'provider.account.remove', input, { ...input, accountId }, async snapshot => {
      const account = this.account(snapshot, accountId)
      account.removedAt = new Date().toISOString()
      account.isDefault = false
      account.revision += 1
      const scoped = snapshot.defaults!.find(value => value.provider === account.provider)!
      if (scoped.accountId === accountId) {
        scoped.accountId = null
        scoped.revision += 1
      }
    })
    const account = result.value.accounts.find(value => value.id === accountId)
    await this.provision(principal, source, 'provider.account.remove', account)
    return result
  }

  async register(principal: ManagementPrincipal, source: CommandSource, raw: unknown) : Promise<{ value: ProviderAccountsSnapshot; replayed: boolean }> {
    const input = ProviderAccountRegisterInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.register(principal, source, raw)
    await this.authorizeMutation(principal, source, 'provider.account.register', undefined, input.target)
    if (!this.native.registerProfile) throw new DomainError('PROVIDER_PROFILE_REGISTRATION_UNAVAILABLE',
      'This installation does not support qualified native profile registration.', 409)
    const target = await this.repository.target()
    let registered = { profileRef: input.profileRef }
    const result = await this.change(principal, source, 'provider.account.register', input, input, async snapshot => {
      if (snapshot.accounts.length >= 100) throw new DomainError('ACCOUNT_LIMIT', 'The account limit has been reached.', 409)
      if (snapshot.accounts.some(account => account.provider === input.provider && account.binding?.profileRef === registered.profileRef)) {
        throw new DomainError('PROVIDER_PROFILE_ALREADY_REGISTERED', 'This native profile is already registered.', 409)
      }
      const id = randomUUID()
      snapshot.accounts.push({ id, provider: input.provider, name: input.name, authMode: input.authMode,
        isDefault: false, status: 'unavailable', identity: null, revision: 1, removedAt: null,
        binding: { kind: 'slot', accountId: id, provider: input.provider, target,
          profileRef: registered.profileRef, bindingRevision: 1, subject: null } })
    }, { prepare: async () => {
      registered = await this.native.registerProfile!({ provider: input.provider, authMode: input.authMode, profileRef: input.profileRef,
        qualificationId: input.qualificationId, target })
    } })
    const account = result.value.accounts.at(-1)
    await this.provision(principal, source, 'provider.account.register', account)
    return result
  }

  async models(principal: ManagementPrincipal, raw: unknown): Promise<ProviderAccountModels> {
    const input = ProviderAccountGetInputSchema.parse(raw)
    const remote = await this.remote(principal, input.target)
    if (remote) return remote.models(principal, raw)
    const account = await this.get(principal, raw)
    if (account.removedAt || !this.native.models) throw new DomainError('PROVIDER_ACCOUNT_MODELS_UNAVAILABLE',
      'Model discovery is unavailable for this account/installation.', 409)
    const selected = await this.resolve(account.provider, account.id, { allowDefault: false })
    if (!selected?.binding) throw new DomainError('PROVIDER_ACCOUNT_BINDING_UNAVAILABLE', 'The account binding is unavailable.', 409)
    const scoped = { ...account, binding: selected.binding }
    const result = ProviderAccountModelsSchema.parse(await this.native.models({
      account: scoped, ...await this.profilePaths(account),
    }))
    await this.authorize(this.pool, principal, 'provider_accounts:read', account.id)
    if (selected.observation && selected.observation.generation !== result.generation) {
      throw new DomainError('PROVIDER_ACCOUNT_OBSERVATION_STALE', 'The model catalog names another observation generation.', 409)
    }
    if (!isDeepStrictEqual(scoped.binding, result.binding)) {
      throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'Model discovery returned another account binding.', 409)
    }
    const current = await this.resolve(account.provider, account.id, { allowDefault: false })
    if (!current?.binding || current.observation && current.observation.generation !== result.generation
      || current.binding.subject?.subject !== result.binding.subject?.subject
      || !isDeepStrictEqual({ ...current.binding, subject: result.binding.subject }, result.binding)) {
      throw new DomainError('PROVIDER_ACCOUNT_OBSERVATION_STALE', 'The account changed during model discovery.', 409)
    }
    return result
  }

  provisionApiKey(principal: ManagementPrincipal, accountId: string, raw: unknown) {
    const input = ProviderAccountApiKeyInputSchema.parse(raw)
    const { apiKey, ...command } = input
    const apiKeyDigest = createHash('sha256').update(apiKey).digest('hex')
    let backup: Map<string, Buffer | null> | undefined
    return this.change(principal, 'http', 'provider.account.key.provision', command,
      { ...command, accountId, apiKeyDigest }, async (snapshot, sql) => {
        const account = this.account(snapshot, accountId)
        if (account.legacyProfile) throw new DomainError('PROVIDER_ACCOUNT_PRINCIPAL_UNKNOWN',
          'The original native profile has unproved historical ownership.', 409)
        if (account.provider !== 'claude' || account.authMode !== 'api-key') {
          throw new DomainError('ACCOUNT_AUTH_MODE_MISMATCH', 'This account uses provider subscription sign-in.', 409)
        }
        await assertAccountUnused(sql, accountId)
        const active = await sql.query('select 1 from provider_account_authentication_operations '
          + 'where account_id=$1 and not native_closed', [accountId])
        if (active.rowCount) throw new DomainError('PROVIDER_AUTHENTICATION_PENDING', 'Authentication is still pending.', 409)
        backup = await this.credentials.backup(account)
        await this.credentials.saveApiKey(accountId, apiKey)
        Object.assign(account, { status: 'signed-in', identity: null, revision: snapshot.revision + 1 })
      }, { afterRollback: async () => { if (backup) await this.credentials.restore(backup) } })
  }

  async resolve(provider: AccountProvider, accountId?: string,
    options?: { sql?: GraphSqlClient; allowDefault?: boolean; signal?: AbortSignal;
      acceptedBinding?: AcceptedProviderAccountBinding }): Promise<ResolvedProviderAccount | null> {
    options?.signal?.throwIfAborted()
    if (options?.acceptedBinding?.kind === 'legacy-profile') {
      const originalId = options.acceptedBinding.accountId
      if (accountId && accountId !== originalId) {
        throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'Accepted work uses its original profile.', 409)
      }
      if (!originalId) return null
      return this.resolve(provider, originalId, { ...(options.sql ? { sql: options.sql } : {}),
        ...(options?.signal ? { signal: options.signal } : {}), allowDefault: false })
    }
    const accepted = options?.acceptedBinding
    if (accepted && (accepted.provider !== provider || (accountId && accepted.accountId !== accountId))) {
      throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'Accepted work names another account.', 409)
    }
    if (accepted?.kind === 'slot' && !sameDeviceProvisioningTarget(accepted.target, await this.repository.target(options?.sql))) {
      if (!this.routing?.resolve) throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT',
        'The owning Worker account resolver is unavailable.', 409)
      return this.routing.resolve(accepted, options?.sql, options?.signal)
    }
    accountId = accepted?.accountId ?? accountId
    const snapshot = options?.sql ? await this.repository.lock(options.sql) : await this.repository.read()
    let account: ProviderAccount | undefined
    if (accountId && !snapshot.accounts.some(value => value.id === accountId) && this.routing?.locate) {
      const remote = await this.routing.locate(accountId, options?.sql)
      if (remote?.provider !== undefined && remote.provider !== provider) {
        throw new DomainError('PROVIDER_ACCOUNT_MISMATCH', 'The Worker account belongs to another provider.', 409)
      }
      if (remote && this.routing.resolve) {
        const resolved = await this.routing.resolve(accepted ?? remote, options?.sql, options?.signal)
        if (!accepted && resolved?.binding && resolved.observation?.subject) {
          return { ...resolved, binding: { ...resolved.binding, subject: resolved.observation.subject } }
        }
        return resolved
      }
    }
    if (accountId) account = this.account(snapshot, accountId)
    else if (options?.allowDefault !== false) {
      account = snapshot.accounts.find(value => value.provider === provider && value.isDefault && !value.removedAt)
    }
    if (!account) return null
    if (!account.binding || !sameDeviceProvisioningTarget(account.binding.target, await this.repository.target(options?.sql))) {
      throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The original account installation is unavailable.', 409)
    }
    if (account.removedAt) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'The saved account was removed from selection.', 409)
    if (options?.sql) {
      const pending = await options.sql.query('select 1 from provider_account_authentication_operations '
        + 'where account_id=$1 and not native_closed', [account.id])
      if (pending.rowCount) throw new DomainError('PROVIDER_AUTHENTICATION_PENDING',
        'Authentication must be reconciled before accepting work for this account.', 409)
    }
    if (accepted && !isDeepStrictEqual(accepted, { ...account.binding, subject: accepted.subject })) {
      throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The accepted native account binding changed.', 409)
    }
    if (accepted?.subject && account.observation?.subject
      && account.observation.subject.subject !== accepted.subject.subject) {
      throw new DomainError('PROVIDER_ACCOUNT_PRINCIPAL_UNAVAILABLE', 'The saved provider principal cannot be verified.', 409)
    }
    if (account.provider !== provider) {
      throw new DomainError('PROVIDER_ACCOUNT_MISMATCH', 'The selected account belongs to another provider.', 409)
    }
    const paths = await this.profilePaths(account)
    if (!options?.sql && this.native.requireRuntimeAccount) {
      await this.native.requireRuntimeAccount({ account, ...paths })
    } else if (!options?.sql && this.native.authenticationGeneration) {
      await this.native.authenticationGeneration({ account, ...paths })
    }
    const apiKey = account.authMode === 'api-key' ? await this.credentials.apiKey(account.id) : undefined
    if (account.authMode === 'api-key' && !apiKey) {
      throw new DomainError('PROVIDER_ACCOUNT_SIGN_IN_REQUIRED', 'Add an API key to the selected account in Settings.', 409)
    }
    let binding = accepted ?? { ...account.binding, subject: account.observation?.subject ?? account.binding.subject }
    let observation: ProviderAccountObservation | undefined
    if (!options?.sql && account.authMode === 'subscription' && this.native.observeAccount) {
      observation = ProviderAccountObservationSchema.parse(await this.native.observeAccount({ account, ...paths }))
      if (observation.bindingRevision !== binding.bindingRevision
        || (binding.subject && observation.subject?.subject !== binding.subject.subject)) {
        throw new DomainError('PROVIDER_ACCOUNT_PRINCIPAL_UNAVAILABLE', 'The selected native principal changed or is unproved.', 409)
      }
      if (!accepted && observation.subject) binding = { ...binding, subject: observation.subject }
    }
    return { accountId: account.id, homePath: paths.homePath,
      authMode: account.authMode, binding, ...(observation ? { observation } : {}),
      ...(apiKey ? { apiKey } : {}) }
  }

  close(): Promise<void> { return this.native.close() }
}
