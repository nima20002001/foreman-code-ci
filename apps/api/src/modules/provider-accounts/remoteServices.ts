import { createHash } from 'node:crypto'
import { withTransaction } from '../../infrastructure/transaction.js'
import type pg from 'pg'
import { isDeepStrictEqual } from 'node:util'
import { DeviceRegistrationSchema } from '@foreman-code/contracts/device-identity'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { ProviderAccountBindingSchema, ProviderAccountModelsSchema, ProviderAccountObservationSchema, ProviderAccountNativeDiscoverySchema,
  ProviderAccountNativeAuthenticationObservationSchema, PROVIDER_ACCOUNT_WORKER_NAMESPACE,
  ProviderAccountWorkerRequestSchema,
  type ProviderAccountBinding, type ProviderAccountTarget } from '@foreman-code/contracts/provider-accounts'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { requireAuthorization, requireLiveAccountAuthorization } from '../access/policy.js'
import { readLiveManagementPrincipal } from '../access/liveManagementPrincipal.js'
import { assertDeviceHostInstallation } from '../devices/hostAuthorization.js'
import { DomainError } from '../errors.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { ProviderAccountsRepository } from './repository.js'
import { ProviderAccountsService, type ProviderAccountCredentials, type ProviderAccountOperationNativePort } from './service.js'
import { ProviderAccountWorkerCarrier } from './workerCarrier.js'
import { assertAccountUnused } from './authenticationOperations.js'

export async function authorizeAccountTarget(sql: GraphSqlClient, principal: ManagementPrincipal,
  target: DeviceProvisioningTarget, manage: boolean, accountId?: string): Promise<void> {
  const resource = { mainId: target.hostRef.mainId, applicationInstallationId: target.applicationInstallationId,
    ...(target.hostRef.kind === 'device' ? { deviceId: target.hostRef.deviceId } : {}),
    ...(accountId ? { providerAccountId: accountId } : {}) }
  requireAuthorization(principal, 'provider_accounts:read', resource)
  const action = manage ? 'provider_accounts:manage' : 'provider_accounts:read'
  requireAuthorization(await readLiveManagementPrincipal(sql, principal.id), action, resource)
  await requireLiveAccountAuthorization(sql, principal.id, action, resource)
  const device = await assertDeviceHostInstallation(sql, target.hostRef, target.applicationInstallationId)
  if (device && (device.keyRevision !== target.keyRevision || device.authorizationRevision !== target.authorizationRevision)) {
    throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The paired Worker authority changed.', 403)
  }
}

