import { ExecutionReadinessSchema, type ExecutionReadiness } from '@foreman-code/contracts/management'
import type { AgentHarness } from '@foreman-code/contracts'
import { apiClient } from '../../shared/api/client'

export function getExecutionReadiness(harness: AgentHarness, signal?: AbortSignal,
  scope: ExecutionReadiness['scope'] = 'saved-harness-defaults', configurationVersionId?: string) {
  const query = new URLSearchParams({ scope, ...(configurationVersionId ? { configurationVersionId } : {}) })
  const response = ExecutionReadinessSchema.refine(value => value.harness === harness && value.scope === scope
    && (!configurationVersionId || value.configurationVersionId === configurationVersionId), {
    message: 'Execution readiness does not match the selected configuration.',
  })
  return apiClient.request(`/api/management/harnesses/${harness}/execution-readiness?${query}`, response, { signal })
}
