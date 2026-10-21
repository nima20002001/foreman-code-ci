import type { HarnessOptions } from '@foreman-code/contracts/management'
import { RETIRED_OPENCODE_MESSAGE, unavailableSessionControls, type HarnessConfiguration, type SessionControlCapabilities } from '@foreman-code/contracts'

/** Preferences for a not-yet-created native session are desired, never applied. */
export interface ChatModelCatalog {
  modelOptions?(configuration: HarnessConfiguration): Promise<HarnessOptions['models']>
}

export function pendingSessionControls(configuration: HarnessConfiguration,
  models: HarnessOptions['models'] = []): SessionControlCapabilities {
  if (configuration.harness === 'opencode') return unavailableSessionControls(
    `${configuration.harness}:${configuration.model}`, RETIRED_OPENCODE_MESSAGE)
  const controls = unavailableSessionControls(`${configuration.harness}:${configuration.model}`,
    'Native settings will be checked when the first session is admitted.')
  return { ...controls, model: configuration.model,
    modelCapacity: models.find(model => model.id === configuration.model)?.contextWindow ?? null,
    compact: { supported: true, reason: 'There is no native context to compact until the first message.' },
    plan: { supported: true, reason: 'Plan applies to the first native message; no model turn is created by this selection.' },
    autoCompact: { supported: configuration.harness === 'claude', reason: configuration.harness === 'claude'
      ? 'Applies when the owned SDK query starts.' : 'This harness has no automatic-compaction toggle.' },
    autoCompactBudget: { supported: configuration.harness === 'claude', reason: configuration.harness === 'claude'
      ? 'Native startup validates the token budget against its model window.' : 'This harness has no supported automatic budget control.' },
  }
}
