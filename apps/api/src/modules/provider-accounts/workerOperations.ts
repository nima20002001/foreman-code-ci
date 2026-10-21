import { isDeepStrictEqual } from 'node:util'
import {
  PROVIDER_ACCOUNT_WORKER_NAMESPACE, PROVIDER_ACCOUNT_WORKER_VERSION, ProviderAccountWorkerRequestSchema,
  ProviderAccountObservationSchema, ProviderAccountModelsSchema, ProviderAccountNativeAuthenticationObservationSchema,
  ProviderAccountNativeDiscoverySchema, ProviderAccountSchema,
  type ProviderAccount, type AcceptedProviderAccountBinding, type ProviderAccountBinding, type ProviderAccountWorkerRequest,
} from '@foreman-code/contracts/provider-accounts'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import type { DeviceExtensionContext, DeviceExtensionRegistration } from '../devices/deviceApplicationChannel.js'
import type { ProviderAccountResolver, ProviderAccountOperationNativePort, ResolvedProviderAccount } from './service.js'
import type { ProviderAccountNativeInput } from './nativeCommands.js'
import { DomainError } from '../errors.js'

export interface WorkerAccountOperationPorts {
  validate?(binding: ProviderAccountBinding): Promise<void>
  prepareAccount?(account: ResolvedProviderAccount): Promise<void>
  provision?(account: ProviderAccount): Promise<ProviderAccount>
  native: ProviderAccountOperationNativePort
  current(): Readonly<DeviceSessionBinding>
  resolve(binding: ProviderAccountBinding): Promise<ProviderAccountNativeInput>
  authorize(request: ProviderAccountWorkerRequest, context: DeviceExtensionContext): Promise<void>
}

export function assertWorkerProviderAccountBinding(binding: AcceptedProviderAccountBinding | undefined,
  connection: Readonly<DeviceSessionBinding>): void {
  const target = binding?.target
  if (!target) return
  if (target.hostRef.kind !== 'device' || target.hostRef.mainId !== connection.mainId
    || target.hostRef.deviceId !== connection.deviceId || target.applicationInstallationId !== connection.workerInstallationId
    || target.keyRevision !== connection.keyRevision || target.authorizationRevision !== connection.authorizationRevision) {
    throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The account belongs to another Worker installation.', 403)
  }
}

export function workerProviderAccountResolver(ports: Pick<WorkerAccountOperationPorts, 'current' | 'resolve'>
  & Partial<Pick<WorkerAccountOperationPorts, 'native' | 'validate' | 'prepareAccount'>>): ProviderAccountResolver {
  return { async resolve(provider, accountId, options) {
    const binding = options?.acceptedBinding
    if (!binding || binding.kind !== 'slot' || binding.provider !== provider || binding.accountId !== accountId) {
      throw new DomainError('PROVIDER_ACCOUNT_BINDING_UNAVAILABLE', 'Worker execution requires its accepted local account binding.', 409)
    }
    assertWorkerProviderAccountBinding(binding, ports.current())
    await ports.validate?.(binding)
    assertWorkerProviderAccountBinding(binding, ports.current())
    const input = await ports.resolve(binding)
    assertWorkerProviderAccountBinding(binding, ports.current())
    if (!isDeepStrictEqual(input.account.binding, binding) || input.account.removedAt) {
      throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'The accepted Worker account is unavailable.', 409)
    }
    await ports.native?.requireRuntimeAccount?.(input)
    if (binding.subject && ports.native?.observeAccount) {
      const observed = await ports.native.observeAccount(input)
      if (observed.subject?.subject !== binding.subject.subject) throw new DomainError(
        'PROVIDER_ACCOUNT_PRINCIPAL_UNAVAILABLE', 'The accepted Worker provider principal changed or is unproved.', 409)
    }
    const account = { accountId: binding.accountId, homePath: input.homePath, authMode: input.account.authMode, binding,
      ...(input.apiKey ? { apiKey: input.apiKey } : {}) }
    if (provider === 'codex') await ports.prepareAccount?.(account)
    assertWorkerProviderAccountBinding(binding, ports.current())
    return account
  } }
}

function assertConnection(request: ProviderAccountWorkerRequest, context: DeviceExtensionContext,
  current: Readonly<DeviceSessionBinding>): void {
  const target = request.target
  const connection = request.connection
  const fields = ['mainId', 'deviceId', 'workerInstallationId', 'bootId', 'keyRevision',
    'authorizationRevision', 'connectionGeneration'] as const
  if (context.bytes !== undefined || !isDeepStrictEqual(current, context.binding)
    || fields.some(field => current[field] !== connection[field]) || target.hostRef.kind !== 'device'
    || target.hostRef.mainId !== current.mainId || target.hostRef.deviceId !== current.deviceId
    || target.applicationInstallationId !== current.workerInstallationId
    || target.keyRevision !== current.keyRevision || target.authorizationRevision !== current.authorizationRevision) {
    throw new DomainError('PROVIDER_ACCOUNT_WORKER_BINDING_CONFLICT', 'The account request is not on its current owning Worker.', 403)
  }
  const command = request.request
  let binding: ProviderAccountBinding | undefined
  if ('binding' in command) binding = command.binding
  else if ('operation' in command) binding = command.operation.binding
  else if (command.kind === 'provision') binding = command.account.binding
  if (binding && !isDeepStrictEqual(binding.target, target)) throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT',
    'The requested account belongs to another Worker installation.', 403)
}

