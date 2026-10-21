import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import type { DeviceSessionBinding } from '@foreman-code/contracts/device-connection'
import { ProviderAccountSchema, ProviderAccountIdSchema,
  type ProviderAccount, type ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { HarnessConfigurationSchema } from '@foreman-code/contracts'
import { HarnessOptionsResultSchema, type HarnessOptions } from '@foreman-code/contracts/management'
import type { DeviceApplicationResult } from '@foreman-code/contracts/device-application'
import type { InstalledWorkflowConfigurationLocation } from '../runs/remote/installedWorkflowConfiguration.js'
import { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { privateDirectory, readRecord, writeRecord } from '../harnesses/recovery/storage.js'
import { inspectInstalledCodex } from '../harnesses/installedCodexInspection.js'
import { inspectInstalledClaude } from '../harnesses/installedClaudeInspection.js'
import { HarnessInstanceRegistry, localHarnessDrivers } from '../harnesses/instanceRegistry.js'
import { HarnessInstallationRegistry, type RegistryHarnessSelection, type HarnessInstallationRecord } from '../harnesses/installationRegistry.js'
import { NativeHarnessFactories } from '../harnesses/runtimeFactory.js'
import { NativeConfigurationService } from '../harnesses/nativeConfiguration.js'
import { discoverClaudeMetadata } from '../harnesses/claudeSdk/metadata.js'
import { claudeSettingSupport } from '../harnesses/claudeSdk/nativeConfiguration.js'
import { DomainError } from '../errors.js'
import type { ResolvedProviderAccount } from './service.js'
import { LocalProviderCredentials } from './localCredentials.js'
import { NativeProviderAccountCommands } from './nativeCommands.js'
import { NativeProviderAccountOperations } from './nativeOperations.js'
import { NativeAccountJournal } from './nativeJournal.js'
import { createProductionAccountSelection, AccountIsolationQualificationsSchema,
  type AccountIsolationQualification } from './productionSelection.js'
import { assertWorkerProviderAccountBinding, workerProviderAccountResolver, type WorkerAccountOperationPorts } from './workerOperations.js'

/** Opens only installer-qualified account support; account roots and native history remain on this Worker. */
export function createInstalledWorkerAccounts(input: {
  stateDirectory: string; configuration: InstalledWorkflowConfigurationLocation | null
  current(): Readonly<DeviceSessionBinding>
  registry: NativeProcessRegistry
  prepareAccount?(account: ResolvedProviderAccount): Promise<void>
  target: import('@foreman-code/contracts/device-resources').DeviceProvisioningTarget
  request(namespace: string, payload: unknown): Promise<DeviceApplicationResult>
}): Omit<WorkerAccountOperationPorts, 'current'> | undefined {
  const qualificationPath = join(input.stateDirectory, 'provider-account-qualifications.json')
  const raw = readRecord(qualificationPath)
  if (raw === undefined) return undefined
  const qualified = AccountIsolationQualificationsSchema.parse(raw).records
  if (!qualified.some(record => isDeepStrictEqual(record.target, input.target) && Date.parse(record.expiresAt) > Date.now())) return undefined
  const root = privateDirectory(join(input.stateDirectory, 'provider-account-slots'))
  const journal = new NativeAccountJournal(join(root, 'operations'))
  const credentials = new LocalProviderCredentials(join(root, 'native'))
  const sdkEntrypoints = new Map<string, string>()
  const selections = new Map<string, RegistryHarnessSelection>()
  const instances = new HarnessInstanceRegistry(localHarnessDrivers)
  const installations = new HarnessInstallationRegistry(instances)
  const configured = new Map<string, Parameters<HarnessInstanceRegistry['reload']>[0][number]>()
  const path = (id: string) => join(root, `${ProviderAccountIdSchema.parse(id)}.json`)
  const readAccount = (binding: ProviderAccountBinding): ProviderAccount => {
    assertWorkerProviderAccountBinding(binding, input.current())
    const raw = readRecord(path(binding.accountId))
    if (raw === undefined) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'The original Worker slot is unavailable.', 409)
    const account = ProviderAccountSchema.parse(raw)
    if (!account.binding
      || !isDeepStrictEqual(account.binding, { ...binding, subject: account.binding.subject })) {
      throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The local Worker slot belongs to another installation.', 409)
    }
    return { ...account, binding }
  }
  const resolve: WorkerAccountOperationPorts['resolve'] = async binding => {
    const account = readAccount(binding)
    const paths = binding.profileRef === binding.accountId ? credentials.paths(binding.accountId)
      : await native.resolveProfile(account)
    if (binding.profileRef === binding.accountId) await credentials.assertAvailable(binding.accountId)
    return { account, ...paths }
  }
  const validateProfile = async (record: AccountIsolationQualification) => {
    const binding = input.current()
    assertWorkerProviderAccountBinding({ kind: 'slot', accountId: randomUUID(), provider: record.provider,
      target: record.target, profileRef: 'installation-check', bindingRevision: 1, subject: null }, binding)
    const inspection = await (record.provider === 'codex' ? inspectInstalledCodex : inspectInstalledClaude)({
      binding, configuration: input.configuration, environment: process.env, cwd: input.stateDirectory,
      signal: AbortSignal.timeout(15_000),
    })
    if (!isDeepStrictEqual(binding, input.current()) || !inspection.currentTarget
      || !isDeepStrictEqual(inspection.currentTarget.target, record.override.target)) {
      throw new DomainError('PROVIDER_ACCOUNT_UNQUALIFIED', 'The actual Worker executable no longer matches isolation qualification.', 409)
    }
    const installation = inspection.currentTarget.installation
    if ('sdk' in inspection.currentTarget) sdkEntrypoints.set(record.override.instanceId, inspection.currentTarget.sdk.entrypoint)
    configured.set(record.override.instanceId, { instanceId: record.override.instanceId,
      instanceRevision: record.override.instanceRevision, driverId: record.provider,
      enabled: record.override.enabled, configuration: record.override.configuration })
    instances.reload([...configured.values()])
    const installed: HarnessInstallationRecord = { ...installation,
      launcher: { ...installation.launcher, payloadFingerprints: installation.launcher.payloadFingerprints ?? [] } }
    installations.refresh([...installations.list().filter(value => value.harnessInstallationId !== installed.harnessInstallationId), installed])
    selections.set(record.qualificationId, installations.pin({ instanceId: record.override.instanceId,
      hostRef: installation.hostRef, harnessInstallationId: installation.harnessInstallationId,
      environmentGeneration: installation.environmentGeneration, connectionGeneration: installation.connectionGeneration }))
  }
  const selection = createProductionAccountSelection({ path: qualificationPath, managedPaths: id => credentials.paths(id),
    validate: validateProfile, prepareProfilePaths: validateProfile,
    pin(record) {
      const selected = selections.get(record.qualificationId)
      if (!selected) {
        throw new DomainError('PROVIDER_ACCOUNT_UNQUALIFIED', 'Refresh the owning Worker installation qualification.', 409)
      }
      installations.assertCurrent(selected)
      return selected
    },
    async models(binding) {
      const nativeInput = await resolve(binding)
      let options: HarnessOptions
      if (binding.provider === 'claude') {
        const selected = selection.selectAccount(binding)
        const binary = selected.installation.launcher.resolvedLauncher
        const configuration = HarnessConfigurationSchema.parse(selected.instance.configuration)
        if (!binary || configuration?.harness !== 'claude') throw new DomainError('PROVIDER_MODELS_UNAVAILABLE',
          'The qualified Claude model profile is unavailable.', 409)
        const recovery = await input.registry.reserveLaunch(`account-models:${randomUUID()}`)
        const close = async () => {
          await input.registry.abandonReservedLaunch(recovery)
          if (!await input.registry.closeOwner(recovery.owner)) throw new DomainError('PROVIDER_COMMAND_CLOSURE_UNKNOWN',
            'Model discovery process closure is unconfirmed.', 409)
        }
        try {
          const value = await discoverClaudeMetadata({ binary, model: configuration.model, profilePath: nativeInput.homePath,
            workingDirectory: input.stateDirectory, recovery, signal: AbortSignal.timeout(60_000),
            authMode: nativeInput.account.authMode, accountId: binding.accountId,
            ...(sdkEntrypoints.get(selected.instance.instanceId) ? { sdkEntrypoint: sdkEntrypoints.get(selected.instance.instanceId)! } : {}) })
          options = HarnessOptionsResultSchema.parse({ harness: 'claude', ...value, settings: claudeSettingSupport(),
            restrictions: ['Discovery creates no model turn and does not qualify execution.'], checkedAt: new Date().toISOString() })
        } finally { await close() }
      } else {
        options = await configurations.options('codex', binding)
      }
      return { binding, generation: journal.accountGeneration(input.current()), observedAt: options.checkedAt,
        models: options.models.map(row => ({ ...row, name: row.name ?? row.id })), options }
    },
  })
  const workerSelection = { ...selection,
    async selected(value: Parameters<typeof selection.selected>[0]) {
      const selected = await selection.selected(value)
      return selected ? { ...selected, generation: journal.accountGeneration(input.current()) } : null
    },
    async discover(...value: Parameters<NonNullable<typeof selection.discover>>) {
      const discovered = await selection.discover!(...value)
      return { ...discovered, generation: journal.accountGeneration(input.current()) }
    },
  }
  const native = new NativeProviderAccountOperations(new NativeProviderAccountCommands(workerSelection),
    journal, input.registry, async value => {
      const result = await input.request('provider-accounts-v1', { version: 1, kind: 'authorize', operation: value.operation })
      if (result.bytes !== undefined || !isDeepStrictEqual(result.payload, { allowed: true })) {
        throw new DomainError('ACCESS_DENIED', 'The original Main denied this authentication operation.', 403)
      }
    })
  const validate = async (binding: ProviderAccountBinding): Promise<void> => {
    const current = structuredClone(input.current())
    assertWorkerProviderAccountBinding(binding, current)
    const response = await input.request('provider-accounts-v1', { version: 1, kind: 'binding', binding })
    if (!isDeepStrictEqual(current, input.current()) || response.bytes !== undefined
      || !isDeepStrictEqual(response.payload, { available: true })) {
      throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'The original Main account binding is unavailable.', 409)
    }
  }
  const accounts = workerProviderAccountResolver({ current: input.current, resolve, native, validate,
    ...(input.prepareAccount ? { prepareAccount: input.prepareAccount } : {}) })
  const factories = new NativeHarnessFactories({ codexBinary: '', accounts, instances, installations, selectAccount: selection.selectAccount,
    auxiliaryRecovery: role => input.registry.scope(`${role}:${randomUUID()}`),
    admitRecovery: async recovery => { Object.assign(recovery, await input.registry.reserveLaunch(recovery.owner)) },
    abandonRecovery: recovery => input.registry.abandonReservedLaunch(recovery).then(() => {}),
    closeRecovery: async recovery => {
      if (!await input.registry.closeOwner(recovery.owner)) throw new DomainError('PROVIDER_COMMAND_CLOSURE_UNKNOWN',
        'Model discovery process closure is unconfirmed.', 409)
    },
  })
  const configurations = new NativeConfigurationService('', input.stateDirectory, factories)
  const closeNative = native.close.bind(native)
  native.close = async () => {
    const results = await Promise.allSettled([configurations.shutdownChecks(), closeNative()])
    const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (failures.length) throw new AggregateError(failures, 'Worker account cleanup remains unconfirmed.')
  }
  return { native, resolve, validate,
    ...(input.prepareAccount ? { prepareAccount: input.prepareAccount } : {}),
    async provision(raw) {
      const account = ProviderAccountSchema.parse(raw)
      if (!account.binding) throw new DomainError('PROVIDER_ACCOUNT_BINDING_UNAVAILABLE', 'The Worker slot binding is unavailable.', 409)
      assertWorkerProviderAccountBinding(account.binding, input.current())
      const old = readRecord(path(account.id))
      if (old !== undefined) {
        const previous = ProviderAccountSchema.parse(old)
        if (!isDeepStrictEqual(previous.binding, account.binding)) throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT',
          'The previous installation owns this slot.', 409)
        if (account.removedAt && !previous.removedAt) {
          const removed = { ...previous, removedAt: account.removedAt, isDefault: false,
            revision: Math.max(previous.revision, account.revision) }
          writeRecord(path(account.id), removed)
          return removed
        }
        if (previous.binding?.profileRef === previous.id) await credentials.assertAvailable(previous.id)
        return previous
      }
      if (account.removedAt) {
        writeRecord(path(account.id), account, true)
        return account
      }
      const discovered = await native.discover(account.binding.target, account.provider)
      const capability = discovered.providers.find(value => value.provider === account.provider)
      const action = account.binding.profileRef === account.id ? 'create' : 'register'
      if (!capability?.actions.includes(action) || account.authMode !== 'subscription') {
        throw new DomainError('PROVIDER_ACCOUNT_UNQUALIFIED', 'This Worker does not qualify the requested account mode.', 409)
      }
      // The immutable binding is retained before allocating a native directory, so retries cannot adopt another slot.
      writeRecord(path(account.id), account, true)
      if (action === 'create') await credentials.create(account)
      else await native.resolveProfile(account)
      return account
    },
    async authorize(request, context) {
      if (!isDeepStrictEqual(input.current(), context.binding)) throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT',
        'The original authenticated Main connection changed.', 403)
      if ('operation' in request.request && request.request.kind === 'prepare') {
        const result = await input.request('provider-accounts-v1', {
          version: 1, kind: 'authorize', operation: request.request.operation,
        })
        if (result.bytes !== undefined || !isDeepStrictEqual(result.payload, { allowed: true })) {
          throw new DomainError('ACCESS_DENIED', 'The accepted Main operation is unavailable.', 403)
        }
      }
    },
  }
}
