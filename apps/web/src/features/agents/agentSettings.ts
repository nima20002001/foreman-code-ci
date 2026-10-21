import {
  DEFAULT_HARNESS_DEFAULTS,
  AgentHarnessSchema,
  AgentEffortSchema,
  legacyEffortForHarness,
  type Agent,
  type HarnessConfiguration,
  type HarnessDefaults,
  type AgentProductRole,
} from '@foreman-code/contracts'
import { ClaudeFullAccessConfigurationSchema } from '@foreman-code/contracts/claude'

export const STANDARD_EFFORTS: readonly NonNullable<Agent['effort']>[] = [
  'low', 'medium', 'high', 'xhigh', 'max',
]

export function initialModel(agent: Agent, harness: NonNullable<Agent['harness']>): string {
  const selectedHarness = AgentHarnessSchema.parse(harness)
  return (agent.harnessConfiguration?.harness === harness ? agent.harnessConfiguration.model
    : agent.harness === harness ? agent.model : undefined) ?? DEFAULT_HARNESS_DEFAULTS[selectedHarness]?.model ?? ''
}

export function effortOptions(
  harness: NonNullable<Agent['harness']>,
  model: string,
): readonly NonNullable<Agent['effort']>[] {
  const selectedHarness = AgentHarnessSchema.parse(harness)
  if (selectedHarness === 'claude') return []
  return model === 'gpt-6-astra' ? [...STANDARD_EFFORTS, 'ultra'] : STANDARD_EFFORTS
}

export const effortLabels: Record<NonNullable<Agent['effort']>, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
  ultra: 'Ultra',
}

export function configuredHarness(
  agent: Agent,
  harness: NonNullable<Agent['harness']>,
  model: string,
  effort: string,
  fastMode: boolean,
  sandbox: 'read-only' | 'workspace-write' | 'danger-full-access',
  creationDefaults?: HarnessDefaults,
): HarnessConfiguration {
  const selectedHarness = AgentHarnessSchema.parse(harness)
  // New agents use the selected global template; existing agents keep their
  // copied settings and must not inherit later global-default changes.
  const current = creationDefaults?.[selectedHarness]
    ?? (agent.harnessConfiguration?.harness === harness
      ? agent.harnessConfiguration
      : DEFAULT_HARNESS_DEFAULTS[selectedHarness])
  if (!current) throw new Error('Claude requires an explicitly configured host-local profile.')
  if (current.harness !== harness) throw new Error('The configuration must match the selected harness.')
  if (current.harness === 'claude') {
    return ClaudeFullAccessConfigurationSchema.parse({ ...current, model, sandbox })
  }
  if (current.harness === 'opencode') throw new Error('A retired harness cannot execute.')
  const codex = current
  return {
    ...codex,
    model,
    reasoningEffort: AgentEffortSchema.parse(effort),
    sandbox,
    serviceTier: fastMode ? 'priority' : 'standard',
  }
}

export function defaultAgentForHarness(
  harness: NonNullable<Agent['harness']>,
  id: string,
  name: string,
  configuration?: HarnessConfiguration,
  productRole?: Exclude<AgentProductRole, 'operator'>,
): Agent {
  const selectedHarness = AgentHarnessSchema.parse(harness)
  const selected = configuration ?? DEFAULT_HARNESS_DEFAULTS[selectedHarness]
  if (!selected) throw new Error('Claude requires an explicitly configured host-local profile.')
  if (selected.harness !== harness) throw new Error('The configuration must match the selected harness.')
  const exact = structuredClone(selected)
  const legacyEffort = legacyEffortForHarness(exact)
  return {
    id,
    name,
    role: 'Agent',
    ...(productRole ? { productRole, role: productRole === 'master' ? 'Master' : productRole === 'orchestrator' ? 'Orchestrator' : 'Worker' } : {}),
    harness,
    model: exact.model,
    effort: legacyEffort,
    ...(exact.harness === 'codex' ? { fastMode: exact.serviceTier === 'priority' } : {}),
    harnessConfiguration: exact,
  }
}

export function nextCoderAgentName(agents: readonly Agent[]): string {
  const highest = agents.reduce((current, agent) => {
    const match = /^coder-(\d{3,})$/i.exec(agent.name.trim())
    const number = match ? Number(match[1]) : 0
    return Number.isSafeInteger(number) ? Math.max(current, number) : current
  }, 0)
  return `coder-${String(highest + 1).padStart(3, '0')}`
}

export function nextHarnessAgentName(
  harness: NonNullable<Agent['harness']>,
  agents: readonly Agent[],
): string {
  const selectedHarness = AgentHarnessSchema.parse(harness)
  const prefix = selectedHarness
  const pattern = new RegExp(`^${prefix}-(\\d{3,})$`, 'i')
  const highest = agents.reduce((current, agent) => {
    const match = pattern.exec(agent.name.trim())
    return match ? Math.max(current, Number(match[1])) : current
  }, 0)
  return `${prefix}-${String(highest + 1).padStart(3, '0')}`
}
