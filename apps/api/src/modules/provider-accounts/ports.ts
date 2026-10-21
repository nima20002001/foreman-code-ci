import type {
  AccountProvider, ProviderAccount, ProviderAccountAuthMode,
  AcceptedProviderAccountBinding, ProviderAccountBinding, ProviderAccountAuthenticationOperation,
  ProviderAccountNativeAuthenticationObservation, ProviderAccountObservation, ProviderAccountModels, ProviderAccountCapability, ProviderAccountProfileChoice,
  ProviderAccountHumanHandoff,
} from '@foreman-code/contracts/provider-accounts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { GraphSqlClient } from '../run-graph/connection.js'
import type { LocalProviderCredentials } from './localCredentials.js'
import type { ProviderAccountNativeInput, ProviderAccountNativePort } from './nativeCommands.js'

export interface ResolvedProviderAccount {
  accountId: string
  homePath: string
  authMode: ProviderAccountAuthMode
  apiKey?: string
  binding?: ProviderAccountBinding
  observation?: ProviderAccountObservation
}
export interface ProviderAccountResolver {
  resolve(provider: AccountProvider, accountId?: string,
    options?: { sql?: GraphSqlClient; allowDefault?: boolean; signal?: AbortSignal;
      acceptedBinding?: AcceptedProviderAccountBinding }): Promise<ResolvedProviderAccount | null>
}
/** Native paths stay inside the owning host; only sanitized observations cross this port. */
export interface ProviderAccountOperationNativePort extends ProviderAccountNativePort {
  discover?(target: DeviceProvisioningTarget, provider?: AccountProvider): Promise<{
    providers: ProviderAccountCapability[]; profiles: ProviderAccountProfileChoice[]; generation: number
  }>
  humanHandoff?(input: ProviderAccountNativeInput & { operation: ProviderAccountAuthenticationOperation }):
    Promise<ProviderAccountHumanHandoff>
  provisionAccount?(account: ProviderAccount): Promise<void>
  prepareAuthentication?(input: ProviderAccountNativeInput & {
    operation: ProviderAccountAuthenticationOperation;
  }): Promise<ProviderAccountNativeAuthenticationObservation>
  observeAuthentication?(input: ProviderAccountNativeInput & {
    operation: ProviderAccountAuthenticationOperation;
  }): Promise<ProviderAccountNativeAuthenticationObservation>
  cancelAuthentication?(input: ProviderAccountNativeInput & {
    operation: ProviderAccountAuthenticationOperation;
  }): Promise<ProviderAccountNativeAuthenticationObservation>
  registerProfile?(input: { provider: AccountProvider; authMode?: ProviderAccountAuthMode | undefined; profileRef: string; qualificationId: string;
    target: DeviceProvisioningTarget }): Promise<{ profileRef: string }>
  observeAccount?(input: ProviderAccountNativeInput): Promise<ProviderAccountObservation>
  models?(input: ProviderAccountNativeInput): Promise<ProviderAccountModels>
  authenticationGeneration?(input: ProviderAccountNativeInput): Promise<number>
  requireRuntimeAccount?(input: ProviderAccountNativeInput): Promise<void>
  resolveProfile?(account: ProviderAccount): Promise<{ homePath: string; userHome: string }>
}
export type ProviderAccountCredentials = Pick<LocalProviderCredentials, 'paths' | 'create' | 'assertAvailable'
  | 'apiKey' | 'backup' | 'saveApiKey' | 'restore' | 'clearApiKey' | 'removeCreatedHome'>
