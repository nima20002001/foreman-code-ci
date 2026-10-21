import type { WorkerNativeOutputAuthorizationPort } from '../placement/workerMcpRelay.js'
import type { PostgresArtifactPublicationAuthority } from '../runs/remote/nativeArtifactAuthority.js'
import type { InstalledMainRsyncProviders } from '../byte-transfer/productionComposition.js'
import type { MainRsyncEntrypoint } from '../byte-transfer/installedEntrypoints.js'
import type { AcceptedClaudeProfileAdmission, AcceptedProfileAuthority } from './instanceSettings/acceptedProfile.js'
import type { ClaudeProfileOwner } from './claudeSdk/production.js'
import type { ProductionJobInfrastructure } from '../jobs/production.js'
import type { ClaudeFileSdk } from '../files/claude/server.js'
import type { ProductionHarnessRegistry } from './productionRegistry.js'
import type { productionClaudeManager } from './claudeSdk/production.js'
import type { CompatibilityOptions } from './compatibility/service.js'
import type { CodexPluginAdapter } from './codexPlugins.js'
import type { NativeMcpAdapter } from './nativeMcpCommon.js'
import type { runCommand } from './process.js'
import type { NativeFactoryInfrastructure } from './runtimeFactory.js'
import type { HarnessInstallationRegistry, RegistryHarnessSelection } from './installationRegistry.js'
import type { QualificationSuiteInput } from './qualification/types.js'
import type { NativeProcessRegistry } from './recovery/processRegistry.js'
import type { DeviceListenerConfig } from '../devices/productionConfig.js'
import type { DeviceDomainComposition } from '../devices/productionRuntime.js'
import type { discoverLauncher } from './hostDiscovery.js'
import type { passiveDriverPayloads } from './payloadDiscovery.js'

/** Settings/probes are separate privileges from native turn execution. A replay
 * must supply these ports even when its scenario does not exercise them. */
export interface AuxiliaryHarnessInfrastructure {
  recovery: Pick<NativeProcessRegistry, 'scope' | 'reserveLaunch' | 'abandonReservedLaunch' | 'closeOwner'>
  compatibility: CompatibilityOptions
  plugins: CodexPluginAdapter
  mcp: { codex: NativeMcpAdapter }
  command: typeof runCommand
}
export type ProductionHarnessInfrastructure = NativeFactoryInfrastructure & {
  closeInfrastructure?: () => Promise<void>
  /** Concrete role-authorized profile admission and below-adapter replay client. */
  claudeProfiles?: AcceptedClaudeProfileAdmission<ClaudeProfileOwner>
  /** Genuine installed SDK/CLI pin producer; never derived from stored proof. */
  claudeCurrentProfile?: AcceptedProfileAuthority<ClaudeProfileOwner>['current']
  claudeClient?: Parameters<typeof productionClaudeManager>[0]['loadClient']
  claudeFileSdk?: () => Promise<ClaudeFileSdk>
  /** Complete protected original transfer ports; absent means the existing byte carrier. */
  rsync?: InstalledMainRsyncProviders
  rsyncInstallation?: MainRsyncEntrypoint
  /** Root supplies original accepted context resolution; omission keeps native
   * output authorization unavailable on the existing authenticated MCP relay. */
  nativeOutputAuthorization?: (authority: PostgresArtifactPublicationAuthority) => WorkerNativeOutputAuthorizationPort
  jobs?: ProductionJobInfrastructure
  deviceListener?: DeviceListenerConfig
  deviceDomains?: DeviceDomainComposition
  installationRefreshIntervalMs?: number
  inventoryDiscovery?: { launcher: typeof discoverLauncher; payloads: typeof passiveDriverPayloads; claude?: NonNullable<NonNullable<ConstructorParameters<typeof ProductionHarnessRegistry>[6]>['claude']> }
  qualificationIdentity?: {
    registry: HarnessInstallationRegistry
    pin: (harness: 'codex', input: QualificationSuiteInput) => RegistryHarnessSelection
  }
} & (
  | { mode: 'native'; auxiliary?: AuxiliaryHarnessInfrastructure }
  | { mode: 'replay'; auxiliary: AuxiliaryHarnessInfrastructure }
)
