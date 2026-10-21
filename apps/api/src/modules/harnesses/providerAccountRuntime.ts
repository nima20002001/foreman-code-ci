import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { AcceptedProviderAccountBindingSchema, ProviderAccountIdSchema } from '@foreman-code/contracts/provider-accounts'
import type { AcceptedProviderAccountBinding, AccountProvider } from '@foreman-code/contracts/provider-accounts'
import type { ProviderAccountResolver, ResolvedProviderAccount } from '../provider-accounts/service.js'
import { providerAccountEnvironment } from '../provider-accounts/environment.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'
import { readRecord, recordObject, writeRecord } from './recovery/storage.js'
import { DomainError } from '../errors.js'

interface RuntimeAccountRecord {
  accountId: string | null
  homePath?: string
  authMode?: ResolvedProviderAccount['authMode']
  binding?: AcceptedProviderAccountBinding
}

function pinnedAccount(value: unknown, provider: AccountProvider, owner: string): RuntimeAccountRecord {
  const record = recordObject(value)
  if ((record.format !== 1 && record.format !== 2) || record.provider !== provider || record.owner !== owner
    || record.accountId !== null && !ProviderAccountIdSchema.safeParse(record.accountId).success) {
    throw new DomainError('PROVIDER_ACCOUNT_BINDING_INVALID', 'The saved runtime account selection is invalid.', 409)
  }
  if (record.format === 2 && record.accountId !== null
    && (typeof record.homePath !== 'string' || !['subscription', 'api-key'].includes(String(record.authMode)))) {
    throw new DomainError('PROVIDER_ACCOUNT_BINDING_INVALID', 'The saved runtime account profile is invalid.', 409)
  }
  if (record.binding !== undefined) {
    const binding = AcceptedProviderAccountBindingSchema.parse(record.binding)
    if (binding.provider !== provider || (binding.accountId ?? null) !== record.accountId) conflict()
  }
  return record as unknown as RuntimeAccountRecord
}

function bindingPath(provider: AccountProvider, recovery: NativeProcessRecovery): string {
  const registryRoot = resolve(recovery.root)
  const key = createHash('sha256').update(JSON.stringify([registryRoot, provider, recovery.owner])).digest('hex')
  return join(dirname(registryRoot), 'provider-account-bindings', `${key}.json`)
}

export function assertRuntimeProviderAccountProfile(binding: AcceptedProviderAccountBinding | undefined,
  profile: HarnessProfileSelection['target']): void {
  const target = binding?.target
  if (!target) return
  if (!isDeepStrictEqual(target.hostRef, profile.hostRef)
    || target.applicationInstallationId !== profile.applicationInstallationId) {
    throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The accepted native profile belongs to another account installation.', 409)
  }
}

function conflict(): never {
  throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The account differs from the accepted session account.', 409)
}

async function selectedAccount(accounts: ProviderAccountResolver | undefined, provider: AccountProvider,
  saved: RuntimeAccountRecord): Promise<ResolvedProviderAccount | null> {
  if (saved.accountId === null) return null
  if (!accounts) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'The saved provider account is unavailable.', 503)
  const account = await accounts.resolve(provider, saved.accountId, {
    allowDefault: false, ...(saved.binding ? { acceptedBinding: saved.binding } : {}),
  })
  if (!account || account.accountId !== saved.accountId || resolve(account.homePath) !== account.homePath) {
    throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE', 'The saved provider account is unavailable.', 409)
  }
  if (saved.homePath !== undefined && (saved.homePath !== account.homePath || saved.authMode !== account.authMode)) {
    conflict()
  }
  if (saved.binding?.kind === 'slot' && !isDeepStrictEqual(saved.binding, account.binding)) conflict()
  return account
}

