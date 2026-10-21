import { setTimeout as delay } from 'node:timers/promises'
import type { CodexHarnessConfiguration, HarnessQualification } from '@foreman-code/contracts'

import { HarnessExecutionError } from './errors.js'
import { isObject } from './codexStdioTransport.js'
import { readNativeCodexModelCatalog, type CodexModelInspection } from './codexModelCatalog.js'
import { qualifyCodex } from './codexProtocol.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'

async function readCatalogWithRetry(
  inspection: CodexModelInspection,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  recovery?: NativeProcessRecovery,
) {
  for (let attempt = 1; ; attempt += 1) {
    signal?.throwIfAborted()
    try {
      return await readNativeCodexModelCatalog(inspection, workingDirectory, environment, signal, recovery)
    } catch (error) {
      signal?.throwIfAborted()
      if (attempt >= 3 || !(error instanceof HarnessExecutionError)
        || error.result.error?.code !== 'CODEX_MODEL_CATALOG_UNAVAILABLE') throw error
      await delay(250 * attempt, undefined, { signal })
    }
  }
}

/** Model-free inspection shared by app-server admission and configuration checks. */
export async function qualifyNativeCodexModel(
  configuration: CodexHarnessConfiguration,
  binary: string,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  recovery?: NativeProcessRecovery,
  inspection?: CodexModelInspection,
): Promise<{ contextWindow: number | null; modelCatalogSource?: HarnessQualification['modelCatalogSource'] } | void> {
  const qualified = inspection?.qualified
    ?? await qualifyCodex(binary, workingDirectory, environment, true, signal, recovery)
  const { models, modelCatalogSource } = await readCatalogWithRetry({ ...inspection, qualified },
    workingDirectory, environment, signal, recovery)
  const model = models.find((entry) => entry.slug === configuration.model)
  if (!model) throw new HarnessExecutionError('CODEX_MODEL_UNAVAILABLE',
    `Codex ${qualified.providerVersion} does not advertise the accepted model in its model/list catalog.`)
  const efforts = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels.filter(isObject) : []
  const tiers = Array.isArray(model.additional_speed_tiers) && model.additional_speed_tiers.every((tier) => typeof tier === 'string')
    ? model.additional_speed_tiers : []
  if (!efforts.some((effort) => effort.effort === configuration.reasoningEffort)
    || (configuration.serviceTier === 'priority' && !tiers.includes('fast'))) {
    throw new HarnessExecutionError('CODEX_SETTING_UNSUPPORTED',
      `Codex ${qualified.providerVersion} model/list does not advertise the requested reasoning effort or service tier.`)
  }
  const contextWindow = typeof model.context_window === 'number' && model.context_window > 0
    ? model.context_window : null
  return { contextWindow, ...(modelCatalogSource === 'cached' ? { modelCatalogSource } : {}) }
}
