import type { HarnessConfiguration } from '@foreman-code/contracts'
import type { HarnessProfileSelection } from '@foreman-code/contracts/harness-registry'
import type { ProviderAccountResolver } from '../provider-accounts/service.js'
import { DomainError } from '../errors.js'
import type { HostHarnessOverrideService } from './instanceSettings/service.js'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type pg from 'pg'
import type { GraphSqlClient } from '../run-graph/connection.js'
import { withTransaction } from '../../infrastructure/transaction.js'
export { managedProviderEnvironment, pinnedCodexAccountEnvironment } from './providerAccountRuntime.js'
import { AcceptedProviderAccountBindings } from '../provider-accounts/acceptedBindings.js'

export class ProviderAccountConfigurationService {
  readonly acceptedBindings: AcceptedProviderAccountBindings
  private profiles?: Pick<HostHarnessOverrideService,
    'selectionForConfiguration' | 'prepareOperatorConfiguration' | 'validateSelection'>
  constructor(private readonly accounts: ProviderAccountResolver) {
    this.acceptedBindings = new AcceptedProviderAccountBindings(accounts)
  }

  bindProfiles(profiles: Pick<HostHarnessOverrideService,
    'selectionForConfiguration' | 'prepareOperatorConfiguration' | 'validateSelection'>): void {
    this.profiles = profiles
  }

  async prepareProfile(input: { principal: ManagementPrincipal; source: 'http' | 'mcp';
    configuration: HarnessConfiguration; selection?: HarnessProfileSelection | undefined;
    commandId: string; pool: pg.Pool }) {
    const prepared = await withTransaction(input.pool, async client => {
      const configuration = await this.resolve(input.configuration, input.selection, { sql: client })
      try {
        const selection = await this.profile({ ...input, configuration, client })
        return { configuration, selection }
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'HARNESS_PROFILE_UNAVAILABLE') throw error
        return { configuration, selection: undefined }
      }
    })
    if (prepared.configuration.harness === 'claude' && prepared.configuration.accountId && !prepared.selection) {
      prepared.selection = await this.profiles!.prepareOperatorConfiguration(input.principal, input.source,
        prepared.configuration, input.commandId)
    }
    return prepared
  }

  async profile(input: { principal: ManagementPrincipal; source: 'http' | 'mcp'; configuration: HarnessConfiguration;
    selection?: HarnessProfileSelection | undefined; commandId: string; client: pg.PoolClient; check?: boolean }): Promise<HarnessProfileSelection | undefined> {
    if (input.configuration.harness !== 'claude' || !input.configuration.accountId) return input.selection
    if (!this.profiles) throw new DomainError('HARNESS_PROFILE_SELECTION_UNAVAILABLE',
      'Managed Claude accounts require local harness profile setup.', 503)
    if (input.selection?.target.hostRef.kind === 'device') {
      await this.resolve(input.configuration, input.selection, { sql: input.client })
      await this.profiles.validateSelection(input.principal, input.selection, input.configuration, input.client)
      return input.selection
    }
    const selected = await this.profiles.selectionForConfiguration(input.principal, input.configuration, input.client)
    if (selected) return selected
    if (input.check) return this.profiles.prepareOperatorConfiguration(input.principal, input.source,
      input.configuration, input.commandId)
    throw new DomainError('HARNESS_PROFILE_UNAVAILABLE',
      'Save and check a local harness profile for this Claude account before saving the Agent.', 409)
  }

  async resolve(configuration: HarnessConfiguration, selection?: HarnessProfileSelection,
    options?: { sql: GraphSqlClient }): Promise<HarnessConfiguration> {
    if (configuration.harness === 'opencode') return configuration
    if (!configuration.accountId && (selection || configuration.harness === 'claude')) return configuration
    const account = await this.accounts.resolve(configuration.harness, configuration.accountId, options)
    if (!account) return configuration
    if (selection?.target.hostRef.kind === 'device' && account.binding?.target.hostRef.kind !== 'device') {
      throw new DomainError('PROVIDER_ACCOUNT_LOCAL_ONLY',
        'Select an account owned by the selected Worker installation.', 409)
    }
    if (account.binding?.target.hostRef.kind === 'device') {
      if (selection?.target.hostRef.kind !== 'device'
        || selection.target.hostRef.mainId !== account.binding.target.hostRef.mainId
        || selection.target.hostRef.deviceId !== account.binding.target.hostRef.deviceId
        || selection.target.applicationInstallationId !== account.binding.target.applicationInstallationId) {
        throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT', 'Select the qualified profile on the owning Worker.', 409)
      }
      return { ...configuration, accountId: account.accountId }
    }
    if (configuration.harness === 'claude') {
      return { ...configuration, accountId: account.accountId,
        configDirectory: account.homePath, authMode: account.authMode }
    }
    return { ...configuration, accountId: account.accountId }
  }
}

export function harnessSessionChanged(left: HarnessConfiguration, right: HarnessConfiguration): boolean {
  if (left.harness !== right.harness) return true
  if (left.harness === 'opencode' || right.harness === 'opencode') return false
  return left.accountId !== right.accountId
}
