import type { AgentConfigurationVersion } from '@foreman-code/contracts'
import type { WorkspaceLocationAccessMode } from '@foreman-code/contracts/management'

export function requiredLocationAccess(configurations: readonly AgentConfigurationVersion[]): WorkspaceLocationAccessMode {
  return configurations.some((configuration) => 'sandbox' in configuration.harness
    && configuration.harness.sandbox !== 'read-only') ? 'read-write' : 'read-only'
}

