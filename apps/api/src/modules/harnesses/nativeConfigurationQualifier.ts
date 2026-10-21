import type { HarnessConfiguration, HarnessQualification } from '@foreman-code/contracts'
import type { HarnessConfigurationQualifier } from './port.js'
import { NativeHarnessFactories } from './runtimeFactory.js'
import { requireClaudeProductionCredentialDelivery } from './claudeSdk/productionCredentials.js'
import type { ClaudeNativeConfigurationPort } from './claudeSdk/nativeConfiguration.js'
import type { ProviderAccountResolver } from '../provider-accounts/service.js'

/** Model-free native qualification is separate from passive installation discovery. */
export class NativeHarnessConfigurationQualifier implements HarnessConfigurationQualifier {
  private readonly factories: NativeHarnessFactories
  constructor(codexBinary: string, factories?: NativeHarnessFactories, private readonly claude?: ClaudeNativeConfigurationPort,
    private readonly accounts?: ProviderAccountResolver) {
    this.factories = factories ?? new NativeHarnessFactories({ codexBinary })
  }

  async qualify(configuration: HarnessConfiguration, workingDirectory: string, signal?: AbortSignal): Promise<HarnessQualification> {
    await requireClaudeProductionCredentialDelivery(configuration, this.accounts)
    if (configuration.harness === 'claude' && this.claude) return this.claude.qualify(configuration, workingDirectory, signal ?? AbortSignal.timeout(60_000))
    return this.factories.qualifyConfiguration(configuration, workingDirectory, signal)
  }
}
