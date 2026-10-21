import type { AgentConfigurationVersion, OperatorConfigurationVersion } from '@foreman-code/contracts'

/**
 * Installed-provider steering qualification for a live Agent or Operator chat owner. Codex app-server
 * owners (local or Worker-hosted) add input to the exact active turn through the protocol-qualified
 * `turn/steer` method; Claude has no expected-turn steer and uses Queue or Interrupt and send.
 */
export async function qualifiedAgentChatSteer(_row: unknown,
  configuration: Pick<AgentConfigurationVersion | OperatorConfigurationVersion, 'harness'>): Promise<boolean> {
  return configuration.harness.harness === 'codex'
}
