import { isDeepStrictEqual } from 'node:util'
import type { HarnessConfiguration } from '@foreman-code/contracts'
import { AcceptedProviderAccountBindingSchema, type AcceptedProviderAccountBinding,
  type ProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import { canonicalGraphJson } from '@foreman-code/contracts/wave25'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import type { ProviderAccountResolver } from './ports.js'

export type AccountBindingOwner = 'run-node' | 'operator-command' | 'agent-conversation'
type AcceptanceOptions = {
  source?: AcceptedProviderAccountBinding | undefined
  prepared?: AcceptedProviderAccountBinding | undefined
}
export interface AccountBindingAcceptance {
  id: string
  configuration: HarnessConfiguration
  selection?: HarnessProfileSelection | undefined
  options?: AcceptanceOptions | undefined
}

export function legacyProviderAccountBinding(configuration: HarnessConfiguration,
  selection?: HarnessProfileSelection): AcceptedProviderAccountBinding | undefined {
  if (configuration.harness === 'opencode') return undefined
  return { kind: 'legacy-profile', provider: configuration.harness, target: selection?.target.hostRef.kind === 'main' ? {
    hostRef: selection.target.hostRef, applicationInstallationId: selection.target.applicationInstallationId,
    keyRevision: null, authorizationRevision: null,
  } : null, profileRef: selection?.instanceId ?? null, historicalSubject: 'unknown',
  ...(configuration.accountId ? { accountId: configuration.accountId } : {}) }
}

export async function readProviderAccountBinding(sql: GraphSqlClient, kind: AccountBindingOwner,
  id: string): Promise<AcceptedProviderAccountBinding | undefined> {
  const row = (await sql.query<{ binding: unknown }>(
    'select binding from provider_account_accepted_bindings where owner_kind=$1 and owner_id=$2',
    [kind, id])).rows[0]
  return row ? AcceptedProviderAccountBindingSchema.parse(row.binding) : undefined
}

export async function saveProviderAccountBinding(sql: GraphSqlClient, kind: AccountBindingOwner,
  id: string, binding: AcceptedProviderAccountBinding): Promise<AcceptedProviderAccountBinding> {
  const parsed = AcceptedProviderAccountBindingSchema.parse(binding)
  await sql.query(`insert into provider_account_accepted_bindings(owner_kind,owner_id,binding,account_id)
    values($1,$2,$3::jsonb,$4) on conflict(owner_kind,owner_id) do nothing`,
  [kind, id, JSON.stringify(parsed), parsed.accountId ?? null])
  const stored = await readProviderAccountBinding(sql, kind, id)
  if (!isDeepStrictEqual(parsed, stored)) {
    throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'Accepted work already uses another account/profile.', 409)
  }
  return parsed
}

export function assertAccountConfiguration(binding: ProviderAccountBinding, configuration: HarnessConfiguration,
  selection?: HarnessProfileSelection): void {
  if (binding.provider !== configuration.harness
    || ('accountId' in configuration && configuration.accountId && configuration.accountId !== binding.accountId)) {
    throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The saved configuration names another account.', 409)
  }
  if (selection && (selection.target.hostRef.mainId !== binding.target.hostRef.mainId
    || selection.target.hostRef.kind !== binding.target.hostRef.kind
    || selection.target.applicationInstallationId !== binding.target.applicationInstallationId
    || (selection.target.hostRef.kind === 'device' && binding.target.hostRef.kind === 'device'
      && selection.target.hostRef.deviceId !== binding.target.hostRef.deviceId))) {
    throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'The account belongs to another installation.', 409)
  }
}

export class AcceptedProviderAccountBindings {
  constructor(private readonly accounts: ProviderAccountResolver) {}

  async prepare(configuration: HarnessConfiguration, selection?: HarnessProfileSelection,
    options: { signal?: AbortSignal } = {}) {
    options.signal?.throwIfAborted()
    if (configuration.harness === 'opencode') return undefined
    if (!configuration.accountId) return legacyProviderAccountBinding(configuration, selection)
    const selected = await this.accounts.resolve(configuration.harness, configuration.accountId, { allowDefault: false, ...options })
    options.signal?.throwIfAborted()
    if (!selected?.binding) throw new DomainError('PROVIDER_ACCOUNT_BINDING_UNAVAILABLE',
      'The selected account has no qualified binding.', 409)
    if (selected.observation && selected.observation.status !== 'signed-in') {
      throw new DomainError('PROVIDER_ACCOUNT_SIGN_IN_REQUIRED', 'Sign in to the selected account before accepting work.', 409)
    }
    assertAccountConfiguration(selected.binding, configuration, selection)
    if (configuration.harness === 'claude' && selected.binding.target.hostRef.kind === 'device'
      && (!selection || configuration.authMode !== selected.authMode)) {
      throw new DomainError('HARNESS_PROFILE_SELECTION_REQUIRED', 'Select the qualified Claude profile on the owning Worker.', 409)
    }
    if (configuration.harness === 'claude' && selected.binding.target.hostRef.kind === 'main'
      && (configuration.configDirectory !== selected.homePath
      || configuration.authMode !== selected.authMode)) throw new DomainError('HARNESS_PROFILE_SELECTION_REQUIRED',
      'Select and qualify a Claude profile for this account before starting work.', 409)
    return selected.binding
  }

