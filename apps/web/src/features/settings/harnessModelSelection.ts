import { ClaudeEffortSchema, type HarnessConfiguration, type AgentEffort } from '@foreman-code/contracts'
import type { HarnessOptions } from '@foreman-code/contracts/management'

const knownEfforts = new Set<string>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])
export function supportedEfforts(model: HarnessOptions['models'][number] | undefined): AgentEffort[] {
  return (model?.reasoningEfforts ?? []).filter((effort): effort is AgentEffort => knownEfforts.has(effort))
}
export function selectNativeModel(configuration: HarnessConfiguration, model: HarnessOptions['models'][number]): HarnessConfiguration {
  if (configuration.harness === 'opencode') throw new Error('A retired harness cannot select a new model.')
  if (configuration.harness === 'claude') return { ...configuration, model: model.id,
    effort: model.reasoningEfforts.includes(configuration.effort ?? '') ? configuration.effort
      : model.reasoningEfforts.includes('medium') ? 'medium' : model.reasoningEfforts.find(effort => ClaudeEffortSchema.safeParse(effort).success) as typeof configuration.effort }
  const efforts = supportedEfforts(model)
  // No guess when a catalog has an unknown effort: validation will report the preserved selection.
  return { ...configuration, model: model.id,
    reasoningEffort: efforts.includes(configuration.reasoningEffort) ? configuration.reasoningEffort : efforts.includes('medium') ? 'medium' : efforts[0] ?? configuration.reasoningEffort,
    serviceTier: model.serviceTiers.includes(configuration.serviceTier) ? configuration.serviceTier : 'standard',
  }
}
export function nativeOptionsWithSaved(values: readonly string[], saved: string, emptyLabel = 'Native default') {
  const choices = [...new Set(values)].map((value) => ({ value, label: value || emptyLabel, disabled: false }))
  if (!choices.some((item) => item.value === saved)) choices.unshift({ value: saved, label: `${saved || emptyLabel} · saved, unavailable`, disabled: true })
  return choices
}
