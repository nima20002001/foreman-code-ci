import type { HarnessConfiguration } from '@foreman-code/contracts'
import { isDeepStrictEqual } from 'node:util'
import { DomainError } from '../../errors.js'
import type { ProviderAccountResolver } from '../../provider-accounts/service.js'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'

export function requireClaudeApiKey(configuration: HarnessConfiguration, apiKey?: string): string | undefined {
  if (configuration.harness !== 'claude' || configuration.authMode !== 'api-key') return undefined
  if (!apiKey?.trim()) throw new DomainError('CLAUDE_API_KEY_DELIVERY_UNAVAILABLE',
    'Select a managed Claude account with a locally provisioned API key before running this profile.', 409)
  return apiKey
}

/** Secrets are resolved locally after the immutable account configuration is checked. */
export async function requireClaudeProductionCredentialDelivery(configuration: HarnessConfiguration,
  accounts?: ProviderAccountResolver, host?: CanonicalMachineReference, applicationInstallationId?: string): Promise<string | undefined> {
  if (configuration.harness === 'opencode') return undefined
  if (host?.kind === 'device') {
    if (configuration.accountId) {
      const account = await accounts?.resolve(configuration.harness, configuration.accountId)
      if (!account) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE',
        'The selected managed provider account is unavailable.', 409)
      const binding = account.binding
      if (!binding || binding.accountId !== configuration.accountId || binding.provider !== configuration.harness
        || !isDeepStrictEqual(binding.target.hostRef, host)
        || binding.target.applicationInstallationId !== applicationInstallationId) {
        throw new DomainError('PROVIDER_ACCOUNT_TARGET_CONFLICT',
          'The selected account belongs to another computer installation.', 409)
      }
      if (configuration.harness === 'claude' && configuration.authMode !== account.authMode) {
        throw new DomainError('PROVIDER_ACCOUNT_CONFIGURATION_CONFLICT',
          'Save the selected account settings before running this Claude profile.', 409)
      }
      return undefined
    }
    requireClaudeApiKey(configuration)
    return undefined
  }
  const account = configuration.accountId ? await accounts?.resolve(configuration.harness, configuration.accountId) : null
  if (configuration.accountId && !account) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE',
    'The selected managed provider account is unavailable.', 409)
  if (configuration.harness === 'claude' && account
    && (account.accountId !== configuration.accountId || account.homePath !== configuration.configDirectory
      || account.authMode !== configuration.authMode)) {
    throw new DomainError('PROVIDER_ACCOUNT_CONFIGURATION_CONFLICT',
      'Save the selected account settings before running this Claude profile.', 409)
  }
  if (configuration.harness === 'claude' && configuration.authMode === 'api-key') {
    return requireClaudeApiKey(configuration,
      configuration.accountId && account?.authMode === 'api-key' ? account.apiKey : undefined)
  }
  return undefined
}