  async accept(sql: GraphSqlClient, kind: AccountBindingOwner, id: string,
    configuration: HarnessConfiguration, selection?: HarnessProfileSelection,
    options: AcceptanceOptions = {}): Promise<AcceptedProviderAccountBinding | undefined> {
    const prior = await readProviderAccountBinding(sql, kind, id)
    if (prior) return prior
    const binding = await this.resolveAccepted(sql, configuration, selection, options)
    return binding ? saveProviderAccountBinding(sql, kind, id, binding) : undefined
  }

  async acceptMany(sql: GraphSqlClient, kind: AccountBindingOwner,
    entries: readonly AccountBindingAcceptance[]): Promise<Map<string, AcceptedProviderAccountBinding>> {
    const read = async () => {
      const rows = await sql.query<{ owner_id: string; binding: unknown }>(
        'select owner_id,binding from provider_account_accepted_bindings where owner_kind=$1 and owner_id=any($2::text[])',
        [kind, entries.map(entry => entry.id)])
      return new Map(rows.rows.map(row => [row.owner_id, AcceptedProviderAccountBindingSchema.parse(row.binding)]))
    }
    const bindings = await read()
    const resolved = new Map<string, AcceptedProviderAccountBinding | undefined>()
    const inserts: { id: string; binding: AcceptedProviderAccountBinding }[] = []
    for (const entry of entries) {
      if (bindings.has(entry.id)) continue
      const key = canonicalGraphJson({ configuration: entry.configuration,
        selection: entry.selection ?? null, source: entry.options?.source ?? null,
        prepared: entry.options?.prepared ?? null })
      if (!resolved.has(key)) {
        resolved.set(key, await this.resolveAccepted(sql, entry.configuration, entry.selection, entry.options))
      }
      const binding = resolved.get(key)
      if (!binding) continue
      const parsed = AcceptedProviderAccountBindingSchema.parse(binding)
      bindings.set(entry.id, parsed)
      inserts.push({ id: entry.id, binding: parsed })
    }
    if (!inserts.length) return bindings
    await sql.query(`insert into provider_account_accepted_bindings(owner_kind,owner_id,binding,account_id)
      select $1,b.owner_id,b.binding::jsonb,b.account_id
      from unnest($2::text[],$3::text[],$4::uuid[]) with ordinality as b(owner_id,binding,account_id,ordinal)
      order by b.ordinal on conflict(owner_kind,owner_id) do nothing`,
    [kind, inserts.map(entry => entry.id), inserts.map(entry => JSON.stringify(entry.binding)),
      inserts.map(entry => entry.binding.accountId ?? null)])
    const stored = await read()
    for (const entry of inserts) {
      if (!isDeepStrictEqual(entry.binding, stored.get(entry.id))) {
        throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'Accepted work already uses another account/profile.', 409)
      }
    }
    return bindings
  }

  private async resolveAccepted(sql: GraphSqlClient, configuration: HarnessConfiguration,
    selection?: HarnessProfileSelection, { source, prepared }: AcceptanceOptions = {}) {
    if (configuration.harness === 'opencode') return undefined
    if (source) {
      if (source.provider !== configuration.harness) {
        throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The source belongs to another provider.', 409)
      }
      if (source.kind === 'slot') {
        assertAccountConfiguration(source, configuration, selection)
        await this.accounts.resolve(configuration.harness, source.accountId, { sql, allowDefault: false,
          acceptedBinding: source })
      } else if (configuration.accountId && configuration.accountId !== source.accountId) {
        throw new DomainError('PROVIDER_ACCOUNT_BINDING_CONFLICT', 'The source uses an original native profile.', 409)
      }
      return source
    }
    if (!configuration.accountId) {
      return legacyProviderAccountBinding(configuration, selection)
    }
    const selected = await this.accounts.resolve(configuration.harness, configuration.accountId,
      { sql, allowDefault: false, ...(prepared ? { acceptedBinding: prepared } : {}) })
    if (!selected?.binding) {
      throw new DomainError('PROVIDER_ACCOUNT_BINDING_UNAVAILABLE', 'The selected account has no canonical binding.', 409)
    }
    assertAccountConfiguration(selected.binding, configuration, selection)
    if (configuration.harness === 'claude' && selected.binding.target.hostRef.kind === 'device'
      && (!selection || configuration.authMode !== selected.authMode)) {
      throw new DomainError('HARNESS_PROFILE_SELECTION_REQUIRED', 'Select the qualified Claude profile on the owning Worker.', 409)
    }
    if (configuration.harness === 'claude' && selected.binding.target.hostRef.kind === 'main'
      && (configuration.configDirectory !== selected.homePath
      || configuration.authMode !== selected.authMode)) {
      throw new DomainError('HARNESS_PROFILE_SELECTION_REQUIRED',
        'Select and qualify a Claude profile for this account before starting work.', 409)
    }
    return selected.binding
  }
}