/** Sidecars record native readback; only an accepted selection can choose a managed account. */
export async function resolveRuntimeProviderAccount(accounts: ProviderAccountResolver | undefined,
  provider: AccountProvider, accountId?: string, recovery?: NativeProcessRecovery,
  sourceRecovery?: NativeProcessRecovery,
  binding?: AcceptedProviderAccountBinding): Promise<ResolvedProviderAccount | null> {
  if (accountId !== undefined) ProviderAccountIdSchema.parse(accountId)
  if (binding) {
    binding = AcceptedProviderAccountBindingSchema.parse(binding)
    if (binding.provider !== provider) conflict()
    if (accountId !== undefined && binding.accountId !== accountId) conflict()
  }
  const storedValue = recovery ? readRecord(bindingPath(provider, recovery)) : undefined
  const stored = storedValue === undefined ? undefined : pinnedAccount(storedValue, provider, recovery!.owner)
  const sourceValue = sourceRecovery ? readRecord(bindingPath(provider, sourceRecovery)) : undefined
  let source: RuntimeAccountRecord | undefined
  if (sourceRecovery) {
    if (sourceValue !== undefined) source = pinnedAccount(sourceValue, provider, sourceRecovery.owner)
    else if (binding) source = { accountId: binding.accountId ?? null, binding }
    else source = { accountId: null }
  }
  if (stored && source && (stored.accountId !== source.accountId
    || stored.binding && source.binding && !isDeepStrictEqual(stored.binding, source.binding)
    || stored.homePath !== undefined && source.homePath !== undefined && !isDeepStrictEqual(
      [stored.homePath, stored.authMode], [source.homePath, source.authMode]))) conflict()
  const accepted = stored ?? source
  if (binding?.kind === 'legacy-profile' && !binding.accountId && accepted?.accountId && !accepted.binding) {
    binding = { ...binding, accountId: accepted.accountId }
  }
  if (accountId !== undefined && accepted && accountId !== accepted.accountId) conflict()
  if (binding && accepted) {
    const bindingId = binding.accountId ?? null
    if (accepted.accountId !== bindingId || accepted.binding && !isDeepStrictEqual(accepted.binding, binding)) conflict()
  }
  const selection: RuntimeAccountRecord = accepted ?? { accountId: binding?.accountId ?? accountId ?? null }
  if (binding) selection.binding = binding
  const selected = await selectedAccount(accounts, provider, selection)
  if (!recovery || stored || !selected && !binding) return selected
  const record = { format: 2, provider, owner: recovery.owner, accountId: selected?.accountId ?? null,
    ...(selected ? { homePath: selected.homePath, authMode: selected.authMode } : {}),
    ...((binding ?? selected?.binding) ? { binding: binding ?? selected?.binding } : {}) }
  try {
    writeRecord(bindingPath(provider, recovery), record, true)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const prior = pinnedAccount(readRecord(bindingPath(provider, recovery)), provider, recovery.owner)
    if (prior.accountId !== selection.accountId) conflict()
    return selectedAccount(accounts, provider, prior)
  }
  return selected
}

export function managedProviderEnvironment(source: NodeJS.ProcessEnv, account: ResolvedProviderAccount,
  provider: AccountProvider): NodeJS.ProcessEnv {
  const selected = providerAccountEnvironment(provider, account.homePath, dirname(account.homePath), source)
  if (provider === 'claude' && account.authMode === 'api-key') {
    if (!account.apiKey) throw new DomainError('CLAUDE_API_KEY_REQUIRED', 'The selected account has no API key.', 409)
    selected.ANTHROPIC_API_KEY = account.apiKey
  }
  return selected
}

export function pinnedCodexAccountEnvironment(accounts: ProviderAccountResolver | undefined, accountId: string | undefined,
  recovery?: NativeProcessRecovery, sourceRecovery?: NativeProcessRecovery,
  binding?: AcceptedProviderAccountBinding) {
  binding = binding ? AcceptedProviderAccountBindingSchema.parse(binding) : undefined
  let selected: ResolvedProviderAccount | null | undefined
  let pending: Promise<void> | undefined
  return {
    prepare(): Promise<void> {
      pending ??= Promise.resolve().then(async () => {
        const resolved = await resolveRuntimeProviderAccount(accounts, 'codex', accountId, recovery, sourceRecovery, binding)
        selected = resolved ? structuredClone(resolved) : null
      })
      return pending
    },
    async revalidate(): Promise<void> {
      if (pending) await pending
      if (selected === undefined) throw new DomainError('PROVIDER_ACCOUNT_NOT_RESOLVED',
        'Resolve the selected account before starting the harness.', 500)
      if (selected) {
        await selectedAccount(accounts, 'codex', { accountId: selected.accountId, homePath: selected.homePath,
          authMode: selected.authMode, ...((binding ?? selected.binding) ? { binding: binding ?? selected.binding } : {}) })
      }
    },
    environment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
      if (selected === undefined) throw new DomainError('PROVIDER_ACCOUNT_NOT_RESOLVED',
        'Resolve the selected account before starting the harness.', 500)
      return selected ? managedProviderEnvironment(source, selected, 'codex') : source
    },
  }
}
