import { AgentEffortSchema, ClaudeEffortSchema, RETIRED_OPENCODE_MESSAGE, type HarnessConfiguration } from '@foreman-code/contracts'
import type { HarnessOptions } from '@foreman-code/contracts/management'
import { DomainError } from '../errors.js'

/** Recency comes from provider release metadata; preference comes from its
 * ranked native catalog. IDs and display labels never establish recency. */
export function latestNativeModel(options: HarnessOptions): HarnessOptions['models'][number] {
  if (!options.authenticated || !options.models.length) throw new DomainError('HARNESS_MODEL_UNAVAILABLE',
    'The installed harness has no authenticated selectable model.', 409)
  const models = options.models
  const dated = models.filter(model => model.releasedAt && Number.isFinite(Date.parse(model.releasedAt)))
  if (dated.length) return dated.reduce((latest, model) => Date.parse(model.releasedAt!) > Date.parse(latest.releasedAt!) ? model : latest)
  const ranked = models.filter(model => model.defaultPriority !== undefined)
  if (ranked.length) return ranked.reduce((preferred, model) => model.defaultPriority! < preferred.defaultPriority! ? model : preferred)
  throw new DomainError('HARNESS_MODEL_DEFAULT_UNAVAILABLE', 'The native catalog supplies no release date or default model preference.', 409)
}

export function nativeModelDefaults<T extends HarnessConfiguration>(configuration: T, options: HarnessOptions): T {
  if (configuration.harness === 'opencode') throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
  if (configuration.harness !== options.harness) throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The model catalog belongs to another harness.', 409)
  const model = latestNativeModel(options)
  if (configuration.harness === 'codex') {
    const effort = model.reasoningEfforts.includes('medium') ? 'medium' : model.reasoningEfforts.find(value => AgentEffortSchema.safeParse(value).success)
    if (!effort) throw new DomainError('HARNESS_EFFORT_UNAVAILABLE', 'The native default model has no supported reasoning effort.', 409)
    return { ...configuration, model: model.id, reasoningEffort: AgentEffortSchema.parse(effort),
      serviceTier: model.serviceTiers.includes(configuration.serviceTier) ? configuration.serviceTier : 'standard' } as T
  }
  return { ...configuration, model: model.id, effort: model.reasoningEfforts.includes('medium') ? 'medium'
    : model.reasoningEfforts.find(effort => ClaudeEffortSchema.safeParse(effort).success) } as T
}
