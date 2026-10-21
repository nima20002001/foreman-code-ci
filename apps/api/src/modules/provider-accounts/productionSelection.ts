import { realpathSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { z } from 'zod'
import { HostHarnessOverrideSchema } from '@foreman-code/contracts/harness-registry'
import { DeviceProvisioningTargetSchema, sameDeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { AccountProviderSchema, ProviderAccountProfileChoiceSchema,
  type ProviderAccountBinding, type ProviderAccountCapability, type ProviderAccountModels } from '@foreman-code/contracts/provider-accounts'
import type { RegistryHarnessSelection } from '../harnesses/installationRegistry.js'
import { readRecord } from '../harnesses/recovery/storage.js'
import { DomainError } from '../errors.js'
import type { AccountNativeSelection, ProviderAccountNativeInput } from './nativeCommands.js'

const nativePath = z.string().min(1).max(4096).refine(isAbsolute)
/** Installer-owned qualification evidence. These paths are never public account input/output. */
export const AccountIsolationQualificationSchema = z.object({
  qualificationId: z.string().min(1).max(200), provider: AccountProviderSchema,
  generation: z.number().int().safe().min(1),
  target: DeviceProvisioningTargetSchema, expiresAt: z.string().datetime(),
  isolation: z.literal(true), storage: z.enum(['provider-file', 'provider-keyring']),
  scope: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('managed-slots') }).strict(),
    z.object({ kind: z.literal('existing-profile'), choice: ProviderAccountProfileChoiceSchema,
      homePath: nativePath, userHome: nativePath }).strict(),
  ]),
  override: HostHarnessOverrideSchema,
  actions: z.array(z.enum(['status', 'models', 'sign-in', 'sign-out', 'cancel', 'human-handoff'])),
  subjectField: z.enum(['subject', 'accountId', 'userId']).optional(),
}).strict().superRefine((record, context) => {
  if (record.scope.kind !== 'existing-profile') return
  const choice = record.scope.choice
  if (choice.provider !== record.provider || choice.qualificationId !== record.qualificationId
    || choice.provider === 'codex' && choice.authMode !== 'subscription') {
    context.addIssue({ code: 'custom', message: 'The profile choice must match its provider qualification.' })
  }
})
export const AccountIsolationQualificationsSchema = z.object({ version: z.literal(1), records: z.array(AccountIsolationQualificationSchema).max(100) }).strict()
export type AccountIsolationQualification = z.infer<typeof AccountIsolationQualificationSchema>
type Qualification = AccountIsolationQualification