/** Advertise only when the installed host supplies qualified local operations. */
export function createProviderAccountWorkerExtension(ports: WorkerAccountOperationPorts): DeviceExtensionRegistration {
  return { namespace: PROVIDER_ACCOUNT_WORKER_NAMESPACE, version: PROVIDER_ACCOUNT_WORKER_VERSION,
    role: 'duplex', maxJsonBytes: 65_536, maxBinaryBytes: 0,
    async handle(raw, context) {
      const request = ProviderAccountWorkerRequestSchema.parse(raw)
      context.signal.throwIfAborted()
      assertConnection(request, context, ports.current())
      await ports.authorize(request, context)
      context.signal.throwIfAborted()
      assertConnection(request, context, ports.current())
      const command = request.request
      if (command.kind === 'discover' || command.kind === 'register' || command.kind === 'provision') {
        let payload: unknown
        if (command.kind === 'discover') {
          if (!ports.native.discover) throw new DomainError('PROVIDER_ACCOUNT_UNSUPPORTED', 'Account discovery is unavailable.', 409)
          payload = ProviderAccountNativeDiscoverySchema.parse(await ports.native.discover(request.target, command.provider))
        } else if (command.kind === 'register') {
          if (!ports.native.registerProfile) throw new DomainError('PROVIDER_PROFILE_UNQUALIFIED', 'Profile registration is unavailable.', 409)
          payload = await ports.native.registerProfile({ provider: command.provider, authMode: command.authMode, profileRef: command.profileRef,
            qualificationId: command.qualificationId, target: request.target })
        } else {
          if (!ports.provision || !command.account.binding) throw new DomainError('PROVIDER_ACCOUNT_UNSUPPORTED', 'Slot provisioning is unavailable.', 409)
          payload = ProviderAccountSchema.parse(await ports.provision(command.account))
        }
        assertConnection(request, context, ports.current())
        await ports.authorize(request, context)
        context.signal.throwIfAborted()
        assertConnection(request, context, ports.current())
        return { payload }
      }
      const binding = 'binding' in command ? command.binding : command.operation.binding
      const input = await ports.resolve(binding)
      if (!isDeepStrictEqual(input.account.binding, binding)) throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT',
        'The local account differs from the accepted Worker binding.', 409)
      assertConnection(request, context, ports.current())
      let payload: unknown
      if (command.kind === 'status') {
        if (!ports.native.observeAccount) throw new DomainError('PROVIDER_ACCOUNT_UNSUPPORTED', 'Account status is unavailable.', 409)
        const observed = ProviderAccountObservationSchema.parse(await ports.native.observeAccount(input))
        if (observed.bindingRevision !== binding.bindingRevision) throw new DomainError(
          'PROVIDER_OBSERVATION_STALE', 'The native status belongs to another account revision.', 409)
        payload = observed
      } else if (command.kind === 'models') {
        if (!ports.native.models) throw new DomainError('PROVIDER_ACCOUNT_UNSUPPORTED', 'Account models are unavailable.', 409)
        const models = ProviderAccountModelsSchema.parse(await ports.native.models(input))
        if (!isDeepStrictEqual(models.binding, binding)) throw new DomainError(
          'PROVIDER_OBSERVATION_STALE', 'The native models belong to another account.', 409)
        payload = models
      } else {
        const operationInput = { ...input, operation: command.operation }
        if (command.kind === 'prepare') {
          if (!ports.native.prepareAuthentication) throw new DomainError('PROVIDER_ACCOUNT_UNSUPPORTED', 'Account authentication is unavailable.', 409)
          payload = await ports.native.prepareAuthentication(operationInput)
        } else if (command.kind === 'observe') {
          if (!ports.native.observeAuthentication) throw new DomainError('PROVIDER_ACCOUNT_UNSUPPORTED', 'Account reconciliation is unavailable.', 409)
          payload = await ports.native.observeAuthentication(operationInput)
        } else {
          if (!ports.native.cancelAuthentication) throw new DomainError('PROVIDER_ACCOUNT_UNSUPPORTED', 'Account cancellation is unavailable.', 409)
          payload = await ports.native.cancelAuthentication(operationInput)
        }
        const observed = ProviderAccountNativeAuthenticationObservationSchema.parse(payload)
        if (observed.operationId !== command.operation.id || observed.generation !== command.operation.generation
          || !isDeepStrictEqual(observed.binding, binding)) throw new DomainError(
            'PROVIDER_OBSERVATION_STALE', 'The native result belongs to another accepted account operation.', 409)
        payload = observed
      }
      assertConnection(request, context, ports.current())
      await ports.authorize(request, context)
      context.signal.throwIfAborted()
      assertConnection(request, context, ports.current())
      return { payload }
    } }
}