/** Central metadata and receipts; every filesystem/native effect is dispatched to the owning Worker. */
export function createRemoteAccountServices(input: {
  pool: pg.Pool; commands: PostgresCommandCoordinator; local: ProviderAccountsService
  endpoint(): Pick<DeviceEndpoint, 'captureRequest' | 'currentBinding' | 'capabilities'>
}) {
  const repository = (target: DeviceProvisioningTarget) => {
    const key = createHash('sha256').update(JSON.stringify(target)).digest('hex')
    const value = new ProviderAccountsRepository(input.pool, async () => `worker:${key}`)
    value.bindTarget(async () => target)
    return value
  }
  const carrier = new ProviderAccountWorkerCarrier(input.endpoint, async (principal, target, request) => {
    let id: string | undefined
    if ('binding' in request) id = request.binding.accountId
    else if ('operation' in request) id = request.operation.binding.accountId
    else if (request.kind === 'provision') id = request.account.id
    const manage = ['prepare', 'cancel', 'provision', 'register'].includes(request.kind)
    await authorizeAccountTarget(input.pool, principal, target, manage, id)
  })
  const scope = async (principal: ManagementPrincipal, target: DeviceProvisioningTarget) => {
    if (target.hostRef.kind !== 'device') throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'Select a paired Worker.', 409)
    const request = (value: Parameters<ProviderAccountWorkerCarrier['request']>[2]) => carrier.request(principal, target, value)
    const native = workerNativePort(request)
    const unsupported = async (): Promise<never> => { throw new DomainError('PROVIDER_ACCOUNT_LOCAL_HUMAN_REQUIRED',
      'API-key provisioning must be performed by a human on the owning computer.', 403) }
    const credentials: ProviderAccountCredentials = {
      paths: () => ({ homePath: '', userHome: '' }),
      create: async account => {
        if (account.authMode !== 'subscription') throw new DomainError('PROVIDER_ACCOUNT_AUTH_MODE_UNSUPPORTED',
          'Worker slots support qualified subscription profiles. API keys use the existing local human flow.', 409)
      },
      assertAvailable: async () => {},
      apiKey: unsupported, backup: unsupported, saveApiKey: unsupported, restore: unsupported,
      clearApiKey: unsupported, removeCreatedHome: async () => {},
    }
    return new ProviderAccountsService(input.pool, repository(target), credentials, native, input.commands,
      (sql, caller, manage, accountId) => authorizeAccountTarget(sql, caller, target, manage, accountId))
  }
  return {
    scope,
    async targets(principal: ManagementPrincipal): Promise<ProviderAccountTarget[]> {
      const targets: ProviderAccountTarget[] = []
      try { targets.push(await input.local.localTargetCapabilities(principal)) } catch (error) {
        if (!(error instanceof DomainError) || error.status !== 403) throw error
      }
      const rows = await input.pool.query<{ record: unknown }>('select record from device_registrations')
      for (const row of rows.rows) {
        const device = DeviceRegistrationSchema.parse(row.record)
        if (device.status !== 'paired') continue
        const target: DeviceProvisioningTarget = { hostRef: { kind: 'device', mainId: device.mainId, deviceId: device.deviceId },
          applicationInstallationId: device.workerInstallationId, keyRevision: device.keyRevision,
          authorizationRevision: device.authorizationRevision }
        try { await authorizeAccountTarget(input.pool, principal, target, false) } catch (error) {
          if (!(error instanceof DomainError) || error.status !== 403) throw error
          continue
        }
        let canManage = true
        try { await authorizeAccountTarget(input.pool, principal, target, true) } catch (error) {
          if (!(error instanceof DomainError) || error.status !== 403) throw error
          canManage = false
        }
        const channel = input.endpoint().captureRequest(device.deviceId, PROVIDER_ACCOUNT_WORKER_NAMESPACE)
        let providers: ProviderAccountTarget['providers'] = []
        if (channel) {
          const service = await scope(principal, target)
          const remote = await service.localTargetCapabilities(principal)
          providers = remote.providers
        }
        await authorizeAccountTarget(input.pool, principal, target, false)
        if (canManage) {
          try { await authorizeAccountTarget(input.pool, principal, target, true) } catch (error) {
            if (!(error instanceof DomainError) || error.status !== 403) throw error
            canManage = false
          }
        }
        targets.push({ target, label: `Worker ${device.deviceId}`, generation: channel?.binding.connectionGeneration ?? 1,
          connected: Boolean(channel), canRead: true, canManage, providers })
      }
      return targets
    },
    async locate(accountId: string, sql: GraphSqlClient = input.pool) {
      const rows = await sql.query<{ binding: unknown }>(
        "select a->'binding' as binding from application_settings s cross join lateral jsonb_array_elements(s.record->'accounts') a "
        + "where s.key like 'provider-accounts:worker:%' and a->>'id'=$1", [accountId])
      if (rows.rows.length > 1) throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'More than one Worker owns this slot.', 409)
      if (!rows.rows[0]) return undefined
      const binding = ProviderAccountBindingSchema.parse(rows.rows[0].binding)
      const account = (await repository(binding.target).read(sql)).accounts.find(value => value.id === accountId)
      return account?.binding ? { ...account.binding, subject: account.observation?.subject ?? account.binding.subject } : undefined
    },
    async resolve(binding: ProviderAccountBinding, sql?: GraphSqlClient, signal?: AbortSignal) {
      signal?.throwIfAborted()
      const reader = sql ?? input.pool
      const store = repository(binding.target)
      const snapshot = sql ? await store.lock(sql) : await store.read(reader)
      const account = snapshot.accounts.find(value => value.id === binding.accountId)
      if (!account?.binding || account.removedAt || !isDeepStrictEqual(account.binding, { ...binding, subject: account.binding.subject })) {
        throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'The accepted Worker slot was removed or changed.', 409)
      }
      if (binding.target.hostRef.kind !== 'device') throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'Select the owning Worker.', 409)
      const device = await assertDeviceHostInstallation(reader, binding.target.hostRef, binding.target.applicationInstallationId)
      if (!device || device.keyRevision !== binding.target.keyRevision || device.authorizationRevision !== binding.target.authorizationRevision) {
        throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The original Worker installation changed.', 409)
      }
      const pending = await reader.query('select 1 from provider_account_authentication_operations '
        + 'where account_id=$1 and not native_closed', [account.id])
      if (pending.rowCount) throw new DomainError('PROVIDER_AUTHENTICATION_PENDING', 'Reconcile the original Worker authentication first.', 409)
      if (sql && binding.subject && account.observation?.subject?.subject !== binding.subject.subject) {
        throw new DomainError('PROVIDER_ACCOUNT_PRINCIPAL_UNAVAILABLE', 'The accepted Worker principal is unproved or changed.', 409)
      }
      let observation = account.observation
      if (!sql) {
        const channel = input.endpoint().captureRequest(device.deviceId, PROVIDER_ACCOUNT_WORKER_NAMESPACE)
        if (!channel) throw new DomainError('PROVIDER_ACCOUNT_WORKER_UNAVAILABLE', 'The owning Worker is unavailable.', 409)
        const captured = structuredClone(channel.binding)
        if (captured.mainId !== binding.target.hostRef.mainId || captured.deviceId !== device.deviceId
          || captured.workerInstallationId !== binding.target.applicationInstallationId
          || captured.keyRevision !== binding.target.keyRevision
          || captured.authorizationRevision !== binding.target.authorizationRevision) {
          throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The owning Worker installation changed.', 409)
        }
        const connection = { mainId: captured.mainId, deviceId: captured.deviceId,
          workerInstallationId: captured.workerInstallationId, bootId: captured.bootId,
          keyRevision: captured.keyRevision, authorizationRevision: captured.authorizationRevision,
          connectionGeneration: captured.connectionGeneration }
        const request = ProviderAccountWorkerRequestSchema.parse({ version: 1, target: binding.target, connection,
          request: { kind: 'status', binding } })
        // Admission and recovery read only the accepted slot over its authenticated runtime channel.
        const result = await channel.request(request, signal ? { signal } : undefined)
        signal?.throwIfAborted()
        const current = input.endpoint().captureRequest(device.deviceId, PROVIDER_ACCOUNT_WORKER_NAMESPACE)
        if (!current || !isDeepStrictEqual(current.binding, captured) || result.bytes !== undefined) {
          throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The owning Worker connection changed.', 409)
        }
        observation = ProviderAccountObservationSchema.parse(result.payload)
        if (observation.bindingRevision !== binding.bindingRevision
          || binding.subject && observation.subject?.subject !== binding.subject.subject) {
          throw new DomainError('PROVIDER_ACCOUNT_PRINCIPAL_UNAVAILABLE', 'The accepted Worker principal is unproved or changed.', 409)
        }
        const reported = observation
        signal?.throwIfAborted()
        observation = await withTransaction(input.pool, async (client) => {
          signal?.throwIfAborted()
          const currentDevice = await assertDeviceHostInstallation(client, binding.target.hostRef, binding.target.applicationInstallationId)
          if (!currentDevice || currentDevice.keyRevision !== binding.target.keyRevision
            || currentDevice.authorizationRevision !== binding.target.authorizationRevision) {
            throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The owning Worker authority changed.', 409)
          }
          const currentAccount = (await store.lock(client)).accounts.find(value => value.id === binding.accountId)
          if (!currentAccount?.binding || currentAccount.removedAt
            || !isDeepStrictEqual(currentAccount.binding, account.binding)) {
            throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'The accepted Worker slot was removed or changed.', 409)
          }
          if (currentAccount.observation?.subject
            && currentAccount.observation.subject.subject !== reported.subject?.subject) {
            await assertAccountUnused(client, binding.accountId)
          }
          return store.observe(client, binding.accountId, reported)
        })
        if (!isDeepStrictEqual(input.endpoint().currentBinding(device.deviceId), captured)) {
          throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The owning Worker connection changed.', 409)
        }
      }
      return { accountId: account.id, homePath: '', authMode: account.authMode, binding,
        ...(observation ? { observation } : {}) }
    },
  }
}