export function createProductionAccountSelection(input: {
  path: string
  validate?(record: Qualification): Promise<void>
  prepareProfilePaths?(record: Qualification): Promise<void>
  pin(record: Qualification): RegistryHarnessSelection
  managedPaths(accountId: string): { homePath: string; userHome: string }
  models(binding: ProviderAccountBinding, generation: number): Promise<ProviderAccountModels>
  now?: () => number
}): AccountNativeSelection & { selectAccount(binding: ProviderAccountBinding): RegistryHarnessSelection } {
  const now = input.now ?? Date.now
  const read = (): Qualification[] => {
    let raw: unknown
    try {
      if (realpathSync(input.path) !== input.path) throw new DomainError('PROVIDER_QUALIFICATION_UNSAFE',
        'The native account qualification record has a directory alias.', 409)
      raw = readRecord(input.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    if (raw === undefined) return []
    return AccountIsolationQualificationsSchema.parse(raw).records.filter(record => Date.parse(record.expiresAt) > now())
  }
  const pin = (record: Qualification) => {
    if (record.override.qualification !== 'qualified' || !record.override.enabled
      || record.override.driverId !== record.provider || record.override.configuration.harness !== record.provider
      || !sameDeviceProvisioningTarget(record.target, {
        hostRef: record.override.target.hostRef,
        applicationInstallationId: record.override.target.applicationInstallationId,
        keyRevision: record.target.keyRevision,
        authorizationRevision: record.target.authorizationRevision,
      })) throw new DomainError('PROVIDER_ACCOUNT_UNQUALIFIED', 'The account isolation proof names another profile.', 409)
    if (record.scope.kind === 'existing-profile' && record.scope.choice.authMode !== 'subscription') {
      throw new DomainError('PROVIDER_PROFILE_AUTH_MODE_UNSUPPORTED',
        'Existing API-key profiles retain their explicit credential delivery flow.', 409)
    }
    return input.pin(record)
  }
  const findRecord = (binding: ProviderAccountBinding): Qualification => {
    const record = read().find(value => value.provider === binding.provider
      && sameDeviceProvisioningTarget(value.target, binding.target)
      && (value.scope.kind === 'managed-slots' ? binding.profileRef === binding.accountId
        : value.scope.choice.profileRef === binding.profileRef))
    if (!record) throw new DomainError('PROVIDER_ACCOUNT_UNQUALIFIED',
      'This account has no current provider storage-isolation qualification.', 409)
    return record
  }
  const paths = (record: Qualification, binding: ProviderAccountBinding) => record.scope.kind === 'managed-slots'
    ? input.managedPaths(binding.accountId) : { homePath: record.scope.homePath, userHome: record.scope.userHome }
  return {
    selectAccount: binding => pin(findRecord(binding)),
    async selected(native: ProviderAccountNativeInput) {
      if (!native.account.binding) return null
      const binding = native.account.binding
      const record = findRecord(binding)
      await input.validate?.(record)
      const selected = pin(record)
      const binary = selected.installation.launcher.resolvedLauncher
      const profile = paths(record, binding)
      if (!binary || !isDeepStrictEqual(profile, { homePath: native.homePath, userHome: native.userHome })) return null
      return { binding, binary, profilePath: profile.homePath, qualificationId: record.qualificationId,
        generation: record.generation, isolation: true, status: record.actions.includes('status'),
        login: record.actions.includes('sign-in'), logout: record.actions.includes('sign-out'),
        ...(record.subjectField ? { subjectField: record.subjectField } : {}) }
    },
    async discover(target, provider) {
      const records = read().filter(value => sameDeviceProvisioningTarget(value.target, target)
        && (!provider || value.provider === provider))
      const usable: Qualification[] = []
      let generation = 1
      for (const record of records) {
        try {
          await input.validate?.(record)
          pin(record)
          generation = Math.max(generation, record.generation)
          usable.push(record)
        } catch (error) {
          if (!(error instanceof DomainError)) throw error
        }
      }
      const providers: ProviderAccountCapability[] = (provider ? [provider] : ['codex', 'claude'] as const).map(value => {
        const rows = usable.filter(record => record.provider === value)
        const actions = new Set<ProviderAccountCapability['actions'][number]>(rows.flatMap(record => record.actions))
        if (rows.some(record => record.scope.kind === 'managed-slots')) actions.add('create')
        if (rows.some(record => record.scope.kind === 'existing-profile')) actions.add('register')
        return { provider: value, actions: [...actions], qualified: rows.length > 0,
          reason: rows.length ? null : 'Provider storage isolation is not qualified for this installation.' }
      })
      return { providers, generation, profiles: usable.flatMap(record =>
        record.scope.kind === 'existing-profile' ? [record.scope.choice] : []) }
    },
    async registerProfile(request) {
      const record = read().find(value => value.provider === request.provider
        && sameDeviceProvisioningTarget(value.target, request.target)
        && value.scope.kind === 'existing-profile' && value.scope.choice.profileRef === request.profileRef
        && value.qualificationId === request.qualificationId
        && value.scope.choice.qualificationId === request.qualificationId
        && (!request.authMode || value.scope.choice.authMode === request.authMode))
      if (!record) throw new DomainError('PROVIDER_PROFILE_UNQUALIFIED', 'The selected native profile is no longer qualified.', 409)
      await input.validate?.(record)
      pin(record)
      return { profileRef: request.profileRef }
    },
    async resolveProfile(account) {
      if (!account.binding) throw new DomainError('PROVIDER_PROFILE_UNAVAILABLE', 'The saved profile is unavailable.', 409)
      const record = findRecord(account.binding)
      // Worker path reads initialize local inventory; Main path reads also run in transactions.
      await input.prepareProfilePaths?.(record)
      pin(record)
      return { binding: account.binding, ...paths(record, account.binding) }
    },
    async models(native) {
      if (!native.account.binding) throw new DomainError('PROVIDER_MODELS_UNAVAILABLE', 'The saved account is unavailable.', 409)
      const record = findRecord(native.account.binding)
      await input.validate?.(record)
      pin(record)
      if (!record.actions.includes('models')) throw new DomainError('PROVIDER_MODELS_UNAVAILABLE',
        'The installed CLI has no qualified account model discovery.', 409)
      const result = await input.models(native.account.binding, record.generation)
      if (!isDeepStrictEqual(record, findRecord(native.account.binding))) {
        throw new DomainError('PROVIDER_OBSERVATION_STALE', 'Account qualification changed during model discovery.', 409)
      }
      return result
    },
    async humanHandoff(native) {
      const record = findRecord(native.operation.binding)
      await input.validate?.(record)
      pin(record)
      if (!record.actions.includes('human-handoff')) throw new DomainError('PROVIDER_HANDOFF_UNAVAILABLE',
        'The installed CLI has no qualified browser handoff.', 409)
      return { operationId: native.operation.id, kind: 'local-browser', expiresAt: native.operation.expiresAt,
        message: 'Complete sign-in in the provider browser on the owning computer, then recheck this operation.' }
    },
  }
}