/** Native account operations are carried to the owning Worker; Main never touches remote paths. */
function workerNativePort(request: (value: Parameters<ProviderAccountWorkerCarrier['request']>[2]) => Promise<unknown>,
): ProviderAccountOperationNativePort {
  const binding = (account: Parameters<NonNullable<ProviderAccountOperationNativePort['observeAccount']>>[0]['account']) => {
    if (!account.binding) throw new DomainError('PROVIDER_ACCOUNT_BINDING_UNAVAILABLE', 'The saved Worker slot is unavailable.', 409)
    return account.binding
  }
  return {
    async discover(_target, provider) {
      return ProviderAccountNativeDiscoverySchema.parse(await request({ kind: 'discover', ...(provider ? { provider } : {}) }))
    },
    async provisionAccount(account) { await request({ kind: 'provision', account }) },
    async registerProfile(value) {
      if (!value.authMode) throw new DomainError('ACCOUNT_AUTH_MODE_MISMATCH', 'Select the qualified profile authentication mode.', 409)
      const result = await request({ kind: 'register', provider: value.provider, authMode: value.authMode, profileRef: value.profileRef,
        qualificationId: value.qualificationId })
      return { profileRef: (result as { profileRef: string }).profileRef }
    },
    async status(value) {
      const observed = ProviderAccountObservationSchema.parse(await request({ kind: 'status', binding: binding(value.account) }))
      return { status: observed.status, identity: observed.identity, subject: observed.subject }
    },
    async observeAccount(value) {
      return ProviderAccountObservationSchema.parse(await request({ kind: 'status', binding: binding(value.account) }))
    },
    async models(value) {
      return ProviderAccountModelsSchema.parse(await request({ kind: 'models', binding: binding(value.account) }))
    },
    async authenticationGeneration(value) {
      const observed = ProviderAccountObservationSchema.parse(await request({ kind: 'status', binding: binding(value.account) }))
      return observed.generation
    },
    async requireRuntimeAccount(value) {
      const observed = ProviderAccountObservationSchema.parse(await request({ kind: 'status', binding: binding(value.account) }))
      if (observed.readiness === 'qualification-required' || observed.readiness === 'unavailable') {
        throw new DomainError('PROVIDER_ACCOUNT_UNQUALIFIED', 'The owning Worker slot is unavailable.', 409)
      }
    },
    async prepareAuthentication(value) {
      return ProviderAccountNativeAuthenticationObservationSchema.parse(await request({ kind: 'prepare', operation: value.operation }))
    },
    async observeAuthentication(value) {
      return ProviderAccountNativeAuthenticationObservationSchema.parse(await request({ kind: 'observe', operation: value.operation }))
    },
    async cancelAuthentication(value) {
      return ProviderAccountNativeAuthenticationObservationSchema.parse(await request({ kind: 'cancel', operation: value.operation }))
    },
    // The carrier resolves native paths on the Worker. Main never holds a remote filesystem path.
    async resolveProfile() { return { homePath: '', userHome: '' } },
    async login() { throw new DomainError('PROVIDER_OPERATION_REQUIRED', 'Use the persisted authentication operation.', 409) },
    async logout() { throw new DomainError('PROVIDER_OPERATION_REQUIRED', 'Use the persisted authentication operation.', 409) },
    async cancelLogin() { throw new DomainError('PROVIDER_OPERATION_REQUIRED', 'Cancel the original operation.', 409) },
    async close() {},
  }
}
